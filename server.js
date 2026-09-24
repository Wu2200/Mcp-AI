import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
const UPSTREAM_API_KEY = (process.env.UPSTREAM_API_KEY || "").trim();
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

const DATA_FILE = path.join(__dirname, "mcp-config.json");
const SETTINGS_FILE = path.join(__dirname, "mcp-settings.json");

const mcpServers = new Map();
const mcpToolRegistry = new Map();
let enabledModels = new Set();
let loggingEnabled = true;

const recentLogs = [];
const MAX_LOG_COUNT = 300;

function appendLog(level, tag, message, data = null) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const entry = {
    id: Date.now() + Math.random(),
    time,
    level,
    tag,
    message,
    data: data ? (typeof data === "string" ? data : JSON.stringify(data, null, 2)) : null
  };
  console.log(`[${time}] [${tag}] ${message}`, data ? JSON.stringify(data) : "");
  if (loggingEnabled) {
    recentLogs.push(entry);
    if (recentLogs.length > MAX_LOG_COUNT) {
      recentLogs.shift();
    }
  }
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

let pgPool = null;

async function initDatabase() {
  if (!DATABASE_URL) return;
  try {
    const { default: pg } = await import("pg");
    pgPool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    pgPool.on("error", () => {});
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        raw_token TEXT,
        status TEXT DEFAULT 'active',
        post_endpoint TEXT,
        headers JSONB,
        tool_count INT,
        tools JSONB,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS mcp_settings (
        key TEXT PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch {
    pgPool = null;
  }
}

async function saveLoggingConfigToStorage(enabled) {
  loggingEnabled = enabled;
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO mcp_settings (key, value, updated_at)
         VALUES ('logging_enabled', $1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           updated_at = CURRENT_TIMESTAMP`,
        [JSON.stringify(enabled)]
      );
    } catch {}
  }
  try {
    let current = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        current = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      } catch {}
    }
    current.loggingEnabled = enabled;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2), "utf8");
  } catch {}
}

async function saveEnabledModelsToStorage(modelsArray) {
  enabledModels = new Set(modelsArray);
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO mcp_settings (key, value, updated_at)
         VALUES ('enabled_models', $1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           updated_at = CURRENT_TIMESTAMP`,
        [JSON.stringify(modelsArray)]
      );
    } catch {}
  }
  try {
    let current = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        current = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      } catch {}
    }
    current.enabledModels = modelsArray;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2), "utf8");
  } catch {}
}

async function loadSettingsFromStorage() {
  if (pgPool) {
    try {
      const res = await pgPool.query("SELECT key, value FROM mcp_settings WHERE key IN ('enabled_models', 'logging_enabled')");
      if (res.rows && res.rows.length > 0) {
        for (const r of res.rows) {
          if (r.key === "enabled_models") {
            const list = Array.isArray(r.value) ? r.value : (typeof r.value === "string" ? JSON.parse(r.value) : []);
            enabledModels = new Set(list);
          } else if (r.key === "logging_enabled") {
            loggingEnabled = r.value !== false && r.value !== "false";
          }
        }
        return;
      }
    } catch {}
  }

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.enabledModels)) {
        enabledModels = new Set(data.enabledModels);
      }
      if (data.loggingEnabled !== undefined) {
        loggingEnabled = data.loggingEnabled === true;
      }
    } catch {}
  }
}

