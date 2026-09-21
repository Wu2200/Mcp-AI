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
const mcpServers = new Map();
const mcpToolRegistry = new Map();

const SESSION_SECRET = PANEL_PASSWORD
  ? crypto.createHash("sha256").update(`mcp-proxy-session:${PANEL_PASSWORD}`).digest("hex")
  : crypto.randomBytes(32).toString("hex");

function getToolAction(toolName) {
  const name = (toolName || "").toLowerCase();
  if (name.includes("delete") || name.includes("remove")) return "删除";
  if (name.includes("update") || name.includes("merge") || name.includes("resolve") || name.includes("patch") || name.includes("edit")) return "更新";
  if (name.includes("create") || name.includes("add") || name.includes("push") || name.includes("fork")) return "创建";
  if (name.includes("get") || name.includes("list") || name.includes("search") || name.includes("read") || name.includes("docs")) return "查询";
  if (name.includes("execute") || name.includes("run")) return "执行";
  return "处理";
}

function getServiceDisplayName(toolInfo, toolName) {
  if (toolInfo?.serverName) return toolInfo.serverName;
  const name = (toolName || "").toLowerCase();
  if (name.includes("github")) return "GitHub";
  if (name.includes("cloudflare")) return "Cloudflare";
  return "MCP";
}

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
    `);
  } catch {
    pgPool = null;
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

function isProxyAuthorized(request) {
  if (!PROXY_API_KEY) return true;
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
      if (size > 10 * 1024 * 1024) {
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
  return serverInfo;
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
  const rawResult = data.result ?? data;
  if (rawResult && Array.isArray(rawResult.content)) {
    const textPieces = rawResult.content
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text);
    if (textPieces.length > 0) {
      return textPieces.join("\n\n");
    }
  }
  return typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
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

function buildToolPrompt() {
  const activeServers = Array.from(mcpServers.values()).filter((s) => s.status === "active");
  if (activeServers.length === 0) return "";
  const serverNames = activeServers.map((s) => `${s.name} (${s.toolCount} 个工具)`).join("、");
  return [
    `# 远程 MCP 真实执行环境`,
    `当前已在线并提供功能的 MCP 服务：${serverNames}。`,
    `系统已将真实外部函数挂载至对话中。`,
    `【铁律：禁止假调用、禁止口头承诺、必须实际调用工具】`,
    `1. 遇到任何需要查询、读取、写入、创建、提交、修改或删除的指令，必须且只能通过 tool_calls 触发对应的函数，绝不可在正文中直接假装已经完成。`,
    `2. 严禁在回答中编造 Commit SHA、PR 链接、文件内容或假装已更新。`,
    `3. 严禁在正文回答中用文本模拟“正在调用”、“已调用”或以代码块格式伪造工具返回。`,
    `4. 只有在收到工具的真正执行返回内容后，方可基于真实返回给用户输出结论。`
  ].join("\n");
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

function sendReasoningChunk(clientResponse, text, model = "default") {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { reasoning_content: text },
        finish_reason: null
      }
    ]
  };
  clientResponse.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function passThrough(requestBody, clientResponse) {
  setCorsHeaders(clientResponse);
  const upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTREAM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(120000)
  });

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

