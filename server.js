import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

const DATA_FILE = path.join(__dirname, "mcp-config.json");
const SETTINGS_FILE = path.join(__dirname, "mcp-settings.json");

const mcpServers = new Map();
const mcpToolRegistry = new Map();
let enabledModels = new Set();

const upstreamChannels = [];
let activeChannelId = "";

let loggingEnabled = true;
const MAX_LOGS = 1000;
const debugLogs = [];

function addDebugLog(type, summary, detail = "") {
  if (!loggingEnabled) return;
  const now = new Date();
  const time =
    now.toLocaleTimeString("zh-CN", { hour12: false }) +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time,
    type,
    summary,
    detail: typeof detail === "object" ? JSON.stringify(detail, null, 2) : String(detail)
  };
  debugLogs.push(entry);
  if (debugLogs.length > MAX_LOGS) {
    debugLogs.shift();
  }
}

let dbPool = null;
if (DATABASE_URL) {
  const isSslDisabled = DATABASE_URL.includes("sslmode=disable");
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isSslDisabled ? false : { rejectUnauthorized: false }
  });
  dbPool.on("error", (err) => {
    addDebugLog("ERROR", `数据库连接异常: ${err.message}`, err);
  });
}

async function initDatabase() {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS mcp_storage (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    addDebugLog("ERROR", `数据库初始化失败: ${err.message}`, err);
  }
}

async function getStorageItem(key) {
  if (!dbPool) return null;
  try {
    const res = await dbPool.query("SELECT value FROM mcp_storage WHERE key = $1", [key]);
    if (res.rows.length > 0) {
      return JSON.parse(res.rows[0].value);
    }
  } catch (err) {
    addDebugLog("ERROR", `读取数据库项失败: ${err.message}`, err);
  }
  return null;
}

async function setStorageItem(key, val) {
  if (!dbPool) return;
  try {
    const jsonStr = JSON.stringify(val);
    await dbPool.query(
      `INSERT INTO mcp_storage (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, jsonStr]
    );
  } catch (err) {
    addDebugLog("ERROR", `写入数据库项失败: ${err.message}`, err);
  }
}

const chineseNums = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function getGroupDefaultName(index) {
  const num = index + 1;
  if (num <= 10) return `第${chineseNums[index]}组`;
  return `第${num}组`;
}

function maskApiKey(key) {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

function parseSingleChannelValue(rawVal, defaultName, id, envKey) {
  if (!rawVal || typeof rawVal !== "string") return null;
  const trimmed = rawVal.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      const baseUrl = String(obj.url || obj.baseUrl || obj.base_url || "").trim().replace(/\/+$/, "");
      const rawKey = String(obj.key || obj.apiKey || obj.api_key || obj.token || "").trim();
      const apiKey = rawKey.replace(/^Bearer\s+/i, "").trim();
      const name = String(obj.name || obj.label || defaultName).trim();
      if (baseUrl && apiKey) {
        return { id, name, envKey, baseUrl, apiKey };
      }
    } catch {}
  }

  let parts = [];
  if (trimmed.includes("|")) {
    parts = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  } else if (trimmed.includes(",")) {
    parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    parts = trimmed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }

  if (parts.length < 2) return null;

  const urlIndex = parts.findIndex((p) => /^https?:\/\//i.test(p));
  if (urlIndex === -1) return null;

  const baseUrl = parts[urlIndex].replace(/\/+$/, "");
  let name = defaultName;
  let rawKey = "";

  if (parts.length === 2) {
    rawKey = parts[urlIndex === 0 ? 1 : 0];
  } else if (urlIndex === 0) {
    rawKey = parts[1];
    name = parts.slice(2).join(" ") || defaultName;
  } else if (urlIndex === 1) {
    name = parts[0] || defaultName;
    rawKey = parts.slice(2).join(" ");
  } else {
    name = parts[0] || defaultName;
    rawKey = parts[urlIndex + 1] || parts[1];
  }

  const apiKey = rawKey.replace(/^Bearer\s+/i, "").trim();
  if (!baseUrl || !apiKey) return null;
  return { id, name, envKey, baseUrl, apiKey };
}

function loadUpstreamChannelsFromEnv() {
  upstreamChannels.length = 0;
  const envKeys = Object.keys(process.env);
  const reservedKeys = new Set([
    "UPSTREAM_BASE_URL",
    "UPSTREAM_API_KEY",
    "PROXY_API_KEY",
    "PANEL_PASSWORD",
    "PORT",
    "NODE_ENV",
    "DATABASE_URL"
  ]);

  const groupKeys = envKeys
    .filter((k) => {
      const upper = k.toUpperCase();
      if (reservedKeys.has(upper)) return false;
      if (/^UPSTREAM_BASE_URL_/i.test(upper) || /^UPSTREAM_API_KEY_/i.test(upper)) return false;
      return /^(?:UPSTREAM|OPENAI|CHANNEL|GROUP)(?:_[A-Z0-9]+|\d+)$/i.test(upper);
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  for (const key of groupKeys) {
    const val = process.env[key];
    const index = upstreamChannels.length;
    const defaultName = getGroupDefaultName(index);
    const id = `ch_${key.toLowerCase()}`;
    const parsed = parseSingleChannelValue(val, defaultName, id, key);
    if (parsed) {
      upstreamChannels.push(parsed);
    }
  }

  const pairedUrlKeys = envKeys
    .filter((k) => /^UPSTREAM_BASE_URL_([A-Z0-9]+)$/i.test(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  for (const urlKey of pairedUrlKeys) {
    const suffix = urlKey.replace(/^UPSTREAM_BASE_URL_/i, "");
    const keyVarName = `UPSTREAM_API_KEY_${suffix}`;
    const rawUrl = (process.env[urlKey] || "").trim().replace(/\/+$/, "");
    const rawKey = (process.env[keyVarName] || "").trim().replace(/^Bearer\s+/i, "").trim();
    if (rawUrl && rawKey) {
      const index = upstreamChannels.length;
      upstreamChannels.push({
        id: `ch_pair_${suffix.toLowerCase()}`,
        name: getGroupDefaultName(index),
        envKey: urlKey,
        baseUrl: rawUrl,
        apiKey: rawKey
      });
    }
  }

  const legacyBaseUrl = (process.env.UPSTREAM_BASE_URL || "").trim();
  const legacyApiKey = (process.env.UPSTREAM_API_KEY || "").trim().replace(/^Bearer\s+/i, "").trim();

  if (legacyBaseUrl) {
    const index = upstreamChannels.length;
    const combinedParsed = parseSingleChannelValue(
      legacyBaseUrl,
      getGroupDefaultName(index),
      "ch_legacy",
      "UPSTREAM_BASE_URL"
    );
    if (combinedParsed) {
      const exists = upstreamChannels.some(
        (c) => c.baseUrl === combinedParsed.baseUrl && c.apiKey === combinedParsed.apiKey
      );
      if (!exists) {
        upstreamChannels.push(combinedParsed);
      }
    } else if (legacyApiKey) {
      const cleanUrl = legacyBaseUrl.replace(/\/+$/, "");
      const exists = upstreamChannels.some(
        (c) => c.baseUrl === cleanUrl && c.apiKey === legacyApiKey
      );
      if (!exists) {
        upstreamChannels.push({
          id: "ch_legacy",
          name: getGroupDefaultName(index),
          envKey: "UPSTREAM_BASE_URL",
          baseUrl: cleanUrl,
          apiKey: legacyApiKey
        });
      }
    }
  }

  if (upstreamChannels.length > 0) {
    if (!activeChannelId || !upstreamChannels.some((c) => c.id === activeChannelId)) {
      activeChannelId = upstreamChannels[0].id;
    }
  } else {
    activeChannelId = "";
  }
}

function getActiveChannel() {
  if (upstreamChannels.length === 0) return null;
  if (activeChannelId) {
    const found = upstreamChannels.find((c) => c.id === activeChannelId);
    if (found) return found;
  }
  activeChannelId = upstreamChannels[0].id;
  return upstreamChannels[0];
}

const SESSION_SECRET = PANEL_PASSWORD
  ? crypto.createHash("sha256").update(`mcp-proxy-session:${PANEL_PASSWORD}`).digest("hex")
  : crypto.randomBytes(32).toString("hex");

function generateSessionToken() {
  const payload = `auth:${PANEL_PASSWORD}:${Date.now()}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function verifySessionToken(token) {
  if (!PANEL_PASSWORD) return true;
  if (!token) return false;
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split(":");
    if (parts.length !== 4 || parts[0] !== "auth" || parts[1] !== PANEL_PASSWORD) return false;
    const payload = `${parts[0]}:${parts[1]}:${parts[2]}`;
    const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
    return sig === parts[3];
  } catch {
    return false;
  }
}

function parseCookies(request) {
  const list = {};
  const rc = request.headers.cookie;
  if (rc) {
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      list[parts.shift().trim()] = decodeURI(parts.join("="));
    });
  }
  return list;
}

async function saveSettingsToStorage() {
  const data = {
    loggingEnabled,
    enabledModels: Array.from(enabledModels),
    activeChannelId
  };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
  if (dbPool) {
    await setStorageItem("settings", data);
  }
}

async function saveLoggingConfigToStorage(enabled) {
  loggingEnabled = enabled;
  await saveSettingsToStorage();
}

async function saveEnabledModelsToStorage(modelsArray) {
  enabledModels = new Set(modelsArray);
  await saveSettingsToStorage();
}

async function saveActiveChannelToStorage(channelId) {
  activeChannelId = channelId;
  await saveSettingsToStorage();
}

async function loadSettingsFromStorage() {
  let data = null;
  if (dbPool) {
    data = await getStorageItem("settings");
  }
  if (!data && fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
      data = JSON.parse(raw);
      if (dbPool && data) {
        await setStorageItem("settings", data);
      }
    } catch {}
  }
  if (data && typeof data === "object") {
    if (Array.isArray(data.enabledModels)) {
      enabledModels = new Set(data.enabledModels);
    }
    if (data.loggingEnabled !== undefined) {
      loggingEnabled = data.loggingEnabled === true;
    }
    if (typeof data.activeChannelId === "string" && data.activeChannelId) {
      if (upstreamChannels.some((c) => c.id === data.activeChannelId)) {
        activeChannelId = data.activeChannelId;
      }
    }
  }
}

async function saveServerToStorage() {
  const data = Array.from(mcpServers.values());
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
  if (dbPool) {
    await setStorageItem("servers", data);
  }
}

async function deleteServerFromStorage() {
  const data = Array.from(mcpServers.values());
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
  if (dbPool) {
    await setStorageItem("servers", data);
  }
}

async function loadConfigFromStorage() {
  let list = null;
  if (dbPool) {
    list = await getStorageItem("servers");
  }
  if (!list && fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      list = JSON.parse(raw);
      if (dbPool && list) {
        await setStorageItem("servers", list);
      }
    } catch {}
  }
  if (Array.isArray(list)) {
    for (const item of list) {
      const status = item.status || "active";
      item.status = status;
      for (const t of item.tools || []) {
        t.enabled = typeof t.enabled === "boolean" ? t.enabled : true;
        t.status = t.status || "unchecked";
        t.statusMessage = t.statusMessage || "";
      }
      mcpServers.set(item.id, item);
      registerVirtualTools(item);
      if (status === "active") {
        for (const t of item.tools || []) {
          if (t.enabled !== false && !t.isVirtual) {
            mcpToolRegistry.set(t.key, {
              serverId: item.id,
              serverName: item.name,
              rawName: t.rawName,
              postEndpoint: item.postEndpoint,
              headers: item.headers
            });
          }
        }
      }
    }
  }
}

function setCorsHeaders(response) {
  if (response.headersSent) return;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
}

function sendJson(response, statusCode, body) {
  if (response.headersSent) return;
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendOpenAIError(response, statusCode, message, type = "invalid_request_error", extraInfo = {}) {
  addDebugLog("ERROR", `返回客户端错误 (${statusCode}): ${message}`, { statusCode, message, type, ...extraInfo });
  sendJson(response, statusCode, { error: { message, type, code: null } });
}

function isProxyAuthorized(request) {
  if (!PROXY_API_KEY) return true;
  const reqUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const queryKey = reqUrl.searchParams.get("key") || "";
  if (queryKey && queryKey === PROXY_API_KEY) return true;

  const headerKey = request.headers["x-goog-api-key"] || "";
  if (headerKey && headerKey.trim() === PROXY_API_KEY) return true;

  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : authorization.trim();
  return token === PROXY_API_KEY;
}

function isPanelAuthorized(request) {
  if (!PANEL_PASSWORD) return true;
  const cookies = parseCookies(request);
  if (verifySessionToken(cookies.panel_auth)) return true;
  const headerToken = (request.headers["x-panel-password"] || "").trim();
  return headerToken === PANEL_PASSWORD;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        reject(new Error("请求过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("无效 JSON"));
      }
    });
    request.on("error", reject);
  });
}