async function saveServerToStorage(serverItem) {
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO mcp_servers (id, name, url, raw_token, status, post_endpoint, headers, tool_count, tools, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           url = EXCLUDED.url,
           raw_token = EXCLUDED.raw_token,
           status = EXCLUDED.status,
           post_endpoint = EXCLUDED.post_endpoint,
           headers = EXCLUDED.headers,
           tool_count = EXCLUDED.tool_count,
           tools = EXCLUDED.tools,
           updated_at = CURRENT_TIMESTAMP`,
        [
          serverItem.id,
          serverItem.name,
          serverItem.url,
          serverItem.rawToken,
          serverItem.status || "active",
          serverItem.postEndpoint,
          JSON.stringify(serverItem.headers || {}),
          serverItem.toolCount,
          JSON.stringify(serverItem.tools || [])
        ]
      );
    } catch {}
  }
  try {
    const data = Array.from(mcpServers.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

async function deleteServerFromStorage(id) {
  if (pgPool) {
    try {
      await pgPool.query("DELETE FROM mcp_servers WHERE id = $1", [id]);
    } catch {}
  }
  try {
    const data = Array.from(mcpServers.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

async function loadConfigFromStorage() {
  if (pgPool) {
    try {
      const res = await pgPool.query("SELECT * FROM mcp_servers ORDER BY updated_at ASC");
      if (res.rows && res.rows.length > 0) {
        for (const row of res.rows) {
          const tools = typeof row.tools === "string" ? JSON.parse(row.tools) : (row.tools || []);
          const headers = typeof row.headers === "string" ? JSON.parse(row.headers) : (row.headers || {});
          const status = row.status || "active";
          const serverInfo = {
            id: row.id,
            name: row.name,
            url: row.url,
            rawToken: row.raw_token,
            status,
            postEndpoint: row.post_endpoint,
            headers,
            toolCount: tools.length,
            tools
          };
          mcpServers.set(row.id, serverInfo);
          if (status === "active") {
            for (const t of tools) {
              mcpToolRegistry.set(t.key, {
                serverId: row.id,
                serverName: row.name,
                rawName: t.rawName,
                postEndpoint: row.post_endpoint,
                headers
              });
            }
          }
        }
        return;
      }
    } catch {}
  }

  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const list = JSON.parse(raw);
    for (const item of list) {
      const status = item.status || "active";
      item.status = status;
      mcpServers.set(item.id, item);
      if (status === "active") {
        for (const t of item.tools) {
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
  } catch {}
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function sendJson(response, statusCode, body) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendOpenAIError(response, statusCode, message, type = "invalid_request_error") {
  sendJson(response, statusCode, { error: { message, type, code: null } });
}

function isProxyAuthorized(request, reqUrl) {
  if (!PROXY_API_KEY) return true;
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : authorization.trim();
  if (token === PROXY_API_KEY) return true;

  const googApiKey = (request.headers["x-goog-api-key"] || "").trim();
  if (googApiKey === PROXY_API_KEY) return true;

  if (reqUrl) {
    const queryKey = (reqUrl.searchParams.get("key") || "").trim();
    if (queryKey === PROXY_API_KEY) return true;
  }
  return false;
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
      signal: AbortSignal.timeout(8000)
    });

    await fetch(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }),
      signal: AbortSignal.timeout(5000)
    }).catch(() => {});
  } catch {}

  const listPayload = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const listRes = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(10000)
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

  mcpServers.set(serverId, serverInfo);
  await saveServerToStorage(serverInfo);
  appendLog("info", "MCP-INIT", `成功挂载 MCP: ${name}, 工具数量: ${registeredTools.length}`);
  return serverInfo;
}

function extractMcpResultContent(data) {
  if (!data) return "{}";
  if (typeof data === "string") return data;

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
      return pieces.join("\n\n");
    }
  }

  if (rawResult.content && rawResult.encoding === "base64" && typeof rawResult.content === "string") {
    try {
      return Buffer.from(rawResult.content, "base64").toString("utf8");
    } catch {}
  }

  return typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult, null, 2);
}

async function callMcpTool(toolKey, args) {
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

  const res = await fetch(info.postEndpoint, {
    method: "POST",
    headers: info.headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: info.rawName, arguments: args }
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`执行失败 (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = await parseMcpResponse(res);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  return extractMcpResultContent(data);
}

function getAllTools() {
  const tools = [];
  for (const s of mcpServers.values()) {
    if (s.status === "active") {
      for (const t of s.tools) tools.push(t.openAiTool);
    }
  }
  return tools;
}

function upstreamChatCompletionsUrl() {
  if (!UPSTREAM_BASE_URL) throw new Error("未配置 UPSTREAM_BASE_URL 环境变量");
  if (UPSTREAM_BASE_URL.endsWith("/chat/completions")) return UPSTREAM_BASE_URL;
  if (UPSTREAM_BASE_URL.endsWith("/v1")) return `${UPSTREAM_BASE_URL}/chat/completions`;
  return `${UPSTREAM_BASE_URL}/v1/chat/completions`;
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

function extractReasoningText(delta) {
  if (!delta) return "";
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  if (typeof delta.thought === "string") return delta.thought;
  if (delta.reasoning && typeof delta.reasoning.content === "string") return delta.reasoning.content;
  return "";
}

async function passThrough(requestBody, clientResponse) {
  appendLog("info", "PASS-THROUGH", `直通转发模型 [${requestBody.model}]`, {
    model: requestBody.model,
    reasoning_effort: requestBody.reasoning_effort,
    thinking: requestBody.thinking,
    generationConfig: requestBody.generationConfig,
    stream: requestBody.stream,
    incoming_keys: Object.keys(requestBody)
  });

  setCorsHeaders(clientResponse);
  const upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTREAM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300000)
  });

  appendLog("info", "PASS-THROUGH", `上游响应状态码: ${upstreamResponse.status}`);

  clientResponse.writeHead(upstreamResponse.status, {
    "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  if (upstreamResponse.body) {
    const reader = upstreamResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clientResponse.write(value);
    }
  }
  clientResponse.end();
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

async function runAgent(requestBody, clientResponse) {
  appendLog("info", "RUN-AGENT", `启动 MCP 调度 - 模型 [${requestBody.model}]`, {
    reasoning_effort: requestBody.reasoning_effort,
    thinking: requestBody.thinking,
    generationConfig: requestBody.generationConfig,
    incoming_keys: Object.keys(requestBody)
  });

  if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
    throw new Error("messages 必须是非空数组");
  }

  const isStream = requestBody.stream === true;
  let messages = [...requestBody.messages];

  const clientTools = Array.isArray(requestBody.tools)
    ? requestBody.tools.filter((t) => t && t.type === "function")
    : [];
  const mcpTools = getAllTools();
  const tools = [...clientTools, ...mcpTools];

  appendLog("info", "RUN-AGENT", `注入工具: MCP工具=${mcpTools.length}, 客户端工具=${clientTools.length}`);

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
      try {
        sendSSEChunk(clientResponse, {}, requestBody.model || "default");
      } catch {}
    }, 5000);
  }

  try {
    for (let round = 0; round < 100; round += 1) {
      const payload = {
        ...requestBody,
        messages,
        stream: isStream
      };

      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      appendLog("info", "RUN-AGENT", `第 ${round + 1} 轮请求上游`, {
        payload_keys: Object.keys(payload),
        has_tools: Boolean(payload.tools?.length)
      });

      const upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPSTREAM_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000)
      });

      appendLog("info", "RUN-AGENT", `第 ${round + 1} 轮上游状态: ${upstreamResponse.status}`);

      if (!upstreamResponse.ok) {
        const err = await upstreamResponse.text();
        appendLog("error", "RUN-AGENT", `第 ${round + 1} 轮上游错误: ${err}`);
        if (isStream) {
          const errorChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model || "default",
            choices: [
              {
                index: 0,
                delta: { content: `\n\n上游返回错误 (${upstreamResponse.status})：${err.slice(0, 500)}` },
                finish_reason: "stop"
              }
            ]
          };
          clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          clientResponse.write("data: [DONE]\n\n");
          clientResponse.end();
          return;
        }
        throw new Error(`上游接口返回错误 (${upstreamResponse.status})：${err.slice(0, 500)}`);
      }

      if (!isStream) {
        const json = await upstreamResponse.json();
        const message = json.choices?.[0]?.message;
        const toolCalls = message?.tool_calls || [];
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
          sendJson(clientResponse, 200, json);
          return;
        }

        messages.push(message);

        for (const tc of mcpCalls) {
          let toolInfo = mcpToolRegistry.get(tc.function.name);
          if (!toolInfo) {
            for (const [k, v] of mcpToolRegistry.entries()) {
              if (k.endsWith(tc.function.name) || tc.function.name.endsWith(v.rawName)) {
                toolInfo = v;
                break;
              }
            }
          }
          const args = toolArguments(tc);
          appendLog("info", "RUN-AGENT", `非流式执行工具: ${tc.function.name}`);
          let result;
          try {
            result = await callMcpTool(tc.function.name, args);
          } catch (err) {
            result = JSON.stringify({ error: err.message });
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: typeof result === "string" ? result : JSON.stringify(result)
          });
        }
        continue;
      }

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedToolCalls = [];
      let assistantContent = "";
      let hasToolCalls = false;

      while (true) {
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
            const delta = parsed.choices?.[0]?.delta;

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

            const reasoningPart = extractReasoningText(delta);
            if (reasoningPart) {
              clientResponse.write(`${line}\n\n`);
            } else if (delta?.content) {
              assistantContent += delta.content;
              if (!hasToolCalls) {
                clientResponse.write(`${line}\n\n`);
              }
            } else if (delta && !hasToolCalls) {
              clientResponse.write(`${line}\n\n`);
            }
          } catch {}
        }
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
        clientResponse.write("data: [DONE]\n\n");
        clientResponse.end();
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

      for (const tc of mcpCalls) {
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
        const args = toolArguments({ function: { arguments: tc.arguments } });

        appendLog("info", "RUN-AGENT", `触发执行工具: ${tc.name} (${displayName})`);

        sendReasoningChunk(
          clientResponse,
          `\n> 正在执行 ${displayName} [${rawAction}]...\n`,
          requestBody.model
        );

        let result;
        if (args === null) {
          result = JSON.stringify({ error: "Invalid tool arguments" });
        } else {
          try {
            result = await callMcpTool(tc.name, args);
          } catch (err) {
            result = JSON.stringify({ error: err instanceof Error ? err.message : "Tool execution failed" });
          }
        }

        sendReasoningChunk(
          clientResponse,
          `> ${displayName} [${rawAction}] 完成\n\n`,
          requestBody.model
        );

        messages.push({
          role: "tool",
          tool_call_id: tc.id || `call_${crypto.randomUUID()}`,
          content: typeof result === "string" ? result : JSON.stringify(result)
        });
      }
    }

    throw new Error("工具调用轮数达到上限");
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
  }
}

