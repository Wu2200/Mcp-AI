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

const DATA_FILE = path.join(__dirname, "mcp-config.json");
const mcpServers = new Map();
const mcpToolRegistry = new Map();

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

function cleanPayload(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.generationConfig?.thinkingConfig) {
    delete obj.generationConfig.thinkingConfig.includeThought;
    delete obj.generationConfig.thinkingConfig.includeThough;
  }
  if (obj.generation_config?.thinking_config) {
    delete obj.generation_config.thinking_config.includeThought;
    delete obj.generation_config.thinking_config.includeThough;
  }
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

  const data = await parseMcpResponse(res);
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

function buildToolPrompt() {
  const tools = getAllTools();
  if (tools.length === 0) return "";
  const serverNames = Array.from(mcpServers.values()).map(s => `${s.name} (${s.toolCount} 个工具)`).join("、");
  return [
    `# 远程 MCP 工具环境`,
    `当前已连接的 MCP 服务：${serverNames}。`,
    `你已具备调用上述外部工具的能力。当用户的请求需要查询数据或执行操作时，必须优先调用匹配的 MCP 工具，根据真实执行结果组织回答。`
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
    const value = JSON.parse(toolCall.function?.arguments || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
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

function isMcpContext(requestBody) {
  if (mcpToolRegistry.size === 0) return false;
  const rawMessages = requestBody.messages || [];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return false;

  if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) return true;

  const combinedText = rawMessages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((c) => (typeof c === "string" ? c : c?.text || ""))
          .join(" ");
      }
      return "";
    })
    .join("\n");

  const serverNames = Array.from(mcpServers.values())
    .map((s) => s.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, ""))
    .filter(Boolean);

  const keywords = [
    "mcp", "github", "git\\b", "repo", "代码库", "仓库", "commit", "pr\\b", "pull request",
    "分支", "branch", "提取代码", "读取文件", "查看文件", "修改文件", "创建文件", "新建文件", "删除文件",
    ...serverNames
  ];

  const pattern = new RegExp(`(${keywords.join("|")})`, "i");
  return pattern.test(combinedText);
}

async function passThrough(requestBody, clientResponse) {
  cleanPayload(requestBody);
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

  const clientTools = Array.isArray(requestBody.tools) ? requestBody.tools : [];
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
      tools,
      tool_choice: "auto",
      stream: true
    };
    cleanPayload(payload);

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
    let isCallingTool = false;

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
            isCallingTool = true;
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              if (!accumulatedToolCalls[index]) {
                accumulatedToolCalls[index] = {
                  id: tc.id || "",
                  name: tc.function?.name || "",
                  arguments: ""
                };
              }
              if (tc.id) accumulatedToolCalls[index].id = tc.id;
              if (tc.function?.name) accumulatedToolCalls[index].name = tc.function.name;
              if (tc.function?.arguments) accumulatedToolCalls[index].arguments += tc.function.arguments;
            }
          } else if (!isCallingTool && delta?.content) {
            assistantContent += delta.content;
            if (isStream) {
              clientResponse.write(`${line}\n\n`);
            }
          }
        } catch {}
      }
    }

    const mcpCalls = accumulatedToolCalls.filter((tc) =>
      mcpToolRegistry.has(tc.name)
    );

    if (mcpCalls.length === 0) {
      if (isStream) {
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
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments }
      }))
    });

    for (const tc of mcpCalls) {
      const args = toolArguments({ function: { arguments: tc.arguments } });
      const toolName = tc.name;

      if (isStream) {
        sendReasoningChunk(
          clientResponse,
          `\n> 正在执行 MCP 工具：\`${toolName}\`\n\`\`\`json\n${JSON.stringify(args || {}, null, 2)}\n\`\`\`\n`,
          requestBody.model
        );
      }

      let result;
      if (!args) {
        result = { error: "工具参数不是有效 JSON" };
      } else {
        try {
          result = await callMcpTool(tc.name, args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "执行工具失败" };
        }
      }

      if (isStream) {
        const preview = JSON.stringify(result);
        const brief = preview.length > 300 ? `${preview.slice(0, 300)}...` : preview;
        sendReasoningChunk(
          clientResponse,
          `> \`${toolName}\` 执行完毕，结果：\n\`\`\`json\n${brief}\n\`\`\`\n\n`,
          requestBody.model
        );
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      });
    }
  }

  throw new Error("工具调用轮数达到上限");
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
      for (const [key, val] of mcpToolRegistry.entries()) {
        if (val.serverId === id) {
          mcpToolRegistry.delete(key);
        }
      }
      saveConfigToDisk();
      sendJson(response, 200, { success: true });
      return;
    }

    if (!isProxyAuthorized(request)) {
      sendOpenAIError(response, 401, "API Key 错误", "authentication_error");
      return;
    }

    if (request.method === "GET" && request.url === "/v1/models") {
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

    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      if (!UPSTREAM_BASE_URL || !UPSTREAM_API_KEY) {
        sendOpenAIError(response, 500, "服务端未配置环境变量：UPSTREAM_BASE_URL 或 UPSTREAM_API_KEY");
        return;
      }

      const body = await readRequestBody(request);
      if (isMcpContext(body)) {
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