async function parseMcpResponse(res) {
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        try {
          return JSON.parse(trimmed.slice(5).trim());
        } catch {}
      }
    }
  }
  return await res.json();
}

async function connectToMcpServer({ name, url, token }) {
  const serverId = crypto.randomUUID();
  const cleanUrl = url.trim().replace(/\/+$/, "");
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "mcp-agent-proxy/1.0.0"
  };

  if (token) {
    const rawToken = token.trim();
    headers["Authorization"] = rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`;
  }

  const initPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-agent-proxy", version: "1.0.0" }
    }
  };

  try {
    await fetch(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(initPayload),
      signal: AbortSignal.timeout(20000)
    });

    await fetch(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }),
      signal: AbortSignal.timeout(20000)
    }).catch(() => {});
  } catch {}

  const listPayload = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const listRes = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(20000)
  });

  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`MCP 响应错误 (${listRes.status}): ${err.slice(0, 300)}`);
  }

  const listData = await parseMcpResponse(listRes);
  if (listData.error) {
    throw new Error(listData.error.message || JSON.stringify(listData.error));
  }
  const rawTools = listData.result?.tools || [];

  if (rawTools.length === 0) {
    throw new Error("该 MCP 未返回任何工具，请检查 Token 权限或服务地址。");
  }

  const registeredTools = [];
  for (const t of rawTools) {
    const safePrefix = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const sanitizedToolName = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const toolKey = sanitizedToolName.startsWith(`${safePrefix}_`)
      ? sanitizedToolName
      : `${safePrefix}_${sanitizedToolName}`;

    registeredTools.push({
      key: toolKey,
      rawName: t.name,
      description: t.description || t.name,
      enabled: true,
      status: "unchecked",
      statusMessage: "",
      openAiTool: {
        type: "function",
        function: {
          name: toolKey,
          description: `[${name}] ${t.description || t.name}`,
          parameters: t.inputSchema || { type: "object", properties: {} }
        }
      }
    });

    mcpToolRegistry.set(toolKey, {
      serverId,
      serverName: name,
      rawName: t.name,
      postEndpoint: cleanUrl,
      headers
    });
  }

  const serverInfo = {
    id: serverId,
    name,
    url: cleanUrl,
    rawToken: token,
    status: "active",
    postEndpoint: cleanUrl,
    headers,
    toolCount: registeredTools.length,
    tools: registeredTools
  };

  registerVirtualTools(serverInfo);
  mcpServers.set(serverId, serverInfo);
  await saveServerToStorage();
  addDebugLog("TOOL", `成功挂载 MCP 服务: ${name}`, { serverId, url: cleanUrl, toolCount: serverInfo.tools.length });
  return serverInfo;
}

function extractMcpResultContent(data) {
  if (!data) return "{}";
  let contentStr = "";

  const rawResult = data.result !== undefined ? data.result : data;
  if (!rawResult) return "{}";

  if (Array.isArray(rawResult.content)) {
    const pieces = [];
    for (const item of rawResult.content) {
      if (!item) continue;
      if (item.type === "text" && item.text) {
        pieces.push(item.text);
      } else if ((item.type === "resource" || item.type === "embedded_resource") && item.resource) {
        if (item.resource.text) {
          pieces.push(item.resource.text);
        } else if (item.resource.blob) {
          try {
            const decoded = Buffer.from(item.resource.blob, "base64").toString("utf8");
            pieces.push(decoded);
          } catch {
            pieces.push(item.resource.blob);
          }
        }
      } else if (item.text) {
        pieces.push(item.text);
      }
    }
    if (pieces.length > 0) {
      contentStr = pieces.join("\n\n");
    }
  }

  if (!contentStr && rawResult.content && rawResult.encoding === "base64" && typeof rawResult.content === "string") {
    try {
      contentStr = Buffer.from(rawResult.content, "base64").toString("utf8");
    } catch {}
  }

  if (!contentStr) {
    contentStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult, null, 2);
  }

  return contentStr;
}

function extractErrorMessage(text) {
  if (!text) return "";
  if (typeof text === "object") {
    if (typeof text.error === "string") return text.error;
    if (text.error?.message) return text.error.message;
    if (typeof text.message === "string") return text.message;
    return JSON.stringify(text).slice(0, 200);
  }
  let str = String(text).trim();
  str = str.replace(/^(?:执行失败\s*[:：]?\s*)+/i, "");
  try {
    const parsed = JSON.parse(str);
    return extractErrorMessage(parsed);
  } catch {}
  const jsonMatch = str.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const inner = parsed.error?.message || parsed.message || parsed.error;
      if (typeof inner === "string") {
        const prefix = str.slice(0, jsonMatch.index).replace(/^(?:执行失败\s*[:：]?\s*)+/i, "").trim();
        return prefix ? `${prefix} ${inner}` : inner;
      }
    } catch {}
  }
  const singleLine = str.replace(/[\r\n\t]+/g, " ").trim();
  return singleLine.length > 200 ? `${singleLine.slice(0, 200)}...` : singleLine;
}

function parseRateLimitWaitSeconds(errorText) {
  if (!errorText || typeof errorText !== "string") return 0;
  const match =
    errorText.match(/retry after\s+(\d+)\s*s/i) ||
    errorText.match(/retry after\s+(\d+)\s*seconds?/i) ||
    errorText.match(/wait\s+(\d+)\s*s/i) ||
    errorText.match(/wait\s+(\d+)\s*seconds?/i);
  if (match) {
    const sec = parseInt(match[1], 10);
    if (!isNaN(sec) && sec > 0 && sec <= 120) {
      return sec;
    }
  }
  if (/rate limit exceeded|secondary rate limit|too many requests/i.test(errorText)) {
    return 35;
  }
  return 0;
}

async function invokeMcpRawTool(serverInfo, rawName, args, onWaitNotice = null) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let res;
    try {
      res = await fetch(serverInfo.postEndpoint, {
        method: "POST",
        headers: serverInfo.headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: rawName, arguments: args }
        }),
        signal: AbortSignal.timeout(35000)
      });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (!res.ok) {
      const txt = await res.text();
      const waitSec = parseRateLimitWaitSeconds(txt);
      if (waitSec > 0 && attempt < maxRetries) {
        if (typeof onWaitNotice === "function") {
          onWaitNotice(waitSec);
        }
        addDebugLog("TOOL", `[频控保护] 接口调用触发限制，正在等待 ${waitSec + 1} 秒后自动重试...`);
        await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
        continue;
      }
      throw new Error(`MCP HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const data = await parseMcpResponse(res);
    if (data.error) {
      const errMsg = data.error.message || JSON.stringify(data.error);
      const waitSec = parseRateLimitWaitSeconds(errMsg);
      if (waitSec > 0 && attempt < maxRetries) {
        if (typeof onWaitNotice === "function") {
          onWaitNotice(waitSec);
        }
        addDebugLog("TOOL", `[频控保护] 接口调用触发限制，正在等待 ${waitSec + 1} 秒后自动重试...`);
        await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
        continue;
      }
      throw new Error(errMsg);
    }

    const rawResult = data.result !== undefined ? data.result : data;
    const isToolError = Boolean(rawResult && (rawResult.isError === true || rawResult.is_error === true));
    const textContent = extractMcpResultContent(data);

    if (isToolError) {
      const waitSec = parseRateLimitWaitSeconds(textContent);
      if (waitSec > 0 && attempt < maxRetries) {
        if (typeof onWaitNotice === "function") {
          onWaitNotice(waitSec);
        }
        addDebugLog("TOOL", `[频控保护] 工具返回频率限制错误，正在等待 ${waitSec + 1} 秒后自动重试...`);
        await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
        continue;
      }
    }

    return { data, rawResult, isToolError, textContent };
  }
}

function extractFileContentAndSha(mcpRes) {
  const { rawResult, textContent } = mcpRes;
  let fileContent = "";
  let fileSha = "";

  if (rawResult && Array.isArray(rawResult.content)) {
    for (const item of rawResult.content) {
      if (!item) continue;
      if (item.type === "text" && item.text) {
        const shaMatch = item.text.match(/SHA:\s*([0-9a-f]{40})/i);
        if (shaMatch) {
          fileSha = shaMatch[1];
        }
      }
      if ((item.type === "resource" || item.type === "embedded_resource") && item.resource) {
        if (typeof item.resource.text === "string") {
          fileContent = item.resource.text;
        } else if (item.resource.blob) {
          try {
            fileContent = Buffer.from(item.resource.blob, "base64").toString("utf8");
          } catch {
            fileContent = item.resource.blob;
          }
        }
      }
    }
  }

  if (!fileContent && textContent) {
    const shaMatch = textContent.match(/SHA:\s*([0-9a-f]{40})/i);
    if (shaMatch && !fileSha) {
      fileSha = shaMatch[1];
    }
    fileContent = textContent.replace(/^successfully downloaded[^\n]*\r?\n+/, "");
  }

  if (!fileSha && textContent) {
    const firstLine = textContent.split("\n")[0] || "";
    const shaMatch = firstLine.match(/\b([0-9a-f]{40})\b/i);
    if (shaMatch) {
      fileSha = shaMatch[1];
    }
  }

  return { fileContent, fileSha };
}

function applyStringReplacements(content, edits, filePath = "") {
  let updated = content;
  for (let i = 0; i < edits.length; i += 1) {
    const { old_str, new_str } = edits[i];
    if (typeof old_str !== "string" || typeof new_str !== "string") {
      throw new Error(`第 ${i + 1} 处修改参数错误：old_str 与 new_str 必须为字符串`);
    }
    if (old_str === new_str) {
      throw new Error(`第 ${i + 1} 处修改无效：old_str 与 new_str 完全相同`);
    }

    let targetStr = old_str;
    let idx = updated.indexOf(targetStr);

    if (idx === -1) {
      if (updated.includes("\r\n") && !targetStr.includes("\r\n")) {
        const crlfTarget = targetStr.replace(/\n/g, "\r\n");
        if (updated.includes(crlfTarget)) {
          targetStr = crlfTarget;
          idx = updated.indexOf(targetStr);
        }
      } else if (!updated.includes("\r\n") && targetStr.includes("\r\n")) {
        const lfTarget = targetStr.replace(/\r\n/g, "\n");
        if (updated.includes(lfTarget)) {
          targetStr = lfTarget;
          idx = updated.indexOf(targetStr);
        }
      }
    }

    if (idx === -1) {
      const trimmedOld = targetStr.trim();
      if (trimmedOld && updated.includes(trimmedOld)) {
        const occurrences = updated.split(trimmedOld).length - 1;
        if (occurrences === 1) {
          targetStr = trimmedOld;
          idx = updated.indexOf(targetStr);
        }
      }
    }

    if (idx === -1) {
      throw new Error(`在文件 ${filePath} 中未找到指定的待替换片段 (old_str)。请核对代码内容、空格缩进及换行是否准确。待查找片段预览:\n${old_str.slice(0, 200)}`);
    }

    const count = updated.split(targetStr).length - 1;
    if (count > 1) {
      throw new Error(`在文件 ${filePath} 中找到多处 (${count} 处) 完全相同的待替换片段。为防止误替换，请在 old_str 中包含更多上下文代码行以确保唯一性。`);
    }

    let replacement = new_str;
    if (targetStr.includes("\r\n") && !replacement.includes("\r\n")) {
      replacement = replacement.replace(/\n/g, "\r\n");
    } else if (!targetStr.includes("\r\n") && replacement.includes("\r\n")) {
      replacement = replacement.replace(/\r\n/g, "\n");
    }

    updated = updated.slice(0, idx) + replacement + updated.slice(idx + targetStr.length);
  }
  return updated;
}