function convertGeminiToOpenAiRequest(geminiBody, modelName, isStream) {
  const messages = [];

  if (geminiBody.systemInstruction?.parts) {
    const sysText = geminiBody.systemInstruction.parts
      .map((p) => p.text || "")
      .filter(Boolean)
      .join("\n");
    if (sysText) {
      messages.push({ role: "system", content: sysText });
    }
  }

  if (Array.isArray(geminiBody.contents)) {
    for (const c of geminiBody.contents) {
      const role = c.role === "model" ? "assistant" : (c.role === "function" ? "tool" : "user");
      if (!Array.isArray(c.parts)) continue;

      const textParts = [];
      const contentArray = [];
      let hasMultiModal = false;

      for (const p of c.parts) {
        if (p.text) {
          textParts.push(p.text);
          contentArray.push({ type: "text", text: p.text });
        } else if (p.inlineData && p.inlineData.data) {
          hasMultiModal = true;
          const mimeType = p.inlineData.mimeType || "image/jpeg";
          contentArray.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${p.inlineData.data}` }
          });
        } else if (p.functionCall) {
          messages.push({
            role: "assistant",
            tool_calls: [
              {
                id: `call_${crypto.randomUUID()}`,
                type: "function",
                function: {
                  name: p.functionCall.name,
                  arguments: JSON.stringify(p.functionCall.args || {})
                }
              }
            ]
          });
        } else if (p.functionResponse) {
          messages.push({
            role: "tool",
            tool_call_id: `call_${crypto.randomUUID()}`,
            content: JSON.stringify(p.functionResponse.response || {})
          });
        }
      }

      if (textParts.length > 0 || hasMultiModal) {
        if (hasMultiModal) {
          messages.push({ role, content: contentArray });
        } else {
          messages.push({ role, content: textParts.join("\n") });
        }
      }
    }
  }

  const openAiBody = {
    ...geminiBody,
    model: modelName,
    messages,
    stream: isStream
  };
  delete openAiBody.contents;
  delete openAiBody.systemInstruction;
  delete openAiBody.generationConfig;

  // 保留原始 generationConfig，以便 cliproxyapi / 上游原生解析
  if (geminiBody.generationConfig) {
    openAiBody.generationConfig = geminiBody.generationConfig;
    const gc = geminiBody.generationConfig;
    if (gc.temperature !== undefined) openAiBody.temperature = gc.temperature;
    if (gc.maxOutputTokens !== undefined) openAiBody.max_tokens = gc.maxOutputTokens;
    if (gc.topP !== undefined) openAiBody.top_p = gc.topP;
    if (gc.stopSequences && Array.isArray(gc.stopSequences)) openAiBody.stop = gc.stopSequences;
    
    // 如果有 thinkingConfig，同时填充 OpenAI 标准 reasoning_effort 及 thinking 字段
    if (gc.thinkingConfig) {
      openAiBody.thinkingConfig = gc.thinkingConfig;
      const tb = Number(gc.thinkingConfig.thinkingBudget);
      if (tb === 0) {
        openAiBody.reasoning_effort = "none";
        openAiBody.thinking = { type: "disabled" };
      } else if (tb > 0) {
        openAiBody.thinking = { type: "enabled", budget_tokens: tb };
        if (tb > 8192) openAiBody.reasoning_effort = "high";
        else if (tb > 2048) openAiBody.reasoning_effort = "medium";
        else openAiBody.reasoning_effort = "low";
      }
    }
  }

  return openAiBody;
}

function convertOpenAiToGeminiResponse(openAiJson, modelName) {
  const choice = openAiJson.choices?.[0];
  const parts = [];
  const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || choice?.message?.thought;
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }

  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    for (const tc of choice.message.tool_calls) {
      let args = {};
      try {
        args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
      } catch {}
      parts.push({
        functionCall: {
          name: tc.function?.name || "",
          args
        }
      });
    }
  } else if (choice?.message?.content) {
    parts.push({ text: choice.message.content });
  }

  const finishReason = choice?.finish_reason;
  let geminiFinishReason = "STOP";
  if (finishReason === "length") geminiFinishReason = "MAX_TOKENS";
  if (finishReason === "tool_calls") geminiFinishReason = "STOP";

  return {
    candidates: [
      {
        content: {
          parts,
          role: "model"
        },
        finishReason: geminiFinishReason,
        index: 0
      }
    ],
    usageMetadata: {
      promptTokenCount: openAiJson.usage?.prompt_tokens || 0,
      candidatesTokenCount: openAiJson.usage?.completion_tokens || 0,
      totalTokenCount: openAiJson.usage?.total_tokens || 0
    },
    modelVersion: modelName
  };
}

function createGeminiStreamAdapter(clientResponse, modelName) {
  setCorsHeaders(clientResponse);
  clientResponse.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  let buffer = "";
  let insideThoughtBlock = false;

  return {
    headersSent: true,
    setHeader(name, value) {
      try {
        clientResponse.setHeader(name, value);
      } catch {}
    },
    writeHead(code, headers) {},
    write(chunk) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          const finishChunk = {
            candidates: [
              {
                content: { parts: [], role: "model" },
                finishReason: "STOP",
                index: 0
              }
            ],
            modelVersion: modelName
          };
          clientResponse.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          continue;
        }

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          const finishReason = parsed.choices?.[0]?.finish_reason;
          const parts = [];

          const reasoningPart = extractReasoningText(delta);
          if (reasoningPart) {
            parts.push({
              text: reasoningPart,
              thought: true
            });
          }

          if (delta?.tool_calls) {
            continue;
          }

          if (delta?.content) {
            let contentText = delta.content;

            if (!insideThoughtBlock && contentText.includes("<thought>")) {
              const [before, after] = contentText.split("<thought>");
              if (before) parts.push({ text: before });
              insideThoughtBlock = true;
              contentText = after || "";
            }

            if (insideThoughtBlock) {
              if (contentText.includes("</thought>")) {
                const [thoughtPart, remaining] = contentText.split("</thought>");
                if (thoughtPart) parts.push({ text: thoughtPart, thought: true });
                insideThoughtBlock = false;
                if (remaining) parts.push({ text: remaining });
              } else {
                if (contentText) parts.push({ text: contentText, thought: true });
              }
            } else {
              if (contentText) parts.push({ text: contentText });
            }
          }

          if (parts.length > 0 || finishReason) {
            const geminiChunk = {
              candidates: [
                {
                  content: {
                    parts,
                    role: "model"
                  },
                  finishReason: finishReason === "length" ? "MAX_TOKENS" : (finishReason ? "STOP" : undefined),
                  index: 0
                }
              ],
              modelVersion: modelName
            };
            clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
          }
        } catch {}
      }
      return true;
    },
    end(chunk) {
      if (chunk) {
        this.write(chunk);
      }
      clientResponse.end();
    }
  };
}

function createGeminiNonStreamAdapter(clientResponse, modelName) {
  let accumulatedBody = "";
  let statusCode = 200;

  return {
    headersSent: false,
    setHeader(name, value) {
      setCorsHeaders(clientResponse);
    },
    writeHead(code, headers) {
      statusCode = code;
    },
    write(chunk) {
      accumulatedBody += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      return true;
    },
    end(chunk) {
      if (chunk) accumulatedBody += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      try {
        const openAiJson = JSON.parse(accumulatedBody);
        if (openAiJson.error) {
          sendJson(clientResponse, statusCode, {
            error: {
              code: statusCode,
              message: openAiJson.error.message || "Request failed",
              status: "INVALID_ARGUMENT"
            }
          });
          return;
        }
        const geminiJson = convertOpenAiToGeminiResponse(openAiJson, modelName);
        sendJson(clientResponse, 200, geminiJson);
      } catch (e) {
        sendJson(clientResponse, statusCode, {
          error: { code: statusCode, message: accumulatedBody || e.message, status: "INTERNAL" }
        });
      }
    }
  };
}

function getLoginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP 控制台 - 登录认证</title>
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

function resolveUpstreamBase() {
  return UPSTREAM_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function handleGeminiNativePassThrough(reqUrl, request, response, customBody) {
  setCorsHeaders(response);
  const upstreamBase = resolveUpstreamBase();
  const targetUrl = `${upstreamBase}${reqUrl.pathname}${reqUrl.search}`;

  appendLog("info", "GEMINI-PASS", `原生直通 Gemini 上游: ${reqUrl.pathname}`);

  const headers = {
    "Content-Type": request.headers["content-type"] || "application/json"
  };
  if (UPSTREAM_API_KEY) {
    headers["Authorization"] = `Bearer ${UPSTREAM_API_KEY}`;
    headers["x-goog-api-key"] = UPSTREAM_API_KEY;
  }

  const upstreamRes = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: customBody ? JSON.stringify(customBody) : (["POST", "PUT", "PATCH"].includes(request.method) ? request : undefined),
    duplex: "half",
    signal: AbortSignal.timeout(300000)
  });

  if (!upstreamRes.ok) {
    throw new Error(`Upstream Gemini endpoint status ${upstreamRes.status}`);
  }

  response.writeHead(upstreamRes.status, {
    "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  if (upstreamRes.body) {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
  }
  response.end();
}

await initDatabase();
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

    if (request.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "")) {
      setCorsHeaders(response);
      if (PANEL_PASSWORD) {
        const cookies = parseCookies(request);
        if (!verifySessionToken(cookies.panel_auth)) {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(getLoginHtml());
          return;
        }
      }
      const htmlPath = path.join(__dirname, "dashboard.html");
      const htmlContent = fs.readFileSync(htmlPath, "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(htmlContent);
      return;
    }

    if (request.method === "GET" && reqUrl.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
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

      if (request.method === "GET" && reqUrl.pathname === "/api/logs") {
        sendJson(response, 200, {
          enabled: loggingEnabled,
          logs: recentLogs
        });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/logs/toggle") {
        const body = await readRequestBody(request);
        const enabled = Boolean(body.enabled);
        await saveLoggingConfigToStorage(enabled);
        if (!enabled) {
          recentLogs.length = 0;
        }
        sendJson(response, 200, { success: true, enabled: loggingEnabled });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/logs/clear") {
        recentLogs.length = 0;
        sendJson(response, 200, { success: true });
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
        if (!UPSTREAM_BASE_URL || !UPSTREAM_API_KEY) {
          sendJson(response, 200, { models: [] });
          return;
        }
        const modelsUrl = UPSTREAM_BASE_URL.endsWith("/v1")
          ? `${UPSTREAM_BASE_URL}/models`
          : `${UPSTREAM_BASE_URL}/v1/models`;

        try {
          const upstreamResponse = await fetch(modelsUrl, {
            headers: { Authorization: `Bearer ${UPSTREAM_API_KEY}` },
            signal: AbortSignal.timeout(10000)
          });
          const data = await upstreamResponse.json();
          const list = Array.isArray(data.data) ? data.data.map(m => m.id).filter(Boolean) : [];
          sendJson(response, 200, { models: list });
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

      const matchStart = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
      if (request.method === "POST" && matchStart) {
        const id = decodeURIComponent(matchStart[1]);
        const s = mcpServers.get(id);
        if (!s) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        s.status = "active";
        for (const t of s.tools) {
          mcpToolRegistry.set(t.key, {
            serverId: s.id,
            serverName: s.name,
            rawName: t.rawName,
            postEndpoint: s.postEndpoint,
            headers: s.headers
          });
        }
        await saveServerToStorage(s);
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
        await saveServerToStorage(s);
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
        await deleteServerFromStorage(id);
        sendJson(response, 200, { success: true });
        return;
      }
    }

    if (!isProxyAuthorized(request, reqUrl)) {
      if (
        reqUrl.pathname.startsWith("/v1beta/") ||
        reqUrl.pathname.includes(":generateContent") ||
        reqUrl.pathname.includes(":streamGenerateContent")
      ) {
        sendJson(response, 401, {
          error: { code: 401, message: "API key not valid", status: "UNAUTHENTICATED" }
        });
      } else {
        sendOpenAIError(response, 401, "API Key 错误", "authentication_error");
      }
      return;
    }

    if (
      request.method === "GET" &&
      (reqUrl.pathname === "/v1beta/models" ||
        (reqUrl.pathname === "/v1/models" &&
          (request.headers["x-goog-api-key"] || reqUrl.searchParams.has("key"))))
    ) {
      try {
        await handleGeminiNativePassThrough(reqUrl, request, response);
        return;
      } catch {}

      let modelList = [];
      if (UPSTREAM_BASE_URL && UPSTREAM_API_KEY) {
        const modelsUrl = UPSTREAM_BASE_URL.endsWith("/v1")
          ? `${UPSTREAM_BASE_URL}/models`
          : `${UPSTREAM_BASE_URL}/v1/models`;

        try {
          const upstreamResponse = await fetch(modelsUrl, {
            headers: { Authorization: `Bearer ${UPSTREAM_API_KEY}` },
            signal: AbortSignal.timeout(10000)
          });
          const data = await upstreamResponse.json();
          if (Array.isArray(data.data)) {
            modelList = data.data.map((m) => m.id).filter(Boolean);
          }
        } catch {}
      }
      if (modelList.length === 0) {
        modelList = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro", "gemini-1.5-flash", "default"];
      }

      const geminiModels = modelList.map((id) => ({
        name: id.startsWith("models/") ? id : `models/${id}`,
        version: "1.0",
        displayName: id.replace(/^models\//, ""),
        description: `Model ${id} via Mcp-AI Proxy`,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"]
      }));

      sendJson(response, 200, { models: geminiModels });
      return;
    }

    const countTokensMatch = reqUrl.pathname.match(/^\/(?:v1beta|v1)\/models\/([^:]+):countTokens$/);
    if (request.method === "POST" && countTokensMatch) {
      try {
        await handleGeminiNativePassThrough(reqUrl, request, response);
        return;
      } catch {
        sendJson(response, 200, { totalTokens: 100 });
        return;
      }
    }

    const geminiModelMatch = reqUrl.pathname.match(/^\/(?:v1beta|v1)\/models\/([^:/]+)$/);
    if (request.method === "GET" && geminiModelMatch) {
      try {
        await handleGeminiNativePassThrough(reqUrl, request, response);
        return;
      } catch {
        const modelId = decodeURIComponent(geminiModelMatch[1]);
        sendJson(response, 200, {
          name: `models/${modelId}`,
          version: "1.0",
          displayName: modelId,
          description: `Model ${modelId} via Mcp-AI Proxy`,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"]
        });
        return;
      }
    }

    const geminiMatch = reqUrl.pathname.match(
      /^\/(?:v1beta|v1)\/models\/([^:]+):(generateContent|streamGenerateContent)$/
    );
    if (request.method === "POST" && geminiMatch) {
      if (!UPSTREAM_BASE_URL || !UPSTREAM_API_KEY) {
        sendJson(response, 500, {
          error: {
            code: 500,
            message: "服务端未配置环境变量：UPSTREAM_BASE_URL 或 UPSTREAM_API_KEY",
            status: "INTERNAL"
          }
        });
        return;
      }

      const rawModel = decodeURIComponent(geminiMatch[1]);
      const modelName = rawModel.replace(/^models\//, "");
      const action = geminiMatch[2];
      const isStream = action === "streamGenerateContent";
      const geminiBody = await readRequestBody(request);

      appendLog("info", "GEMINI-INCOMING", `接收 Gemini 请求 [${modelName}], stream=${isStream}`, {
        modelName,
        isStream,
        mcpEnabled: isModelEnabledForMcp(modelName),
        generationConfig: geminiBody.generationConfig
      });

      if (!isModelEnabledForMcp(modelName) || mcpToolRegistry.size === 0) {
        try {
          await handleGeminiNativePassThrough(reqUrl, request, response, geminiBody);
          return;
        } catch {}
      }

      const openAiBody = convertGeminiToOpenAiRequest(geminiBody, modelName, isStream);

      const targetAdapter = isStream
        ? createGeminiStreamAdapter(response, modelName)
        : createGeminiNonStreamAdapter(response, modelName);

      if (isModelEnabledForMcp(modelName) && mcpToolRegistry.size > 0) {
        await runAgent(openAiBody, targetAdapter);
      } else {
        await passThrough(openAiBody, targetAdapter);
      }
      return;
    }

    if (request.method === "GET" && reqUrl.pathname === "/v1/models") {
      if (!UPSTREAM_BASE_URL || !UPSTREAM_API_KEY) {
        sendJson(response, 200, {
          object: "list",
          data: [{ id: "default", object: "model", created: 0, owned_by: "proxy" }]
        });
        return;
      }

      const modelsUrl = UPSTREAM_BASE_URL.endsWith("/v1")
        ? `${UPSTREAM_BASE_URL}/models`
        : `${UPSTREAM_BASE_URL}/v1/models`;

      try {
        const upstreamResponse = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${UPSTREAM_API_KEY}` },
          signal: AbortSignal.timeout(10000)
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
      if (!UPSTREAM_BASE_URL || !UPSTREAM_API_KEY) {
        sendOpenAIError(response, 500, "服务端未配置环境变量：UPSTREAM_BASE_URL 或 UPSTREAM_API_KEY");
        return;
      }

      const body = await readRequestBody(request);

      appendLog("info", "CHAT-INCOMING", `接收客户端调用 [${body.model}]`, {
        model: body.model,
        reasoning_effort: body.reasoning_effort,
        thinking: body.thinking,
        stream: body.stream,
        keys: Object.keys(body)
      });

      if (isModelEnabledForMcp(body.model) && mcpToolRegistry.size > 0) {
        await runAgent(body, response);
      } else {
        await passThrough(body, response);
      }
      return;
    }

    sendOpenAIError(response, 404, "接口不存在");
  } catch (err) {
    appendLog("error", "SERVER-ERROR", err.message, err.stack);
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

server.keepAliveTimeout = 600000;
server.requestTimeout = 600000;
server.headersTimeout = 600000;

server.listen(PORT, "0.0.0.0");
