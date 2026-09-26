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
  addDebugLog("TOOL", `成功挂载 MCP 服务: ${name}`, { serverId, url: cleanUrl, toolCount: registeredTools.length });
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

  const startTime = Date.now();
  const res = await fetch(info.postEndpoint, {
    method: "POST",
    headers: info.headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: info.rawName, arguments: args }
    })
  });

  const duration = Date.now() - startTime;
  if (!res.ok) {
    const txt = await res.text();
    addDebugLog("ERROR", `MCP 工具 [${toolKey}] 执行失败 (${res.status}) - 耗时 ${duration}ms`, { error: txt });
    throw new Error(`执行失败 (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = await parseMcpResponse(res);
  if (data.error) {
    addDebugLog("ERROR", `MCP 工具 [${toolKey}] 报错 - 耗时 ${duration}ms`, data.error);
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const resultText = extractMcpResultContent(data);
  addDebugLog("TOOL", `MCP 工具 [${toolKey}] 执行成功 - 耗时 ${duration}ms, 输出 ${resultText.length} 字符`, {
    arguments: args,
    outputPreview: resultText.slice(0, 500)
  });
  return resultText;
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
  if (parsedChunkOrJson.finishReason) return parsedChunkOrJson.finishReason;
  if (parsedChunkOrJson.status === "incomplete" && parsedChunkOrJson.incomplete_details?.reason) {
    return parsedChunkOrJson.incomplete_details.reason;
  }
  return null;
}

// 直通模式（全面支持未开 MCP 模型的自动抗截断断点续接）
async function passThrough(requestBody, clientResponse, reqMeta, abortSignal) {
  const startTime = Date.now();
  setCorsHeaders(clientResponse);
  const isStream = requestBody.stream === true;

  addDebugLog("UPSTREAM", `[直通模式] 转发请求至上游: ${requestBody.model || "default"} - stream=${isStream}`, {
    url: upstreamChatCompletionsUrl(),
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
  const MAX_AUTO_CONTINUES = 10;
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
      addDebugLog("UPSTREAM", `[直通模式] 第 ${continueRound + 1} 轮断点续接上游请求 - 消息量: ${currentMessages.length}`);
    }

    try {
      upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPSTREAM_API_KEY}`,
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
    addDebugLog("UPSTREAM", `[直通模式] 上游响应状态: ${upstreamResponse.status} - 耗时 ${duration}ms`, {
      status: upstreamResponse.status,
      contentType: upstreamResponse.headers.get("Content-Type")
    });

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止处理`);
      return;
    }

    if (!upstreamResponse.ok) {
      const errTxt = await upstreamResponse.text();
      addDebugLog("ERROR", `[直通模式] 上游报错 (${upstreamResponse.status})`, errTxt);
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
      addDebugLog("UPSTREAM", `[直通模式] 非流式完成输出 - 结束原因: ${rawReason || "stop"}`);
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

    addDebugLog("UPSTREAM", `[直通模式] 流式完成输出 - 结束原因: ${lastFinishReason || "stop"}`);
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

// Gemini 原生格式双向转换模块（全面支持文本与多模态图片）
function convertGeminiToOpenAIMessages(body) {
  const messages = [];
  if (body.systemInstruction?.parts) {
    const sysText = body.systemInstruction.parts.map(p => p.text || "").join("\n");
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
        finalContent = contentItems.map(item => item.text).join("");
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

  // 全方位适配 Chatbox 的 thinkingLevel 与 thinkingBudget
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

  addDebugLog("UPSTREAM", `[Gemini 直通模式] 转发转换至上游: ${requestBody.model || "default"}`, {
    url: upstreamChatCompletionsUrl(),
    model: requestBody.model,
    stream: isStream,
    messagesCount: requestBody.messages?.length || 0
  });

  let currentMessages = [...requestBody.messages];
  let continueRound = 0;
  const MAX_AUTO_CONTINUES = 10;
  let hasInitiatedStream = false;

  while (continueRound <= MAX_AUTO_CONTINUES) {
    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已断开，终止续接`);
      break;
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPSTREAM_API_KEY}`,
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
    addDebugLog("UPSTREAM", `[Gemini 直通模式] 上游响应状态: ${upstreamResponse.status} - 耗时 ${duration}ms`, {
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
            // 如果因达到上限被截断，先不发截断的结束状态，准备自动续接
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

    // 准确检测是否被上游截断（兼容 length、max_tokens、MAX_TOKENS 等）
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

  const isStream = requestBody.stream === true;
  let messages = [...requestBody.messages];

  const clientTools = Array.isArray(requestBody.tools)
    ? requestBody.tools.filter((t) => t && t.type === "function")
    : [];
  const mcpTools = getAllTools();
  const tools = [...clientTools, ...mcpTools];

  addDebugLog("AGENT", `启动 MCP 调度 - 模型 [${requestBody.model}] - 挂载工具数: ${tools.length}`, {
    model: requestBody.model,
    stream: isStream,
    mcpToolCount: mcpTools.length,
    clientToolCount: clientTools.length,
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

  // 标准 SSE 注释保活心跳：绝不破坏下游客户端的 JSON 解析，同时确保反代连接永不断开
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

  try {
    for (let round = 0; ; round += 1) {
      if (abortSignal?.aborted || clientResponse.destroyed) {
        addDebugLog("DOWNSTREAM", `客户端已断开，终止 MCP 调度循环`);
        break;
      }

      const payload = {
        ...requestBody,
        messages,
        stream: isStream
      };

      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      const roundStartTime = Date.now();
      addDebugLog("UPSTREAM", `第 ${round + 1} 轮上游调用请求 - 消息量: ${messages.length}`, {
        round: round + 1,
        toolsEnabled: Boolean(payload.tools),
        messagesCount: messages.length,
        upstreamPayloadSummary: {
          reasoning_effort: payload.reasoning_effort,
          thinkingConfig: payload.thinkingConfig,
          thinking_budget: payload.thinking_budget
        }
      });

      let upstreamResponse;
      try {
        upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${UPSTREAM_API_KEY}`,
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
        addDebugLog("ERROR", `第 ${round + 1} 轮上游报错 (${upstreamResponse.status}) - 耗时 ${roundDuration}ms`, errText);
        
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
          addDebugLog("AGENT", `第 ${round + 1} 轮最终完成 - 非流式响应返回客户端`, {
            finishReason: finalFinishReason,
            contentLength: message?.content?.length || 0
          });
          sendJson(clientResponse, 200, json);
          return;
        }

        messages.push(message);

        for (const tc of mcpCalls) {
          if (abortSignal?.aborted || clientResponse.destroyed) break;
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

      // 流式处理逻辑
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

              // 遇到正文内容：累计内容
              if (delta?.content) {
                assistantContent += delta.content;
                // 关键保护：若本轮检测到工具调用，严禁透传草稿正文，防止下游误判提前截断；只有确定无工具调用时直接流式推送
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
                // 深度思考原生内容透传
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

      // 没有工具调用，检查是否达到 Token 上限截断：若是且客户端未断开则进行自动无感断点续接
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
        addDebugLog("AGENT", `第 ${round + 1} 轮流式完成输出 - 结束原因: ${roundFinishReason || "stop"}`, {
          round: round + 1,
          finishReason: roundFinishReason,
          totalRounds: round + 1
        });
        return;
      }

      // 如果有工具调用，记录进入历史
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
        if (abortSignal?.aborted || clientResponse.destroyed) break;
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

        if (!abortSignal?.aborted && !clientResponse.destroyed) {
          sendReasoningChunk(
            clientResponse,
            `\n> 正在执行 ${displayName} [${rawAction}]...\n`,
            requestBody.model
          );
        }

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

        if (!abortSignal?.aborted && !clientResponse.destroyed) {
          sendReasoningChunk(
            clientResponse,
            `> ${displayName} [${rawAction}] 完成\n\n`,
            requestBody.model
          );
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id || `call_${crypto.randomUUID()}`,
          content: typeof result === "string" ? result : JSON.stringify(result)
        });
      }
    }
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
  }
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

      // 日志调试接口
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
          const list = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
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

    // Google Gemini 官方格式路由: /(v1|v1beta)/models/...
    const geminiMatch = reqUrl.pathname.match(/^\/(?:v1|v1beta)\/models\/(.+):(generateContent|streamGenerateContent)$/);
    if (geminiMatch) {
      if (!isProxyAuthorized(request)) {
        const authHeader = request.headers.authorization || request.headers["x-goog-api-key"] || reqUrl.searchParams.get("key") || "(无 Auth 凭证)";
        sendOpenAIError(response, 401, "API Key 错误", "authentication_error", {
          path: reqUrl.pathname,
          method: request.method,
          clientIp: request.headers["x-forwarded-for"] || request.socket.remoteAddress,
          receivedAuth: authHeader.length > 20 ? authHeader.slice(0, 15) + "..." : authHeader
        });
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

    // 只有 /v1/ 下的 OpenAI 客户端接口才进行 PROXY_API_KEY 校验
    if (reqUrl.pathname.startsWith("/v1/")) {
      if (!isProxyAuthorized(request)) {
        const authHeader = request.headers.authorization || "(无 Authorization 请求头)";
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
        const mcpEnabled = isModelEnabledForMcp(body.model) && mcpToolRegistry.size > 0;
        const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;

        addDebugLog("DOWNSTREAM", `收到客户端请求 [${body.model || "default"}] - stream=${body.stream === true}`, {
          model: body.model,
          stream: body.stream,
          mcpEnabled,
          messagesCount: body.messages?.length || 0,
          lastUserMessagePreview: typeof lastMsg?.content === "string" ? lastMsg.content.slice(0, 300) : "[非纯文本内容]"
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

server.keepAliveTimeout = 600000;
server.requestTimeout = 600000;
server.headersTimeout = 600000;

server.listen(PORT, "0.0.0.0");