async function executeGithubEditFile(serverInfo, readToolRawName, writeToolRawName, args, onWaitNotice = null) {
  const { owner, repo, path: filePath, old_str, new_str, edits, message, branch } = args || {};

  if (!owner || !repo || !filePath) {
    throw new Error("缺少必需参数：owner, repo, path");
  }

  let editList = [];
  if (Array.isArray(edits) && edits.length > 0) {
    editList = edits;
  } else if (typeof old_str === "string" && typeof new_str === "string") {
    editList = [{ old_str, new_str }];
  } else {
    throw new Error("必须提供 old_str 与 new_str，或 edits 数组");
  }

  const getArgs = { owner, repo, path: filePath };
  if (branch) {
    getArgs.ref = branch;
  }

  addDebugLog("TOOL", `[局部编辑] 读取文件: ${owner}/${repo}/${filePath} (分支: ${branch || "默认"})`);
  const getRes = await invokeMcpRawTool(serverInfo, readToolRawName, getArgs, onWaitNotice);
  if (getRes.isToolError) {
    throw new Error(`读取文件失败: ${getRes.textContent.slice(0, 300)}`);
  }

  const { fileContent, fileSha } = extractFileContentAndSha(getRes);
  if (!fileSha) {
    throw new Error(`未能获取到文件 SHA，请确认文件是否存在: ${filePath}`);
  }

  const updatedContent = applyStringReplacements(fileContent, editList, filePath);

  if (updatedContent === fileContent) {
    throw new Error("替换前后文件内容未发生任何改变");
  }

  const commitMsg = (message || "").trim() || `Update ${filePath}`;
  const putArgs = {
    owner,
    repo,
    path: filePath,
    content: updatedContent,
    message: commitMsg,
    sha: fileSha,
    branch: branch || "main"
  };

  addDebugLog("TOOL", `[局部编辑] 提交更新到 GitHub: ${owner}/${repo}/${filePath} (SHA: ${fileSha})`);
  const putRes = await invokeMcpRawTool(serverInfo, writeToolRawName, putArgs, onWaitNotice);
  if (putRes.isToolError) {
    throw new Error(`提交更新失败: ${putRes.textContent.slice(0, 300)}`);
  }

  return {
    isError: false,
    content: `局部修改成功并已提交到 GitHub。仓库: ${owner}/${repo}，文件: ${filePath}，分支: ${branch || "main"}，修改处数: ${editList.length}，原文件 SHA: ${fileSha}`
  };
}

function findServerTool(serverInfo, targetNames) {
  if (!Array.isArray(serverInfo.tools)) return null;
  return serverInfo.tools.find((t) =>
    targetNames.some((n) => t.rawName === n || t.rawName.endsWith(`_${n}`))
  );
}

function registerVirtualTools(serverInfo) {
  if (!serverInfo || !Array.isArray(serverInfo.tools)) return;
  const readTool = findServerTool(serverInfo, ["get_file_contents"]);
  const writeTool = findServerTool(serverInfo, ["create_or_update_file"]);
  if (!readTool || !writeTool) return;

  const serverNameLower = (serverInfo.name || "").toLowerCase();
  const safePrefix = serverNameLower.replace(/[^a-z0-9_]/g, "_");
  const virtualRawName = readTool.rawName.startsWith("github_") || serverNameLower.includes("github")
    ? "github_edit_file"
    : "edit_file";

  const toolKey = virtualRawName.startsWith(`${safePrefix}_`)
    ? virtualRawName
    : `${safePrefix}_${virtualRawName}`;

  let virtualTool = serverInfo.tools.find((t) => t.key === toolKey || t.rawName === virtualRawName);
  if (!virtualTool) {
    virtualTool = {
      key: toolKey,
      rawName: virtualRawName,
      description: `[${serverInfo.name}] 局部编辑 GitHub 文件`,
      enabled: true,
      status: "supported",
      statusMessage: "支持",
      isVirtual: true,
      openAiTool: {
        type: "function",
        function: {
          name: toolKey,
          description: `[${serverInfo.name}] 局部编辑 GitHub 仓库中的指定文件。通过比对替换指定的代码片段（old_str -> new_str），自动拉取最新文件、完成局部替换并提交更新，无需全量读取或全量重写。`,
          parameters: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "仓库所有者 (用户名或组织名)"
              },
              repo: {
                type: "string",
                description: "仓库名称"
              },
              path: {
                type: "string",
                description: "要修改的文件路径"
              },
              old_str: {
                type: "string",
                description: "待替换的原始代码片段。必须在文件中唯一存在，建议包含周围几行上下文以确保唯一性。"
              },
              new_str: {
                type: "string",
                description: "替换后的新代码片段。"
              },
              edits: {
                type: "array",
                description: "可选的多处同时替换列表。每项包含 old_str 与 new_str。若提供此项则按顺序批量替换。",
                items: {
                  type: "object",
                  properties: {
                    old_str: { type: "string", description: "待替换的代码片段" },
                    new_str: { type: "string", description: "替换后的新代码片段" }
                  },
                  required: ["old_str", "new_str"]
                }
              },
              message: {
                type: "string",
                description: "Git 提交说明"
              },
              branch: {
                type: "string",
                description: "目标分支名称 (可选，默认使用仓库默认分支)"
              }
            },
            required: ["owner", "repo", "path", "message"]
          }
        }
      }
    };
    serverInfo.tools.unshift(virtualTool);
    serverInfo.toolCount = serverInfo.tools.length;
  } else {
    virtualTool.isVirtual = true;
    virtualTool.status = "supported";
    virtualTool.statusMessage = "支持";
  }

  if (serverInfo.status === "active" && virtualTool.enabled !== false) {
    mcpToolRegistry.set(toolKey, {
      serverId: serverInfo.id,
      serverName: serverInfo.name,
      rawName: virtualRawName,
      isVirtual: true,
      handler: async (args, onWaitNotice) => {
        return await executeGithubEditFile(serverInfo, readTool.rawName, writeTool.rawName, args, onWaitNotice);
      }
    });
  }
}

async function callMcpTool(toolKey, args, onWaitNotice = null) {
  let info = mcpToolRegistry.get(toolKey);
  if (!info) {
    for (const [k, v] of mcpToolRegistry.entries()) {
      if (k.endsWith(toolKey) || toolKey.endsWith(v.rawName)) {
        info = v;
        break;
      }
    }
  }
  if (!info) throw new Error(`未找到工具：${toolKey}`);

  const isCfExecute =
    (toolKey.toLowerCase().includes("cloudflare") || (info?.serverName || "").toLowerCase().includes("cloudflare")) &&
    (toolKey.endsWith("execute") || info?.rawName === "execute");

  if (isCfExecute && typeof args?.code === "string") {
    const rawCode = args.code;
    if (
      rawCode.includes("DEFAULT_BASE_URL") ||
      /fetch\s*\(\s*[`'"]https?:\/\/api\.cloudflare\.com/i.test(rawCode) ||
      /fetch\s*\(\s*DEFAULT_BASE_URL/i.test(rawCode)
    ) {
      return {
        isError: true,
        content: JSON.stringify({
          error:
            "【Cloudflare execute 规范拦截】检测到代码中试图自行定义 DEFAULT_BASE_URL 或使用原生 fetch 请求 Cloudflare API。沙箱中已内置注入了带有鉴权的全局客户端 `cloudflare.request({ method, path, body })` 与全局变量 `accountId`。直接使用原生 fetch 会因缺少内置鉴权被 Cloudflare 拦截并返回 403 Forbidden（导致 Unexpected token 'F' 报错）。请改用 `return await cloudflare.request({ method: 'GET', path: `/accounts/${accountId}/...` })` 格式。"
        })
      };
    }
  }

  const startTime = Date.now();
  if (typeof info.handler === "function") {
    try {
      const res = await info.handler(args, onWaitNotice);
      const duration = Date.now() - startTime;
      const isError = Boolean(res && res.isError);
      const content = typeof res?.content === "string" ? res.content : JSON.stringify(res || {});
      addDebugLog(isError ? "ERROR" : "TOOL", `虚拟 MCP 工具 [${toolKey}] 执行${isError ? "失败" : "成功"} - 耗时 ${duration}ms`, {
        arguments: args,
        outputPreview: content.slice(0, 500)
      });
      return { isError, content };
    } catch (err) {
      const duration = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      addDebugLog("ERROR", `虚拟 MCP 工具 [${toolKey}] 异常 - 耗时 ${duration}ms`, msg);
      return { isError: true, content: JSON.stringify({ error: msg }) };
    }
  }

  try {
    const { rawResult, isToolError, textContent } = await invokeMcpRawTool(info, info.rawName, args, onWaitNotice);
    const duration = Date.now() - startTime;
    if (isToolError) {
      let refinedContent = textContent;
      if (isCfExecute && (textContent.includes("Unexpected token 'F'") || textContent.includes("Forbidden"))) {
        refinedContent = `${textContent}\n\n【诊断指引】此报错通常是因为在 execute 脚本中使用了原生 fetch 请求 Cloudflare 接口导致被 403 拦截并返回纯文本。请使用沙箱内置的 \`cloudflare.request({ method, path, body })\` 与全局变量 \`accountId\`，严禁在脚本中自拼 URL 或裸调 fetch。`;
      }
      addDebugLog("ERROR", `MCP 工具 [${toolKey}] 返回错误 - 耗时 ${duration}ms`, {
        arguments: args,
        errorOutput: refinedContent.slice(0, 500)
      });
      return { isError: true, content: refinedContent };
    }
    addDebugLog("TOOL", `MCP 工具 [${toolKey}] 执行成功 - 耗时 ${duration}ms, 输出 ${textContent.length} 字符`, {
      arguments: args,
      outputPreview: textContent.slice(0, 500)
    });
    return { isError: false, content: textContent };
  } catch (err) {
    const duration = Date.now() - startTime;
    let msg = err instanceof Error ? err.message : String(err);
    if (isCfExecute && (msg.includes("Unexpected token 'F'") || msg.includes("Forbidden"))) {
      msg = `${msg} (诊断指引: 请使用沙箱内置的 cloudflare.request 与 accountId，严禁使用原生 fetch 或自拼 DEFAULT_BASE_URL)`;
    }
    addDebugLog("ERROR", `MCP 工具 [${toolKey}] 异常 - 耗时 ${duration}ms`, msg);
    throw (err instanceof Error ? new Error(msg) : new Error(String(msg)));
  }
}

function getAllTools() {
  const tools = [];
  for (const s of mcpServers.values()) {
    if (s.status === "active") {
      for (const t of s.tools) {
        if (t.enabled !== false) {
          tools.push(t.openAiTool);
        }
      }
    }
  }
  return tools;
}

function isTitleGenerationRequest(userText) {
  if (!userText || typeof userText !== "string") return false;
  return (
    /give this conversation a name/i.test(userText) ||
    /based on the chat history,\s*give this conversation/i.test(userText) ||
    /generate a (?:short )?title for this conversation/i.test(userText)
  );
}

function detectActionIntent(userText) {
  if (!userText || typeof userText !== "string") {
    return { needsTool: false, isWrite: false };
  }
  const text = userText.trim();
  if (isTitleGenerationRequest(text)) {
    return { needsTool: false, isWrite: false };
  }

  const isConsultation =
    /^(?:为什么|为啥|为何|请问|帮我看下为什么|分析|排查原因|查下原因|怎么回事|怎么会|why|how|what)/i.test(text) ||
    /(?:为什么|为啥|为何|怎么回事|正常吗)[？?\s]*$/i.test(text);
  if (isConsultation && !/(?:帮我|直接|请|现在).*(?:修改|改一下|修复|更新|写入|提交|替换)/i.test(text)) {
    return { needsTool: false, isWrite: false };
  }

  const writeVerb = /(修改|修改下|改下|改一下|修一下|修复|更新|更新下|添加|增加|加一个|删除|删掉|重写|创建|新建|写入|覆盖|替换|调整|优化|补齐|同步|把.+改成|提交|推送|commit|push|write|update|create|delete|edit)/i;
  const writeTarget = /(代码|文件|配置|仓库|bug|接口|函数|样式|组件|依赖|项目|分支|插件|脚本|产物|测试|pr|github|readme|dist|\.[a-z0-9]{1,6})/i;
  const isDirectWrite = writeVerb.test(text) && (writeTarget.test(text) || text.length <= 60);

  const readVerb = /(查看|看一下|读取|获取|搜索|查一下|查找|找一下|列出|分析|检查|排查|看看|读一下|fetch|get|read|search|list)/i;
  const readTarget = /(文件|代码|目录|仓库|分支|提交|日志|报错|错误|问题|原因|commit|pr|issue|内容|log|\.[a-z0-9]{1,6})/i;
  const isDirectRead = readVerb.test(text) && (readTarget.test(text) || text.length <= 60);

  const isWrite = Boolean(isDirectWrite);
  const needsTool = Boolean(isDirectWrite || isDirectRead);
  return { needsTool, isWrite };
}

function selectRelevantTools(userText, allTools) {
  if (!allTools || allTools.length === 0) {
    return [];
  }
  if (!userText || typeof userText !== "string") {
    return allTools;
  }

  const text = userText.toLowerCase();
  const scored = allTools.map((t) => {
    const name = (t.function?.name || "").toLowerCase();
    const desc = (t.function?.description || "").toLowerCase();
    let score = 0;

    const parts = name.split(/[^a-z0-9]+/);
    for (const p of parts) {
      if (p.length >= 3 && text.includes(p)) {
        score += 3;
      }
    }

    if (text.includes("git") || text.includes("github") || text.includes("仓库") || text.includes("提交") || text.includes("push")) {
      if (name.includes("git") || name.includes("push") || name.includes("commit") || name.includes("file") || name.includes("branch")) {
        score += 5;
      }
    }

    if (text.includes("改") || text.includes("写") || text.includes("修") || text.includes("创建") || text.includes("更新") || text.includes("替换")) {
      if (name.includes("write") || name.includes("push") || name.includes("create") || name.includes("update") || name.includes("edit")) {
        score += 5;
      }
    }

    if (text.includes("搜索") || text.includes("查") || text.includes("search")) {
      if (name.includes("search") || desc.includes("search") || desc.includes("搜索")) {
        score += 5;
      }
    }

    return { tool: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.tool);
}

function upstreamChatCompletionsUrl(channel) {
  const active = channel || getActiveChannel();
  if (!active || !active.baseUrl) {
    throw new Error("未配置上游渠道环境变量");
  }
  const base = active.baseUrl;
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function upstreamModelsUrl(channel) {
  const active = channel || getActiveChannel();
  if (!active || !active.baseUrl) {
    throw new Error("未配置上游渠道环境变量");
  }
  const base = active.baseUrl;
  if (base.endsWith("/chat/completions")) {
    return base.replace(/\/chat\/completions$/, "/models");
  }
  if (base.endsWith("/v1")) return `${base}/models`;
  return `${base}/v1/models`;
}

function toolArguments(toolCall) {
  try {
    const raw = toolCall.function?.arguments;
    if (typeof raw === "object" && raw !== null) return raw;
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  } catch {
    return null;
  }
}

function formatToolCallDetails(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];

  if (args.owner && args.repo) {
    parts.push(`仓库: ${args.owner}/${args.repo}`);
  } else if (args.repo) {
    parts.push(`仓库: ${args.repo}`);
  } else if (args.owner) {
    parts.push(`所有者: ${args.owner}`);
  }

  if (args.path) {
    parts.push(`路径: ${args.path}`);
  } else if (args.file || args.filePath || args.filename) {
    parts.push(`文件: ${args.file || args.filePath || args.filename}`);
  }

  if (args.old_str !== undefined && args.new_str !== undefined) {
    parts.push(`局部替换 (${String(args.old_str).length} 字符 -> ${String(args.new_str).length} 字符)`);
  } else if (Array.isArray(args.edits) && args.edits.length > 0) {
    parts.push(`批量局部替换 (${args.edits.length} 处)`);
  }

  if (Array.isArray(args.files) && args.files.length > 0) {
    const filePaths = args.files
      .map((f) => (typeof f === "string" ? f : f?.path || ""))
      .filter(Boolean);
    if (filePaths.length > 0) {
      parts.push(`涉及文件: ${filePaths.slice(0, 3).join(", ")}${filePaths.length > 3 ? " 等" : ""}`);
    }
  }

  if (args.query) {
    const q = String(args.query).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`查询: ${q.length > 60 ? `${q.slice(0, 60)}...` : q}`);
  } else if (args.q) {
    const q = String(args.q).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`查询: ${q.length > 60 ? `${q.slice(0, 60)}...` : q}`);
  }

  if (args.branch) {
    parts.push(`分支: ${args.branch}`);
  } else if (args.ref) {
    parts.push(`引用: ${args.ref}`);
  }

  if (args.pullNumber || args.pull_number) {
    parts.push(`PR #${args.pullNumber || args.pull_number}`);
  }

  if (args.issue_number || args.issueNumber) {
    parts.push(`Issue #${args.issue_number || args.issueNumber}`);
  }

  if (args.message) {
    const m = String(args.message).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`说明: ${m.length > 40 ? `${m.slice(0, 40)}...` : m}`);
  }

  if (args.url) {
    const u = String(args.url).trim();
    parts.push(`地址: ${u.length > 60 ? `${u.slice(0, 60)}...` : u}`);
  }

  if (parts.length === 0) {
    const keys = Object.keys(args).filter((k) => typeof args[k] === "string" || typeof args[k] === "number");
    for (const k of keys.slice(0, 2)) {
      const v = String(args[k]).replace(/[\r\n\t]+/g, " ").trim();
      if (v) {
        parts.push(`${k}: ${v.length > 40 ? `${v.slice(0, 40)}...` : v}`);
      }
    }
  }

  return parts.join(", ");
}

