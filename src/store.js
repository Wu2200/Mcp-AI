import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..");

export const PORT = Number(process.env.PORT || 10000);
export const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();
export const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();
export const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

export const DATA_FILE = path.join(PROJECT_ROOT, "mcp-config.json");
export const SETTINGS_FILE = path.join(PROJECT_ROOT, "mcp-settings.json");

export const mcpServers = new Map();
export const mcpToolRegistry = new Map();
export const enabledModels = new Set();

export const upstreamChannels = [];
export let activeChannelId = "";
export function setActiveChannelId(id) {
  activeChannelId = id;
}

export let loggingEnabled = true;
export function setLoggingEnabled(enabled) {
  loggingEnabled = enabled;
}
export const MAX_LOGS = 1000;
export const debugLogs = [];

export function addDebugLog(type, summary, detail = "") {
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

export let dbPool = null;
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

export async function initDatabase() {
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

export async function getStorageItem(key) {
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

export async function setStorageItem(key, val) {
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
export function getGroupDefaultName(index) {
  const num = index + 1;
  if (num <= 10) return `第${chineseNums[index]}组`;
  return `第${num}组`;
}

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function parseSingleChannelValue(rawVal, defaultName, id, envKey) {
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

export function loadUpstreamChannelsFromEnv() {
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

export function getActiveChannel() {
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

export function generateSessionToken() {
  const payload = `auth:${PANEL_PASSWORD}:${Date.now()}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifySessionToken(token) {
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

export function parseCookies(request) {
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

export async function saveSettingsToStorage() {
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

export async function saveLoggingConfigToStorage(enabled) {
  loggingEnabled = enabled;
  await saveSettingsToStorage();
}

export async function saveEnabledModelsToStorage(modelsArray) {
  enabledModels.clear();
  for (const m of modelsArray) {
    enabledModels.add(m);
  }
  await saveSettingsToStorage();
}

export async function saveActiveChannelToStorage(channelId) {
  activeChannelId = channelId;
  await saveSettingsToStorage();
}

export async function loadSettingsFromStorage() {
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
      enabledModels.clear();
      for (const m of data.enabledModels) {
        enabledModels.add(m);
      }
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

export async function getStoredServers() {
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
  return Array.isArray(list) ? list : [];
}

export async function saveServerToStorage() {
  const data = Array.from(mcpServers.values());
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
  if (dbPool) {
    await setStorageItem("servers", data);
  }
}

export async function deleteServerFromStorage() {
  const data = Array.from(mcpServers.values());
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
  if (dbPool) {
    await setStorageItem("servers", data);
  }
}

export function setCorsHeaders(response) {
  if (response.headersSent) return;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
}

export function sendJson(response, statusCode, body) {
  if (response.headersSent) return;
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

export function sendOpenAIError(response, statusCode, message, type = "invalid_request_error", extraInfo = {}) {
  addDebugLog("ERROR", `返回客户端错误 (${statusCode}): ${message}`, { statusCode, message, type, ...extraInfo });
  sendJson(response, statusCode, { error: { message, type, code: null } });
}

export function isProxyAuthorized(request) {
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

export function isPanelAuthorized(request) {
  if (!PANEL_PASSWORD) return true;
  const cookies = parseCookies(request);
  if (verifySessionToken(cookies.panel_auth)) return true;
  const headerToken = (request.headers["x-panel-password"] || "").trim();
  return headerToken === PANEL_PASSWORD;
}

export function readRequestBody(request) {
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

export function upstreamChatCompletionsUrl(channel) {
  const active = channel || getActiveChannel();
  if (!active || !active.baseUrl) {
    throw new Error("未配置上游渠道环境变量");
  }
  const base = active.baseUrl;
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function upstreamModelsUrl(channel) {
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