async function runAgent(requestBody, clientResponse) {
  if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
    throw new Error("messages 必须是非空数组");
  }

  const isStream = requestBody.stream === true;
  const rawMessages = requestBody.messages;
  const toolPrompt = buildToolPrompt();

  const clientTools = Array.isArray(requestBody.tools) ? [...requestBody.tools] : [];
  const modelName = (requestBody.model || "").toLowerCase();

  // 兼容网关网络搜索配置（如 NewAPI / OneAPI / CLIProxy Payload 规则）
  const hasWebSearch = clientTools.some(
    (t) => t.type === "web_search" || t.google_search || t.function?.name === "web_search"
  );
  if (!hasWebSearch) {
    if (modelName.startsWith("gpt") || modelName.includes("openai") || modelName.startsWith("o1") || modelName.startsWith("o3")) {
      clientTools.push({ type: "web_search" });
    } else if (modelName.includes("gemini")) {
      clientTools.push({ google_search: {} });
    }
  }

  const mcpTools = getAllTools();
  const tools = [...clientTools, ...mcpTools];

  const existingSystemIndex = rawMessages.findIndex((m) => m.role === "system");
  let messages;
  if (existingSystemIndex >= 0) {
    messages = rawMessages.map((m, idx) => {
      if (idx === existingSystemIndex) {
        return {
          role: "system",
          content: `${m.content || ""}\n\n${toolPrompt}`
        };
      }
      return m;
    });
  } else {
    messages = [{ role: "system", content: toolPrompt }, ...rawMessages];
  }

  if (isStream) {
    setCorsHeaders(clientResponse);
    clientResponse.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
  }

  for (let round = 0; round < 10; round += 1) {
    const payload = {
      ...requestBody,
      messages,
      stream: true
    };

    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";

      // 满足 Gemini 在混合使用内置工具 (google_search) 和 Function calling 时的强制规范
      if (modelName.includes("gemini") || tools.some((t) => t.google_search)) {
        payload.tool_config = {
          ...(payload.tool_config || {}),
          include_server_side_tool_invocations: true
        };
        payload.toolConfig = {
          ...(payload.toolConfig || {}),
          includeServerSideToolInvocations: true
        };
      }
    }

    const upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTREAM_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    });

    if (!upstreamResponse.ok) {
      const err = await upstreamResponse.text();
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

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedToolCalls = [];
    let assistantContent = "";
    let streamedDeltas = [];

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
          if (delta?.reasoning_content && isStream) {
            clientResponse.write(`${line}\n\n`);
          }

          if (delta?.tool_calls) {
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
            streamedDeltas.push(line);
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
      if (isStream) {
        for (const line of streamedDeltas) {
          clientResponse.write(`${line}\n\n`);
        }
        clientResponse.write("data: [DONE]\n\n");
        clientResponse.end();
        return;
      }

      sendJson(clientResponse, 200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestBody.model || "default",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: assistantContent },
            finish_reason: "stop"
          }
        ]
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

      const serverDisplayName = getServiceDisplayName(toolInfo, tc.name);
      const actionName = getToolAction(toolInfo?.rawName || tc.name);
      const args = toolArguments({ function: { arguments: tc.arguments } });

      if (isStream) {
        sendReasoningChunk(
          clientResponse,
          `\n> 正在调用 ${serverDisplayName} ${actionName}接口\n`,
          requestBody.model
        );
      }

      let result;
      let isError = false;
      if (args === null) {
        result = JSON.stringify({ error: "工具参数格式错误" });
        isError = true;
      } else {
        try {
          result = await callMcpTool(tc.name, args);
        } catch (err) {
          isError = true;
          result = JSON.stringify({ error: err instanceof Error ? err.message : "执行工具失败" });
        }
      }

      if (isStream) {
        sendReasoningChunk(
          clientResponse,
          `> ${serverDisplayName} ${actionName}${isError ? "失败" : "成功"}\n\n`,
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

  throw new Error("工具调用轮数达到上限");
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

    if (reqUrl.pathname.startsWith("/api/mcp/")) {
      if (!isPanelAuthorized(request)) {
        sendJson(response, 401, { error: "控制台未授权，请输入管理密码" });
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

    if (!isProxyAuthorized(request)) {
      sendOpenAIError(response, 401, "API Key 错误", "authentication_error");
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
      if (mcpToolRegistry.size > 0) {
        await runAgent(body, response);
      } else {
        await passThrough(body, response);
      }
      return;
    }

    sendOpenAIError(response, 404, "接口不存在");
  } catch (err) {
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

server.listen(PORT, "0.0.0.0");