function isWriteTool(toolName) {
  if (!toolName || typeof toolName !== "string") return false;
  const lower = toolName.toLowerCase();
  const writePatterns = [
    "write", "create", "update", "delete", "edit", "patch",
    "push", "modify", "merge", "fork", "cancel", "rerun",
    "trigger", "comment", "star", "unstar", "manage"
  ];
  return writePatterns.some((pattern) => lower.includes(pattern));
}

function generateToolCallKey(toolName, args) {
  if (!args || typeof args !== "object") return `${toolName}:{}`;
  try {
    const sortedKeys = Object.keys(args).sort();
    const normalized = {};
    for (const k of sortedKeys) {
      normalized[k] = args[k];
    }
    return `${toolName}:${JSON.stringify(normalized)}`;
  } catch {
    return `${toolName}:${JSON.stringify(args)}`;
  }
}

function sendSSEChunk(clientResponse, delta, model = "default") {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null
      }
    ]
  };
  clientResponse.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sendReasoningChunk(clientResponse, text, model = "default") {
  sendSSEChunk(clientResponse, { reasoning_content: text }, model);
}

function isTruncatedFinishReason(reason) {
  if (!reason || typeof reason !== "string") return false;
  const r = reason.toLowerCase().trim();
  return (
    r === "length" ||
    r === "max_tokens" ||
    r === "model_length" ||
    r.includes("max_output_tokens") ||
    r === "incomplete"
  );
}

function extractFinishReason(parsedChunkOrJson) {
  if (!parsedChunkOrJson || typeof parsedChunkOrJson !== "object") return null;
  const choice = parsedChunkOrJson.choices?.[0];
  if (choice) {
    if (choice.finish_reason) return choice.finish_reason;
    if (choice.finishReason) return choice.finishReason;
  }
  const candidate = parsedChunkOrJson.candidates?.[0];
  if (candidate?.finishReason) return candidate.finishReason;
  if (parsedChunkOrJson.finish_reason) return parsedChunkOrJson.finish_reason;
  if (parsedChunkOrJson.finishReason) return parsedChunkOrJson.finish_reason;
  if (parsedChunkOrJson.status === "incomplete" && parsedChunkOrJson.incomplete_details?.reason) {
    return parsedChunkOrJson.incomplete_details.reason;
  }
  return null;
}

async function passThrough(requestBody, clientResponse, reqMeta, abortSignal) {
  setCorsHeaders(clientResponse);
  const isStream = requestBody.stream === true;
  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("未配置上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 转发请求至上游: ${requestBody.model || "default"} - stream=${isStream}`, {
    channel: channel.name,
    url: targetUrl,
    model: requestBody.model,
    stream: isStream,
    messagesCount: requestBody.messages?.length || 0,
    upstreamPayloadSummary: {
      reasoning_effort: requestBody.reasoning_effort,
      thinkingConfig: requestBody.thinkingConfig,
      thinking_budget: requestBody.thinking_budget
    }
  });

  let currentMessages = [...(requestBody.messages || [])];
  let continueRound = 0;
  const MAX_AUTO_CONTINUES = 30;
  let hasInitiatedStream = false;
  let fullAccumulatedContent = "";

  while (continueRound <= MAX_AUTO_CONTINUES) {
    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止请求与续接`);
      break;
    }

    let upstreamResponse;
    const roundStartTime = Date.now();
    if (continueRound > 0) {
      addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 第 ${continueRound + 1} 轮断点续接上游请求 - 消息量: ${currentMessages.length}`);
    }

    try {
      upstreamResponse = await fetch(targetUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channel.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...requestBody,
          messages: currentMessages
        }),
        signal: abortSignal
      });
    } catch (err) {
      if (abortSignal?.aborted || err.name === "AbortError") {
        addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，上游请求已中止`);
        return;
      }
      throw err;
    }

    const duration = Date.now() - roundStartTime;
    addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 上游响应状态: ${upstreamResponse.status} - 耗时 ${duration}ms`, {
      channel: channel.name,
      status: upstreamResponse.status,
      contentType: upstreamResponse.headers.get("Content-Type")
    });

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止处理`);
      return;
    }

    if (!upstreamResponse.ok) {
      const errTxt = await upstreamResponse.text();
      addDebugLog("ERROR", `[直通模式] [${channel.name}] 上游报错 (${upstreamResponse.status})`, errTxt);
      if (isStream && hasInitiatedStream) {
        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: requestBody.model || "default",
          choices: [
            {
              index: 0,
              delta: { content: `\n\n⚠️ [上游接口返回错误 ${upstreamResponse.status}]: ${errTxt.slice(0, 500)}` },
              finish_reason: "stop"
            }
          ]
        };
        clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        clientResponse.write("data: [DONE]\n\n");
        clientResponse.end();
      } else {
        sendJson(clientResponse, upstreamResponse.status, {
          error: { code: upstreamResponse.status, message: errTxt }
        });
      }
      return;
    }

    if (!isStream) {
      const json = await upstreamResponse.json();
      if (abortSignal?.aborted || clientResponse.destroyed) return;
      const rawReason = extractFinishReason(json);
      const choice = json.choices?.[0];
      const content = choice?.message?.content || "";
      fullAccumulatedContent += content;

      if (isTruncatedFinishReason(rawReason) && content && !abortSignal?.aborted && !clientResponse.destroyed) {
        continueRound += 1;
        addDebugLog("AGENT", `⚠️ [抗截断触发] 直通非流式检测到截断 (${rawReason})！正在自动进行第 ${continueRound} 次无感断点续接...`, {
          round: continueRound,
          finishReason: rawReason,
          accumulatedLength: fullAccumulatedContent.length
        });
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content },
          { role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" }
        ];
        continue;
      }

      if (continueRound > 0 && choice?.message) {
        choice.message.content = fullAccumulatedContent;
      }
      addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 非流式完成输出 - 结束原因: ${rawReason || "stop"}`);
      sendJson(clientResponse, 200, json);
      return;
    }

    if (!hasInitiatedStream) {
      clientResponse.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      hasInitiatedStream = true;
    }

    let buffer = "";
    let roundContent = "";
    let lastFinishReason = null;
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (abortSignal?.aborted || clientResponse.destroyed) {
          addDebugLog("DOWNSTREAM", `[直通模式] 客户端在流式传输中断开连接，已停止上游拉取`);
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(dataStr);
            const choice = parsed.choices?.[0];
            const reason = extractFinishReason(parsed);
            if (reason) {
              lastFinishReason = reason;
            }
            if (choice?.delta?.content) {
              roundContent += choice.delta.content;
            }

            if (isTruncatedFinishReason(reason)) {
              const sanitized = {
                ...parsed,
                choices: choice ? [{ ...choice, finish_reason: null, finishReason: null }] : []
              };
              clientResponse.write(`data: ${JSON.stringify(sanitized)}\n\n`);
            } else {
              clientResponse.write(`${line}\n\n`);
            }
          } catch {
            clientResponse.write(`${line}\n\n`);
          }
        }
      }
    } catch (err) {
      if (abortSignal?.aborted || err.name === "AbortError") {
        addDebugLog("DOWNSTREAM", `[直通模式] 客户端中断传输`);
        return;
      }
      throw err;
    }

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止自动续接`);
      break;
    }

    fullAccumulatedContent += roundContent;

    if (isTruncatedFinishReason(lastFinishReason) && roundContent && !abortSignal?.aborted && !clientResponse.destroyed) {
      continueRound += 1;
      addDebugLog("AGENT", `⚠️ [抗截断触发] 直通流式检测到截断 (${lastFinishReason})！正在自动进行第 ${continueRound} 次无感断点续接...`, {
        round: continueRound,
        finishReason: lastFinishReason,
        accumulatedLength: fullAccumulatedContent.length
      });
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: roundContent },
        { role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" }
      ];
      continue;
    }

    addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 流式完成输出 - 结束原因: ${lastFinishReason || "stop"}`);
    break;
  }

  if (!abortSignal?.aborted && !clientResponse.destroyed) {
    clientResponse.write("data: [DONE]\n\n");
    clientResponse.end();
  }
}

