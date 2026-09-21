import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM_BASE_URL = requiredEnv("UPSTREAM_BASE_URL").replace(/\/+$/, "");
const UPSTREAM_API_KEY = requiredEnv("UPSTREAM_API_KEY");
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();

const DATA_FILE = path.join(__dirname, "mcp-config.json");
const mcpServers = new Map();
const mcpToolRegistry = new Map();

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
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

function saveConfigToDisk() {
  try {
    const data = Array.from(mcpServers.values()).map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      token: s.rawToken,
      postEndpoint: s.postEndpoint,
      headers: s.headers,
      tools: s.tools
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function loadConfigFromDisk() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const list = JSON.parse(raw);
    for (const item of list) {
      mcpServers.set(item.id, {
        id: item.id,
        name: item.name,
        url: item.url,
        rawToken: item.token,
        postEndpoint: item.postEndpoint,
        headers: item.headers,
        toolCount: item.tools.length,
        tools: item.tools
      });

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
  } catch {}
}

async function connectToMcpServer({ name, url, token }) {
  const serverId = crypto.randomUUID();
  const cleanUrl = url.trim().replace(/\/+$/, "");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "GitHubCopilotChat/0.24.1",
    "Editor-Version": "vscode/1.97.0"
  };

  if (token) headers["Authorization"] = `Bearer ${token.trim()}`;

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
      signal: AbortSignal.timeout(6000)
    });
  } catch {}

  const listPayload = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const listRes = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(8000)
  });

  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`MCP 响应错误 (${listRes.status}): ${err.slice(0, 300)}`);
  }

  const listData = await listRes.json();
  const rawTools = listData.result?.tools || [];

  if (rawTools.length === 0) {
    throw new Error("该 MCP 未返回任何工具，请检查 Token 权限。");
  }

  const registeredTools = [];
  for (const t of rawTools) {
    const safePrefix = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const toolKey = `mcp_${safePrefix}_${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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
    postEndpoint: cleanUrl,
    headers,
    toolCount: registeredTools.length,
    tools: registeredTools
  };

  mcpServers.set(serverId, serverInfo);
  saveConfigToDisk();
  return serverInfo;
}

async function callMcpTool(toolKey, args) {
  const info = mcpToolRegistry.get(toolKey);
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

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result ?? data;
}

function getAllTools() {
  const tools = [];
  for (const s of mcpServers.values()) {
    for (const t of s.tools) tools.push(t.openAiTool);
  }
  return tools;
}

function upstreamChatCompletionsUrl() {
  if (UPSTREAM_BASE_URL.endsWith("/chat/completions")) return UPSTREAM_BASE_URL;
  if (UPSTREAM_BASE_URL.endsWith("/v1")) return `${UPSTREAM_BASE_URL}/chat/completions`;
  return `${UPSTREAM_BASE_URL}/v1/chat/completions`;
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
    "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json"
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
  const isStream = requestBody.stream === true;
  const tools = getAllTools();
  const payload = {
    ...requestBody,
    tools,
    tool_choice: "auto",
    stream: isStream
  };

  const upstreamResponse = await fetch(upstreamChatCompletionsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTREAM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });

  setCorsHeaders(clientResponse);
  clientResponse.writeHead(upstreamResponse.status, {
    "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json"
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

loadConfigFromDisk();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && (request.url === "/" || request.url.startsWith("/?"))) {
      setCorsHeaders(response);
      const htmlPath = path.join(__dirname, "dashboard.html");
      const htmlContent = fs.readFileSync(htmlPath, "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(htmlContent);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/api/mcp/servers") {
      sendJson(response, 200, { servers: Array.from(mcpServers.values()) });
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/connect") {
      const body = await readRequestBody(request);
      const serverInfo = await connectToMcpServer(body);
      sendJson(response, 200, { toolCount: serverInfo.toolCount });
      return;
    }

    if (request.method === "DELETE" && request.url.startsWith("/api/mcp/servers/")) {
      const id = request.url.replace("/api/mcp/servers/", "");
      mcpServers.delete(id);
      saveConfigToDisk();
      sendJson(response, 200, { success: true });
      return;
    }

    if (!isProxyAuthorized(request)) {
      sendOpenAIError(response, 401, "API Key 错误", "authentication_error");
      return;
    }

    if (request.method === "POST" && request.url === "/v1/chat/completions") {
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
    sendJson(response, 500, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0");