function isModelEnabledForMcp(modelName) {
  if (!modelName || enabledModels.size === 0) return false;
  const target = modelName.trim().toLowerCase();
  for (const m of enabledModels) {
    const pattern = m.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === target) return true;
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`, "i");
      if (regex.test(target)) return true;
    }
  }
  return false;
}

function convertGeminiToOpenAIMessages(body) {
  const messages = [];
  if (body.systemInstruction?.parts) {
    const sysText = body.systemInstruction.parts.map((p) => p.text || "").join("\n");
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      const role = c.role === "model" ? "assistant" : "user";
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const contentItems = [];
      const toolCalls = [];
      let hasImage = false;

      for (const p of parts) {
        if (p.text) {
          contentItems.push({ type: "text", text: p.text });
        }
        const idata = p.inlineData || p.inline_data;
        if (idata) {
          hasImage = true;
          const mime = idata.mimeType || idata.mime_type || "image/jpeg";
          const b64 = idata.data || "";
          const url = b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64}`;
          contentItems.push({
            type: "image_url",
            image_url: { url }
          });
        }
        const fdata = p.fileData || p.file_data;
        if (fdata) {
          hasImage = true;
          const uri = fdata.fileUri || fdata.file_uri || "";
          contentItems.push({
            type: "image_url",
            image_url: { url: uri }
          });
        }
        if (p.functionCall) {
          toolCalls.push({
            id: `call_${crypto.randomUUID()}`,
            type: "function",
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {})
            }
          });
        }
        if (p.functionResponse) {
          messages.push({
            role: "tool",
            tool_call_id: p.functionResponse.id || `call_${crypto.randomUUID()}`,
            content: JSON.stringify(p.functionResponse.response || {})
          });
        }
      }

      let finalContent = null;
      if (hasImage) {
        finalContent = contentItems;
      } else if (contentItems.length > 0) {
        finalContent = contentItems.map((item) => item.text).join("");
      }

      if (finalContent !== null || toolCalls.length > 0) {
        const msg = { role, content: finalContent };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    }
  }
  return messages;
}

function convertOpenAiChunkToGemini(parsedChunk) {
  const choice = parsedChunk.choices?.[0];
  const delta = choice?.delta;
  const parts = [];

  if (delta?.reasoning_content) {
    parts.push({
      thought: true,
      text: delta.reasoning_content
    });
  }

  if (delta?.content) {
    parts.push({
      text: delta.content
    });
  }

  const rawReason = extractFinishReason(parsedChunk);
  let finishReason = undefined;
  if (rawReason) {
    const r = String(rawReason).toLowerCase().trim();
    if (r === "stop") finishReason = "STOP";
    else if (isTruncatedFinishReason(rawReason)) finishReason = "MAX_TOKENS";
  }

  return {
    candidates: [
      {
        content: {
          parts: parts.length > 0 ? parts : [{ text: "" }],
          role: "model"
        },
        finishReason,
        index: 0
      }
    ]
  };
}

async function handleGeminiGenerateContent(modelName, isStream, geminiBody, clientResponse, reqMeta, abortSignal) {
  const openAiMessages = convertGeminiToOpenAIMessages(geminiBody);
  const openAiBody = {
    model: modelName,
    messages: openAiMessages,
    stream: isStream,
    temperature: geminiBody.generationConfig?.temperature,
    max_tokens: geminiBody.generationConfig?.maxOutputTokens
  };

  if (geminiBody.generationConfig?.thinkingConfig) {
    openAiBody.thinkingConfig = geminiBody.generationConfig.thinkingConfig;
    const tc = geminiBody.generationConfig.thinkingConfig;

    let level = "";
    if (typeof tc.thinkingLevel === "string") {
      level = tc.thinkingLevel.toLowerCase().trim();
    }

    if (typeof tc.thinkingBudget === "number") {
      openAiBody.thinking_budget = tc.thinkingBudget;
      if (tc.thinkingBudget <= 0) level = "off";
      else if (tc.thinkingBudget < 2048) level = "low";
      else if (tc.thinkingBudget < 8192) level = "medium";
      else level = "high";
    }

    if (level) {
      openAiBody.reasoning_effort = level;
      if (level === "off") {
        openAiBody.thinking_budget = 0;
      } else if (level === "low") {
        openAiBody.thinking_budget = 1024;
      } else if (level === "medium") {
        openAiBody.thinking_budget = 4096;
      } else if (level === "high") {
        openAiBody.thinking_budget = 16384;
      }
    }
  }

  if (geminiBody.generationConfig) {
    for (const [k, v] of Object.entries(geminiBody.generationConfig)) {
      if (!["temperature", "maxOutputTokens"].includes(k)) {
        openAiBody[k] = v;
      }
    }
  }

  const mcpEnabled = isModelEnabledForMcp(modelName) && mcpToolRegistry.size > 0;

  addDebugLog("DOWNSTREAM", `收到 Gemini 格式请求 [${modelName}] - stream=${isStream}`, {
    model: modelName,
    stream: isStream,
    mcpEnabled,
    messagesCount: openAiMessages.length,
    thinkingConfig: geminiBody.generationConfig?.thinkingConfig || null,
    reasoning_effort: openAiBody.reasoning_effort || null
  });

  if (!isStream) {
    const fakeClientResponse = {
      _headers: {},
      _body: "",
      statusCode: 200,
      get destroyed() { return clientResponse.destroyed; },
      get writableEnded() { return clientResponse.writableEnded; },
      setHeader(k, v) { this._headers[k] = v; },
      writeHead(code, headers) { this.statusCode = code; Object.assign(this._headers, headers); },
      write(chunk) { this._body += chunk.toString(); },
      end(chunk) {
        if (abortSignal?.aborted || clientResponse.destroyed) return;
        if (chunk) this._body += chunk.toString();
        try {
          const json = JSON.parse(this._body);
          const candidateText = json.choices?.[0]?.message?.content || "";
          const reasoning = json.choices?.[0]?.message?.reasoning_content || "";
          const parts = [];
          if (reasoning) parts.push({ thought: true, text: reasoning });
          if (candidateText) parts.push({ text: candidateText });
          const rawReason = extractFinishReason(json);
          const geminiResp = {
            candidates: [
              {
                content: { parts: parts.length > 0 ? parts : [{ text: "" }], role: "model" },
                finishReason: isTruncatedFinishReason(rawReason) ? "MAX_TOKENS" : "STOP",
                index: 0
              }
            ]
          };
          sendJson(clientResponse, 200, geminiResp);
        } catch {
          sendJson(clientResponse, 500, { error: { message: "Gemini 响应解析失败" } });
        }
      }
    };
    if (mcpEnabled) {
      await runAgent(openAiBody, fakeClientResponse, reqMeta, abortSignal);
    } else {
      await passThroughAndTransformGemini(openAiBody, clientResponse, false, abortSignal);
    }
    return;
  }

  if (mcpEnabled) {
    setCorsHeaders(clientResponse);
    clientResponse.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    let buffer = "";
    const fakeStreamClientResponse = {
      _headers: {},
      get destroyed() { return clientResponse.destroyed; },
      get writableEnded() { return clientResponse.writableEnded; },
      setHeader(k, v) { this._headers[k] = v; },
      writeHead(code, headers) { Object.assign(this._headers, headers); },
      write(chunk) {
        if (abortSignal?.aborted || clientResponse.destroyed) return;
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            if (!clientResponse.writableEnded) clientResponse.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const geminiChunk = convertOpenAiChunkToGemini(parsed);
            if (!clientResponse.writableEnded) clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
          } catch {}
        }
      },
      end() {
        if (!clientResponse.writableEnded) {
          clientResponse.end();
        }
      }
    };
    await runAgent(openAiBody, fakeStreamClientResponse, reqMeta, abortSignal);
  } else {
    await passThroughAndTransformGemini(openAiBody, clientResponse, true, abortSignal);
  }
}

async function passThroughAndTransformGemini(requestBody, clientResponse, isStream, abortSignal) {
  const startTime = Date.now();
  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("未配置上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  addDebugLog("UPSTREAM", `[Gemini 直通模式] [${channel.name}] 转发转换至上游: ${requestBody.model || "default"}`, {
    channel: channel.name,
    url: targetUrl,
    model: requestBody.model,
    stream: isStream,
    messagesCount: requestBody.messages?.length || 0
  });

  let currentMessages = [...requestBody.messages];
  let continueRound = 0;
  const MAX_AUTO_CONTINUES = 30;
  let hasInitiatedStream = false;

  while (continueRound <= MAX_AUTO_CONTINUES) {
    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已断开，终止续接`);
      break;
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channel.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...requestBody,
          messages: currentMessages
        }),
        signal: abortSignal
      });
    } catch (err) {
      if (abortSignal?.aborted || err.name === "AbortError") {
        addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已中止请求`);
        return;
      }
      throw err;
    }

    const duration = Date.now() - startTime;
    addDebugLog("UPSTREAM", `[Gemini 直通模式] [${channel.name}] 上游响应状态: ${upstreamResponse.status} - 耗时 ${duration}ms`, {
      channel: channel.name,
      status: upstreamResponse.status,
      contentType: upstreamResponse.headers.get("Content-Type")
    });

    if (abortSignal?.aborted || clientResponse.destroyed) return;

    if (!upstreamResponse.ok) {
      const errTxt = await upstreamResponse.text();
      sendJson(clientResponse, upstreamResponse.status, {
        error: { code: upstreamResponse.status, message: errTxt }
      });
      return;
    }

    if (!isStream) {
      const json = await upstreamResponse.json();
      if (abortSignal?.aborted || clientResponse.destroyed) return;
      const choice = json.choices?.[0];
      const candidateText = choice?.message?.content || "";
      const reasoning = choice?.message?.reasoning_content || "";
      const parts = [];
      if (reasoning) parts.push({ thought: true, text: reasoning });
      if (candidateText) parts.push({ text: candidateText });

      const rawReason = extractFinishReason(json);
      const geminiResp = {
        candidates: [
          {
            content: { parts: parts.length > 0 ? parts : [{ text: "" }], role: "model" },
            finishReason: isTruncatedFinishReason(rawReason) ? "MAX_TOKENS" : "STOP",
            index: 0
          }
        ]
      };
      sendJson(clientResponse, 200, geminiResp);
      return;
    }

    if (!hasInitiatedStream) {
      setCorsHeaders(clientResponse);
      clientResponse.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      hasInitiatedStream = true;
    }

    let buffer = "";
    let accumulatedContent = "";
    let lastFinishReason = null;
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (abortSignal?.aborted || clientResponse.destroyed) {
          addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端在流式传输中断开连接，已停止上游拉取`);
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(dataStr);
            const choice = parsed.choices?.[0];
            const reason = extractFinishReason(parsed);
            if (reason) {
              lastFinishReason = reason;
            }
            if (choice?.delta?.content) {
              accumulatedContent += choice.delta.content;
            }
            if (isTruncatedFinishReason(reason)) {
              const geminiChunk = convertOpenAiChunkToGemini({
                ...parsed,
                choices: choice ? [{ ...choice, finish_reason: null, finishReason: null }] : []
              });
              clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
            } else {
              const geminiChunk = convertOpenAiChunkToGemini(parsed);
              clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
            }
          } catch {}
        }
      }
    } catch (err) {
      if (abortSignal?.aborted || err.name === "AbortError") {
        addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端中断传输`);
        return;
      }
      throw err;
    }

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已断开，终止自动续接`);
      break;
    }

    if (isTruncatedFinishReason(lastFinishReason) && accumulatedContent && !abortSignal?.aborted && !clientResponse.destroyed) {
      continueRound += 1;
      addDebugLog("AGENT", `⚠️ [抗截断触发] 检测到上游返回截断 (${lastFinishReason})！正在自动进行第 ${continueRound} 次无感断点续接...`, {
        round: continueRound,
        finishReason: lastFinishReason,
        accumulatedLength: accumulatedContent.length
      });
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: accumulatedContent },
        { role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" }
      ];
      continue;
    }

    break;
  }

  if (!abortSignal?.aborted && !clientResponse.destroyed) {
    clientResponse.write("data: [DONE]\n\n");
    clientResponse.end();
  }
}

async function runAgent(requestBody, clientResponse, reqMeta, abortSignal) {
  if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
    throw new Error("messages 必须是非空数组");
  }

  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("未配置上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  const isStream = requestBody.stream === true;
  let messages = [...requestBody.messages];

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const userText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : (Array.isArray(lastUserMsg?.content) ? lastUserMsg.content.map((c) => c.text || "").join(" ") : "");

  const clientTools = Array.isArray(requestBody.tools)
    ? requestBody.tools.filter((t) => t && t.type === "function")
    : [];
  const rawMcpTools = getAllTools();
  const relevantMcpTools = selectRelevantTools(userText, rawMcpTools);
  const tools = [...clientTools, ...relevantMcpTools];

  const { needsTool, isWrite } = detectActionIntent(userText);

  addDebugLog("AGENT", `启动 MCP 调度 [${channel.name}] - 模型 [${requestBody.model}] - 挂载工具数: ${tools.length} - 动作需求: ${needsTool} (写操作: ${isWrite})`, {
    channel: channel.name,
    model: requestBody.model,
    stream: isStream,
    toolCount: tools.length,
    needsTool,
    isWrite,
    initialMessages: messages.length
  });

  if (isStream) {
    setCorsHeaders(clientResponse);
    clientResponse.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
  }

  let keepAliveTimer = null;
  if (isStream) {
    keepAliveTimer = setInterval(() => {
      if (abortSignal?.aborted || clientResponse.destroyed) {
        clearInterval(keepAliveTimer);
        return;
      }
      try {
        clientResponse.write(": keep-alive\n\n");
      } catch {}
    }, 4000);
  }

  let finalFinishReason = null;
  let executedToolCount = 0;
  const toolCallHistory = new Map();
  const dialogReadCache = new Map();
  let hasWriteSuccess = false;
  let consecutiveFailures = 0;
  const MAX_AGENT_ROUNDS = 35;

  try {
    for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
      if (abortSignal?.aborted || clientResponse.destroyed) {
        addDebugLog("DOWNSTREAM", `客户端已断开，终止 MCP 调度循环`);
        break;
      }

      if (messages.length > 30) {
        for (let i = 0; i < messages.length - 15; i += 1) {
          const m = messages[i];
          if (m && m.role === "tool" && typeof m.content === "string" && m.content.length > 2000) {
            m.content = m.content.slice(0, 1000) + "\n\n[历史输出已精简]";
          }
        }
      }

      let roundMessages = [...messages];
      roundMessages.push({
        role: "system",
        content: "【工具调用透明化规范】\n在发起任何工具调用前，严禁将调用说明写入思考过程（thinking/reasoning_content）中！你必须在当前轮次的正文内容（content）中直接输出简短明确的说明，确保在界面正文气泡中直观展示：\n**目标说明**：[简要说明调用目标]\n**调用工具**：`[调用的工具名称]`\n**检索内容**：[目标仓库、文件路径、参数或检索摘要]\n\n输出完上述内容后再执行工具调用。"
      });
      const hasCloudflare = tools.some((t) => {
        const n = (t.function?.name || "").toLowerCase();
        return n.includes("cloudflare");
      });
      if (round === 0 && hasCloudflare) {
        roundMessages.push({
          role: "system",
          content: "【Cloudflare 工具执行规范】\n1. 沙箱内已预置带有鉴权的全局客户端 `cloudflare.request({ method, path, body, contentType, rawBody })` 与全局变量 `accountId`。严禁自行拼接 BaseURL 或使用原生 fetch()，必须直接使用 `cloudflare.request`。\n2. 读取 Worker 脚本: `cloudflare.request({ method: 'GET', path: `/accounts/${accountId}/workers/scripts/${name}` })`。\n3. 更新单文件 Worker 脚本: `cloudflare.request({ method: 'PUT', path: `/accounts/${accountId}/workers/scripts/${name}`, body: codeString, contentType: 'application/javascript', rawBody: true })`（若为模块 Worker 则按 multipart/form-data 格式）。切勿盲目遍历搜索庞大的 OpenAPI 规范。\n4. 若操作对象是 Cloudflare 资源，切勿跨平台在 GitHub 相关工具上搜索无关个人或仓库。"
        });
      }
      if (consecutiveFailures >= 2) {
        roundMessages.push({
          role: "system",
          content: "【错误自愈与收敛提示】检测到前序工具调用返回错误。请先检查参数与目标环境是否正确，切勿在未知或不存在的端点上机械试错；若核心逻辑已通过排查查明，请直接聚焦于问题修复与交付，避免过度扩散探索。"
        });
      } else if (round === 0 && isWrite) {
        roundMessages.push({
          role: "system",
          content: "【执行规范】检测到代码或配置修改任务。请根据目标资源类型选择匹配的工具：\n- 若修改 GitHub 仓库文件，优先调用局部修改工具（如 github_edit_file）替换代码片段；\n- 若修改 Cloudflare Worker/KV 等远程云资源，直接使用 Cloudflare 工具处理，严禁跨平台跑到 GitHub 检索无关个人或仓库；\n- 修改已有代码前先快速获取关键逻辑上下文，一旦定位根因立即收敛修改，避免多轮无效探索。"
        });
      }

      const activeTools = tools;
      let activeToolChoice = "auto";

      const payload = {
        ...requestBody,
        messages: roundMessages,
        stream: isStream
      };

      if (activeTools.length > 0) {
        payload.tools = activeTools;
        payload.tool_choice = activeToolChoice;
      }

      const roundStartTime = Date.now();
      addDebugLog("UPSTREAM", `[${channel.name}] 第 ${round + 1} 轮上游调用请求 - 消息量: ${roundMessages.length}`, {
        channel: channel.name,
        round: round + 1,
        toolsEnabled: Boolean(payload.tools),
        tool_choice: payload.tool_choice,
        messagesCount: roundMessages.length
      });

      let upstreamResponse;
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${channel.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          signal: abortSignal
        });
      } catch (err) {
        if (abortSignal?.aborted || err.name === "AbortError") {
          addDebugLog("DOWNSTREAM", `第 ${round + 1} 轮上游请求被客户端中止`);
          return;
        }
        throw err;
      }

      const roundDuration = Date.now() - roundStartTime;
      if (abortSignal?.aborted || clientResponse.destroyed) return;

      if (!upstreamResponse.ok) {
        const errText = await upstreamResponse.text();
        addDebugLog("ERROR", `[${channel.name}] 第 ${round + 1} 轮上游报错 (${upstreamResponse.status}) - 耗时 ${roundDuration}ms`, errText);

        if (isStream) {
          const errorChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model || "default",
            choices: [
              {
                index: 0,
                delta: { content: `\n\n⚠️ [上游接口返回错误 ${upstreamResponse.status}]: ${errText.slice(0, 500)}` },
                finish_reason: "stop"
              }
            ]
          };
          if (!clientResponse.destroyed && !abortSignal?.aborted) {
            clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            clientResponse.write("data: [DONE]\n\n");
            clientResponse.end();
          }
          return;
        }
        throw new Error(`上游接口返回错误 (${upstreamResponse.status})：${errText.slice(0, 500)}`);
      }

      if (!isStream) {
        const json = await upstreamResponse.json();
        if (abortSignal?.aborted || clientResponse.destroyed) return;
        const choice = json.choices?.[0];
        const message = choice?.message;
        const toolCalls = message?.tool_calls || [];
        finalFinishReason = extractFinishReason(json);

        const mcpCalls = toolCalls.filter((tc) => {
          if (!tc || !tc.function?.name) return false;
          const name = tc.function.name;
          if (mcpToolRegistry.has(name)) return true;
          for (const [k, v] of mcpToolRegistry.entries()) {
            if (k.endsWith(name) || name.endsWith(v.rawName)) return true;
          }
          return false;
        });

        if (mcpCalls.length === 0) {
          addDebugLog("AGENT", `第 ${round + 1} 轮完成 - 非流式响应返回客户端 (累计执行工具 ${executedToolCount} 次)`, {
            finishReason: finalFinishReason,
            contentLength: message?.content?.length || 0
          });
          sendJson(clientResponse, 200, json);
          return;
        }

        messages.push(message);

        let roundHasFailure = false;
        for (let i = 0; i < mcpCalls.length; i += 1) {
          const tc = mcpCalls[i];
          if (abortSignal?.aborted || clientResponse.destroyed) break;
          if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          let toolInfo = mcpToolRegistry.get(tc.function.name);
          if (!toolInfo) {
            for (const [k, v] of mcpToolRegistry.entries()) {
              if (k.endsWith(tc.function.name) || tc.function.name.endsWith(v.rawName)) {
                toolInfo = v;
                break;
              }
            }
          }
          const rawAction = toolInfo?.rawName || tc.function.name;
          const isWrite = isWriteTool(rawAction);
          const args = toolArguments(tc);
          let resultText = "";
          let isToolError = false;
          if (args === null) {
            resultText = JSON.stringify({ error: "Invalid tool arguments" });
            isToolError = true;
          } else {
            const callKey = generateToolCallKey(tc.function.name, args);
            const prevAttempts = toolCallHistory.get(callKey) || 0;
            const cachedContent = !isWrite ? dialogReadCache.get(callKey) : null;

            if (cachedContent !== undefined && cachedContent !== null) {
              toolCallHistory.set(callKey, prevAttempts + 1);
              if (prevAttempts >= 5) {
                resultText = JSON.stringify({ note: "已多次复用该工具的缓存结果，当前信息完整且最新。请直接根据已有信息继续执行或回答用户。" });
              } else {
                resultText = cachedContent;
                addDebugLog("TOOL", `MCP 工具 [${tc.function.name}] 命中本次对话只读缓存，直接复用 (${cachedContent.length} 字符)`, { arguments: args });
              }
              isToolError = false;
            } else if (prevAttempts >= 2) {
              resultText = JSON.stringify({ error: "该工具已使用完全相同的参数重复调用多次，系统已拦截重复执行。请勿继续重复调用，请根据当前信息直接回答用户。" });
              isToolError = true;
            } else {
              toolCallHistory.set(callKey, prevAttempts + 1);
              try {
                const toolRes = await callMcpTool(tc.function.name, args);
                resultText = toolRes.content;
                isToolError = toolRes.isError;
                if (!isToolError) {
                  executedToolCount += 1;
                  if (isWrite) {
                    hasWriteSuccess = true;
                    dialogReadCache.clear();
                  } else {
                    dialogReadCache.set(callKey, resultText);
                  }
                }
              } catch (err) {
                resultText = JSON.stringify({ error: err instanceof Error ? err.message : "Tool execution failed" });
                isToolError = true;
              }
            }
          }
          if (isToolError) {
            roundHasFailure = true;
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: resultText
          });
        }

        if (roundHasFailure) {
          consecutiveFailures += 1;
        } else {
          consecutiveFailures = 0;
        }
        continue;
      }

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedToolCalls = [];
      let assistantContent = "";
      let hasToolCalls = false;
      let roundFinishReason = null;

      try {
        while (true) {
          if (abortSignal?.aborted || clientResponse.destroyed) {
            addDebugLog("DOWNSTREAM", `[AGENT] 客户端在流式传输中断开连接，已停止上游拉取`);
            await reader.cancel().catch(() => {});
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            try {
              const parsed = JSON.parse(dataStr);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;
              const reason = extractFinishReason(parsed);
              if (reason) {
                roundFinishReason = reason;
              }

              if (delta?.tool_calls) {
                hasToolCalls = true;
                for (const tc of delta.tool_calls) {
                  const index = tc.index ?? 0;
                  if (!accumulatedToolCalls[index]) {
                    accumulatedToolCalls[index] = {
                      id: tc.id || `call_${crypto.randomUUID()}`,
                      name: tc.function?.name || "",
                      arguments: ""
                    };
                  }
                  if (tc.id) accumulatedToolCalls[index].id = tc.id;
                  if (tc.function?.name) accumulatedToolCalls[index].name = tc.function.name;
                  if (tc.function?.arguments) accumulatedToolCalls[index].arguments += tc.function.arguments;
                }
              }

              if (delta?.content) {
                assistantContent += delta.content;
                if (!hasToolCalls && !clientResponse.destroyed && !abortSignal?.aborted) {
                  if (isTruncatedFinishReason(reason)) {
                    const sanitized = {
                      ...parsed,
                      choices: choice ? [{ ...choice, finish_reason: null, finishReason: null }] : []
                    };
                    clientResponse.write(`data: ${JSON.stringify(sanitized)}\n\n`);
                  } else {
                    clientResponse.write(`${line}\n\n`);
                  }
                }
              } else if (delta?.reasoning_content) {
                if (!clientResponse.destroyed && !abortSignal?.aborted) {
                  clientResponse.write(`${line}\n\n`);
                }
              }
            } catch {}
          }
        }
      } catch (err) {
        if (abortSignal?.aborted || err.name === "AbortError") {
          addDebugLog("DOWNSTREAM", `[AGENT] 客户端中断传输`);
          return;
        }
        throw err;
      }

      if (abortSignal?.aborted || clientResponse.destroyed) {
        addDebugLog("DOWNSTREAM", `客户端已断开，终止后续 MCP 处理与续接`);
        break;
      }

      const mcpCalls = accumulatedToolCalls.filter((tc) => {
        if (!tc || !tc.name) return false;
        if (mcpToolRegistry.has(tc.name)) return true;
        for (const [k, v] of mcpToolRegistry.entries()) {
          if (k.endsWith(tc.name) || tc.name.endsWith(v.rawName)) return true;
        }
        return false;
      });

      if (mcpCalls.length === 0) {
        if (isTruncatedFinishReason(roundFinishReason) && assistantContent && !abortSignal?.aborted && !clientResponse.destroyed) {
          addDebugLog("AGENT", `⚠️ [抗截断触发] MCP 调度检测到截断 (${roundFinishReason})！正在自动进行无感断点续接...`, {
            round: round + 1,
            finishReason: roundFinishReason,
            accumulatedLength: assistantContent.length
          });
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({ role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" });
          continue;
        }

        if (!abortSignal?.aborted && !clientResponse.destroyed) {
          clientResponse.write("data: [DONE]\n\n");
          clientResponse.end();
        }
        addDebugLog("AGENT", `第 ${round + 1} 轮流式完成输出 - 结束原因: ${roundFinishReason || "stop"} (累计执行工具 ${executedToolCount} 次)`, {
          round: round + 1,
          finishReason: roundFinishReason,
          totalRounds: round + 1
        });
        return;
      }

      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: mcpCalls.map((tc) => ({
          id: tc.id || `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments }
        }))
      });

      let roundHasFailure = false;
      for (let i = 0; i < mcpCalls.length; i += 1) {
        const tc = mcpCalls[i];
        if (abortSignal?.aborted || clientResponse.destroyed) break;
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        let toolInfo = mcpToolRegistry.get(tc.name);
        if (!toolInfo) {
          for (const [k, v] of mcpToolRegistry.entries()) {
            if (k.endsWith(tc.name) || tc.name.endsWith(v.rawName)) {
              toolInfo = v;
              break;
            }
          }
        }

        const displayName = toolInfo?.serverName || "MCP";
        const rawAction = toolInfo?.rawName || tc.name;
        const isWrite = isWriteTool(rawAction);
        const args = toolArguments({ function: { arguments: tc.arguments } });
        const actionDetails = formatToolCallDetails(args);
        const detailSuffix = actionDetails ? ` | ${actionDetails}` : "";

        let resultText = "";
        let isToolError = false;
        let errorMessage = "";
        let isCacheHit = false;

        if (args === null) {
          errorMessage = "无效参数";
          resultText = JSON.stringify({ error: errorMessage });
          isToolError = true;
        } else {
          const callKey = generateToolCallKey(tc.name, args);
          const prevAttempts = toolCallHistory.get(callKey) || 0;
          const cachedContent = !isWrite ? dialogReadCache.get(callKey) : null;

          if (cachedContent !== undefined && cachedContent !== null) {
            isCacheHit = true;
            toolCallHistory.set(callKey, prevAttempts + 1);
            if (prevAttempts >= 5) {
              resultText = JSON.stringify({ note: "已多次复用该工具的缓存结果，当前信息完整且最新。请直接根据已有信息继续执行或回答用户。" });
            } else {
              resultText = cachedContent;
              addDebugLog("TOOL", `MCP 工具 [${tc.name}] 命中本次对话只读缓存，直接复用 (${cachedContent.length} 字符)`, { arguments: args });
            }
            isToolError = false;
          } else if (prevAttempts >= 2) {
            errorMessage = "重复调用已被系统拦截";
            resultText = JSON.stringify({ error: "该工具已使用完全相同的参数重复调用多次，系统已拦截重复执行。请勿继续重复调用，请根据当前信息直接回答用户。" });
            isToolError = true;
          } else {
            toolCallHistory.set(callKey, prevAttempts + 1);

            if (!abortSignal?.aborted && !clientResponse.destroyed) {
              sendReasoningChunk(
                clientResponse,
                `\n> ⏳ 正在调用 [${displayName}] 执行操作: \`${rawAction}\`${detailSuffix}...\n`,
                requestBody.model
              );
            }

            try {
              const onWaitNotice = (waitSec) => {
                if (!abortSignal?.aborted && !clientResponse.destroyed) {
                  sendReasoningChunk(
                    clientResponse,
                    `> ⏳ 触发 GitHub 访问频控，正在等待 ${waitSec + 1} 秒后自动重试...\n`,
                    requestBody.model
                  );
                }
              };
              const toolRes = await callMcpTool(tc.name, args, onWaitNotice);
              resultText = toolRes.content;
              isToolError = toolRes.isError;
              if (isToolError) {
                errorMessage = extractErrorMessage(toolRes.content);
              } else {
                executedToolCount += 1;
                if (isWrite) {
                  hasWriteSuccess = true;
                  dialogReadCache.clear();
                } else {
                  dialogReadCache.set(callKey, resultText);
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Tool execution failed";
              errorMessage = extractErrorMessage(msg);
              resultText = JSON.stringify({ error: msg });
              isToolError = true;
            }
          }
        }

        if (isToolError) {
          roundHasFailure = true;
        }

        if (!abortSignal?.aborted && !clientResponse.destroyed) {
          if (isCacheHit) {
            sendReasoningChunk(
              clientResponse,
              `\n> ⚡ [${displayName}] \`${rawAction}\`${detailSuffix} (复用对话缓存，无需重复读取)\n\n`,
              requestBody.model
            );
          } else if (isToolError) {
            const failReason = errorMessage ? `: ${errorMessage}` : "";
            sendReasoningChunk(
              clientResponse,
              `> ❌ [${displayName}] 执行失败${detailSuffix}${failReason}\n\n`,
              requestBody.model
            );
          } else {
            sendReasoningChunk(
              clientResponse,
              `> ✅ [${displayName}] 执行完成${detailSuffix}\n\n`,
              requestBody.model
            );
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id || `call_${crypto.randomUUID()}`,
          content: resultText
        });
      }

      if (roundHasFailure) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }
    }
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    dialogReadCache.clear();
  }
}

async function checkAllTools(modelName) {
  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("请先配置 UPSTREAM_1 等上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  let targetModel = (modelName || "").trim();
  if (!targetModel && enabledModels.size > 0) {
    for (const m of enabledModels) {
      const clean = m.replace(/\*/g, "").trim();
      if (clean) {
        targetModel = clean;
        break;
      }
    }
  }

  if (!targetModel) {
    throw new Error("未指定检测模型，请在输入框中指定要测试的上游模型名称");
  }

  let pingRes;
  try {
    pingRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channel.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    throw new Error(`上游请求失败: ${err.message}。未修改任何工具状态`);
  }

  if (!pingRes.ok) {
    const errText = await pingRes.text();
    let msg = errText;
    try {
      const errJson = JSON.parse(errText);
      msg = errJson.error?.message || errText;
    } catch {}
    throw new Error(`上游模型 [${targetModel}] 调用报错 (${pingRes.status}): ${msg.slice(0, 120)}。未修改任何工具状态`);
  }

  let total = 0;
  let supported = 0;
  let unsupported = 0;

  for (const s of mcpServers.values()) {
    if (!Array.isArray(s.tools) || s.tools.length === 0) continue;

    for (const t of s.tools) {
      total += 1;

      if (t.isVirtual) {
        supported += 1;
        t.status = "supported";
        t.statusMessage = "支持";
        t.enabled = true;
        if (s.status === "active") {
          registerVirtualTools(s);
        }
        continue;
      }

      let isSupported = true;
      let reason = "";

      try {
        const testRes = await fetch(targetUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${channel.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: targetModel,
            messages: [{ role: "user", content: "test" }],
            tools: [t.openAiTool],
            max_tokens: 1
          }),
          signal: AbortSignal.timeout(20000)
        });

        if (testRes.ok) {
          isSupported = true;
        } else {
          const errText = await testRes.text();
          let msg = errText;
          try {
            const errJson = JSON.parse(errText);
            msg = errJson.error?.message || errText;
          } catch {}
          if (testRes.status === 400 || testRes.status === 422) {
            isSupported = false;
            reason = msg.slice(0, 100);
          } else {
            isSupported = true;
          }
        }
      } catch {
        isSupported = true;
      }

      if (isSupported) {
        supported += 1;
        t.status = "supported";
        t.statusMessage = "支持";
        t.enabled = true;
        if (s.status === "active") {
          mcpToolRegistry.set(t.key, {
            serverId: s.id,
            serverName: s.name,
            rawName: t.rawName,
            postEndpoint: s.postEndpoint,
            headers: s.headers
          });
        }
      } else {
        unsupported += 1;
        t.status = "unsupported";
        t.statusMessage = reason || "参数格式不支持";
        t.enabled = false;
        mcpToolRegistry.delete(t.key);
      }
    }

    await saveServerToStorage();
  }

  addDebugLog("AGENT", `AI一键检测完成 - 渠道 [${channel.name}] - 测试模型 [${targetModel}] - 共 ${total} 个工具，支持 ${supported} 个，不支持已自动禁用 ${unsupported} 个`);
  return { total, supported, unsupported, model: targetModel };
}

function getLoginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP 控制台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 32px 24px;
      width: 100%;
      max-width: 360px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
      text-align: center;
    }
    h1 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    p { font-size: 13px; color: #64748b; margin-bottom: 20px; }
    input {
      width: 100%;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      margin-bottom: 14px;
    }
    input:focus { border-color: #2563eb; }
    button {
      width: 100%;
      background: #2563eb;
      color: #ffffff;
      border: none;
      font-weight: 600;
      font-size: 14px;
      padding: 10px;
      border-radius: 8px;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    #err-msg { color: #dc2626; font-size: 13px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MCP 控制台认证</h1>
    <p>请输入后台管理密码以进入面板</p>
    <input id="pwd" type="password" placeholder="输入管理密码" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">验证并进入</button>
    <div id="err-msg"></div>
  </div>
  <script>
    async function login() {
      const pwd = document.getElementById("pwd").value.trim();
      const err = document.getElementById("err-msg");
      if (!pwd) { err.innerText = "请输入管理密码"; return; }
      try {
        const res = await fetch("/api/panel/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd })
        });
        if (res.ok) {
          location.reload();
        } else {
          err.innerText = "密码错误，请重新输入";
        }
      } catch (e) {
        err.innerText = e.message;
      }
    }
  </script>
</body>
</html>`;
}

loadUpstreamChannelsFromEnv();
if (dbPool) {
  await initDatabase();
}
await loadConfigFromStorage();
await loadSettingsFromStorage();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    const reqUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if ((request.method === "GET" || request.method === "HEAD") && (reqUrl.pathname === "/" || reqUrl.pathname === "")) {
      setCorsHeaders(response);
      if (PANEL_PASSWORD) {
        const cookies = parseCookies(request);
        if (!verifySessionToken(cookies.panel_auth)) {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(request.method === "HEAD" ? "" : getLoginHtml());
          return;
        }
      }
      const htmlPath = path.join(__dirname, "dashboard.html");
      const htmlContent = fs.readFileSync(htmlPath, "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? "" : htmlContent);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && reqUrl.pathname === "/health") {
      setCorsHeaders(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(request.method === "HEAD" ? "" : JSON.stringify({ status: "ok" }));
      return;
    }

    if (reqUrl.pathname === "/favicon.ico") {
      setCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "POST" && reqUrl.pathname === "/api/panel/login") {
      const body = await readRequestBody(request);
      if (!PANEL_PASSWORD || body.password === PANEL_PASSWORD) {
        const token = generateSessionToken();
        setCorsHeaders(response);
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `panel_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
        });
        response.end(JSON.stringify({ success: true }));
      } else {
        sendJson(response, 401, { error: "密码错误" });
      }
      return;
    }

    if (request.method === "POST" && reqUrl.pathname === "/api/panel/logout") {
      setCorsHeaders(response);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `panel_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      });
      response.end(JSON.stringify({ success: true }));
      return;
    }

    if (reqUrl.pathname.startsWith("/api/")) {
      if (!isPanelAuthorized(request)) {
        sendJson(response, 401, { error: "控制台未授权，请输入管理密码" });
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/api/upstream/channels") {
        const active = getActiveChannel();
        sendJson(response, 200, {
          activeChannelId: active ? active.id : "",
          channels: upstreamChannels.map((c) => ({
            id: c.id,
            name: c.name,
            envKey: c.envKey,
            baseUrl: c.baseUrl,
            maskedKey: maskApiKey(c.apiKey),
            active: Boolean(active && active.id === c.id)
          }))
        });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/upstream/channels/switch") {
        const body = await readRequestBody(request);
        const targetId = String(body.id || "").trim();
        const found = upstreamChannels.find((c) => c.id === targetId);
        if (!found) {
          sendJson(response, 404, { error: "未找到指定的上游渠道" });
          return;
        }
        await saveActiveChannelToStorage(found.id);
        addDebugLog("UPSTREAM", `已切换当前上游渠道至 [${found.name}]`, {
          id: found.id,
          name: found.name,
          envKey: found.envKey,
          baseUrl: found.baseUrl
        });
        sendJson(response, 200, {
          success: true,
          activeChannelId: found.id,
          name: found.name
        });
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/api/logs") {
        sendJson(response, 200, {
          enabled: loggingEnabled,
          logs: debugLogs
        });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/logs/toggle") {
        const body = await readRequestBody(request);
        const newStatus = typeof body.enabled === "boolean" ? body.enabled : !loggingEnabled;
        await saveLoggingConfigToStorage(newStatus);
        sendJson(response, 200, { success: true, enabled: loggingEnabled });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/logs/clear") {
        debugLogs.length = 0;
        sendJson(response, 200, { success: true, logs: [] });
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/api/settings/enabled-models") {
        sendJson(response, 200, { enabledModels: Array.from(enabledModels) });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/settings/enabled-models") {
        const body = await readRequestBody(request);
        const models = Array.isArray(body.models) ? body.models : [];
        await saveEnabledModelsToStorage(models);
        sendJson(response, 200, { success: true, enabledModels: Array.from(enabledModels) });
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/api/upstream/models") {
        const channel = getActiveChannel();
        if (!channel) {
          sendJson(response, 200, { models: [] });
          return;
        }
        const modelsUrl = upstreamModelsUrl(channel);

        try {
          const upstreamResponse = await fetch(modelsUrl, {
            headers: { Authorization: `Bearer ${channel.apiKey}` },
            signal: AbortSignal.timeout(20000)
          });
          const data = await upstreamResponse.json();
          const list = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
          sendJson(response, 200, { models: list, channelName: channel.name });
        } catch (e) {
          sendJson(response, 500, { error: e.message, models: [] });
        }
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/api/mcp/servers") {
        sendJson(response, 200, { servers: Array.from(mcpServers.values()) });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/mcp/connect") {
        const body = await readRequestBody(request);
        const serverInfo = await connectToMcpServer(body);
        sendJson(response, 200, { toolCount: serverInfo.toolCount });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/mcp/tools/enable-all") {
        let count = 0;
        for (const s of mcpServers.values()) {
          if (!Array.isArray(s.tools)) continue;
          for (const t of s.tools) {
            t.enabled = true;
            t.status = "unchecked";
            t.statusMessage = "";
            count += 1;
            if (s.status === "active" && !t.isVirtual) {
              mcpToolRegistry.set(t.key, {
                serverId: s.id,
                serverName: s.name,
                rawName: t.rawName,
                postEndpoint: s.postEndpoint,
                headers: s.headers
              });
            }
          }
          if (s.status === "active") {
            registerVirtualTools(s);
          }
        }
        await saveServerToStorage();
        sendJson(response, 200, { success: true, count });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/mcp/check-tools") {
        const body = await readRequestBody(request);
        const modelName = (body.model || "").trim();
        try {
          const result = await checkAllTools(modelName);
          sendJson(response, 200, { success: true, ...result });
        } catch (e) {
          sendJson(response, 400, { success: false, error: e.message });
        }
        return;
      }

      const matchToggleTool = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools\/([^/]+)\/toggle$/);
      if (request.method === "POST" && matchToggleTool) {
        const serverId = decodeURIComponent(matchToggleTool[1]);
        const toolKey = decodeURIComponent(matchToggleTool[2]);
        const s = mcpServers.get(serverId);
        if (!s) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        const tool = s.tools.find((t) => t.key === toolKey);
        if (!tool) {
          sendJson(response, 404, { error: "未找到该工具" });
          return;
        }
        const body = await readRequestBody(request);
        const nextEnabled = typeof body.enabled === "boolean" ? body.enabled : !tool.enabled;
        tool.enabled = nextEnabled;
        if (nextEnabled && s.status === "active") {
          if (tool.isVirtual) {
            registerVirtualTools(s);
          } else {
            mcpToolRegistry.set(tool.key, {
              serverId: s.id,
              serverName: s.name,
              rawName: tool.rawName,
              postEndpoint: s.postEndpoint,
              headers: s.headers
            });
          }
        } else {
          mcpToolRegistry.delete(tool.key);
        }
        await saveServerToStorage();
        sendJson(response, 200, { success: true, enabled: tool.enabled });
        return;
      }

      const matchStart = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
      if (request.method === "POST" && matchStart) {
        const id = decodeURIComponent(matchStart[1]);
        const s = mcpServers.get(id);
        if (!s) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        s.status = "active";
        registerVirtualTools(s);
        for (const t of s.tools) {
          if (t.enabled !== false && !t.isVirtual) {
            mcpToolRegistry.set(t.key, {
              serverId: s.id,
              serverName: s.name,
              rawName: t.rawName,
              postEndpoint: s.postEndpoint,
              headers: s.headers
            });
          }
        }
        await saveServerToStorage();
        sendJson(response, 200, { success: true, status: "active" });
        return;
      }

      const matchStop = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/stop$/);
      if (request.method === "POST" && matchStop) {
        const id = decodeURIComponent(matchStop[1]);
        const s = mcpServers.get(id);
        if (!s) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        s.status = "disabled";
        for (const [key, val] of mcpToolRegistry.entries()) {
          if (val.serverId === id) {
            mcpToolRegistry.delete(key);
          }
        }
        await saveServerToStorage();
        sendJson(response, 200, { success: true, status: "disabled" });
        return;
      }

      const matchDelete = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
      if (request.method === "DELETE" && matchDelete) {
        const id = decodeURIComponent(matchDelete[1]);
        mcpServers.delete(id);
        for (const [key, val] of mcpToolRegistry.entries()) {
          if (val.serverId === id) {
            mcpToolRegistry.delete(key);
          }
        }
        await deleteServerFromStorage();
        sendJson(response, 200, { success: true });
        return;
      }
    }

    const geminiMatch = reqUrl.pathname.match(/^\/(?:v1|v1beta)\/models\/(.+):(generateContent|streamGenerateContent)$/);
    if (geminiMatch) {
      if (!isProxyAuthorized(request)) {
        const authHeader = request.headers.authorization || request.headers["x-goog-api-key"] || reqUrl.searchParams.get("key") || "无凭证";
        sendOpenAIError(response, 401, "API Key 错误", "authentication_error", {
          path: reqUrl.pathname,
          method: request.method,
          clientIp: request.headers["x-forwarded-for"] || request.socket.remoteAddress,
          receivedAuth: authHeader.length > 20 ? authHeader.slice(0, 15) + "..." : authHeader
        });
        return;
      }

      if (!getActiveChannel()) {
        sendOpenAIError(response, 500, "服务端未配置上游渠道环境变量，请配置 UPSTREAM_1 等变量");
        return;
      }

      const rawModel = geminiMatch[1];
      const modelName = decodeURIComponent(rawModel).replace(/^models\//, "");
      const action = geminiMatch[2];
      const isStream = action === "streamGenerateContent" || reqUrl.searchParams.get("alt") === "sse";
      const body = await readRequestBody(request);

      const abortController = new AbortController();
      let clientDisconnectedLogged = false;
      const onClientClose = () => {
        if (!response.writableEnded && !abortController.signal.aborted) {
          if (!clientDisconnectedLogged) {
            clientDisconnectedLogged = true;
            addDebugLog("DOWNSTREAM", `[连接断开] 客户端已主动断开连接 / 取消请求`);
          }
          abortController.abort();
        }
      };
      request.on("close", onClientClose);
      response.on("close", onClientClose);

      try {
        await handleGeminiGenerateContent(modelName, isStream, body, response, { ip: request.socket.remoteAddress }, abortController.signal);
      } finally {
        request.off("close", onClientClose);
        response.off("close", onClientClose);
      }
      return;
    }

    if (reqUrl.pathname.startsWith("/v1/")) {
      if (!isProxyAuthorized(request)) {
        const authHeader = request.headers.authorization || "无 Authorization 请求头";
        const clientIp = request.headers["x-forwarded-for"] || request.socket.remoteAddress;
        sendOpenAIError(response, 401, "API Key 错误", "authentication_error", {
          path: reqUrl.pathname,
          method: request.method,
          clientIp,
          receivedAuth: authHeader.length > 20 ? authHeader.slice(0, 15) + "..." : authHeader
        });
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/v1/models") {
        const channel = getActiveChannel();
        if (!channel) {
          sendJson(response, 200, {
            object: "list",
            data: [{ id: "default", object: "model", created: 0, owned_by: "proxy" }]
          });
          return;
        }

        const modelsUrl = upstreamModelsUrl(channel);

        try {
          const upstreamResponse = await fetch(modelsUrl, {
            headers: { Authorization: `Bearer ${channel.apiKey}` },
            signal: AbortSignal.timeout(20000)
          });
          const data = await upstreamResponse.json();
          sendJson(response, 200, data);
        } catch {
          sendJson(response, 200, {
            object: "list",
            data: [{ id: "default", object: "model", created: 0, owned_by: "proxy" }]
          });
        }
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/v1/chat/completions") {
        const channel = getActiveChannel();
        if (!channel) {
          sendOpenAIError(response, 500, "服务端未配置上游渠道环境变量，请配置 UPSTREAM_1 等变量");
          return;
        }

        const body = await readRequestBody(request);
        const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
        const lastMsgText = typeof lastMsg?.content === "string"
          ? lastMsg.content
          : (Array.isArray(lastMsg?.content) ? lastMsg.content.map((c) => c.text || "").join(" ") : "");
        const mcpEnabled = isModelEnabledForMcp(body.model) && mcpToolRegistry.size > 0 && !isTitleGenerationRequest(lastMsgText);

        addDebugLog("DOWNSTREAM", `收到客户端请求 [${body.model || "default"}] -> 渠道 [${channel.name}] - stream=${body.stream === true}`, {
          channel: channel.name,
          model: body.model,
          stream: body.stream,
          mcpEnabled,
          messagesCount: body.messages?.length || 0,
          lastUserMessagePreview: lastMsgText ? lastMsgText.slice(0, 300) : "非文本内容"
        });

        const abortController = new AbortController();
        let clientDisconnectedLogged = false;
        const onClientClose = () => {
          if (!response.writableEnded && !abortController.signal.aborted) {
            if (!clientDisconnectedLogged) {
              clientDisconnectedLogged = true;
              addDebugLog("DOWNSTREAM", `[连接断开] 客户端已主动断开连接 / 取消请求`);
            }
            abortController.abort();
          }
        };
        request.on("close", onClientClose);
        response.on("close", onClientClose);

        try {
          if (mcpEnabled) {
            await runAgent(body, response, { ip: request.socket.remoteAddress }, abortController.signal);
          } else {
            await passThrough(body, response, { ip: request.socket.remoteAddress }, abortController.signal);
          }
        } finally {
          request.off("close", onClientClose);
          response.off("close", onClientClose);
        }
        return;
      }
    }

    sendOpenAIError(response, 404, "接口不存在");
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    addDebugLog("ERROR", `全局服务未捕获异常: ${err.message}`, err.stack || err);
    if (response.headersSent) {
      try {
        const errChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          choices: [
            {
              index: 0,
              delta: { content: `\n\n[代理服务错误]: ${err instanceof Error ? err.message : "未知错误"}` },
              finish_reason: "stop"
            }
          ]
        };
        response.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      } catch {}
      return;
    }

    sendJson(response, 500, { error: err.message });
  }
});

server.keepAliveTimeout = 1800000;
server.requestTimeout = 1800000;
server.headersTimeout = 1800000;

server.listen(PORT, "0.0.0.0");
