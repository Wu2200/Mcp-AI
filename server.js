import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM_BASE_URL = requiredEnv("UPSTREAM_BASE_URL").replace(/\/+$/, "");
const UPSTREAM_API_KEY = requiredEnv("UPSTREAM_API_KEY");
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();

const mcpServers = new Map();
const mcpToolRegistry = new Map();

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`缺少环境变量：${name}`);
  }
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
  sendJson(response, statusCode, {
    error: { message, type, code: null }
  });
}

function isAuthorized(request) {
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
        reject(new Error("请求内容过大。"));
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
        reject(new Error("请求不是有效的 JSON。"));
      }
    });
    request.on("error", reject);
  });
}

async function connectToMcpServer({ name, url, token, customHeaders = {} }) {
  const serverId = crypto.randomUUID();
  const cleanUrl = url.trim();
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...customHeaders
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  let postEndpoint = cleanUrl;

  try {
    const testResponse = await fetch(cleanUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000)
    });

    const contentType = testResponse.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const reader = testResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const startTime = Date.now();

      while (Date.now() - startTime < 8000) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: endpoint")) {
            const nextLine = lines[lines.indexOf(line) + 1] || "";
            if (nextLine.startsWith("data:")) {
              const rel = nextLine.replace(/^data:\s*/, "").trim();
              postEndpoint = new URL(rel, cleanUrl).toString();
              break;
            }
          }
        }
        if (postEndpoint !== cleanUrl) break;
      }
    }
  } catch {}

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
    await fetch(postEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(initPayload),
      signal: AbortSignal.timeout(10000)
    });
  } catch {}

  const listPayload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  };

  const listRes = await fetch(postEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(15000)
  });

  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`MCP 服务读取工具列表失败 (${listRes.status}): ${err.slice(0, 300)}`);
  }

  const listData = await listRes.json();
  const rawTools = listData.result?.tools || [];

  const registeredTools = [];
  for (const t of rawTools) {
    const safePrefix = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const toolKey = `mcp_${safePrefix}_${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const openAiTool = {
      type: "function",
      function: {
        name: toolKey,
        description: `[来源: ${name}] ${t.description || t.name}`,
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    };
    registeredTools.push({
      key: toolKey,
      rawName: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      openAiTool
    });

    mcpToolRegistry.set(toolKey, {
      serverId,
      serverName: name,
      rawName: t.name,
      postEndpoint,
      headers
    });
  }

  const serverInfo = {
    id: serverId,
    name,
    url: cleanUrl,
    postEndpoint,
    token: token ? `${token.slice(0, 4)}...${token.slice(-4)}` : "",
    connectedAt: new Date().toISOString(),
    toolCount: registeredTools.length,
    tools: registeredTools
  };

  mcpServers.set(serverId, serverInfo);
  return serverInfo;
}

function removeMcpServer(serverId) {
  const s = mcpServers.get(serverId);
  if (!s) return false;
  for (const t of s.tools) {
    mcpToolRegistry.delete(t.key);
  }
  mcpServers.delete(serverId);
  return true;
}

async function callMcpTool(toolKey, args) {
  const info = mcpToolRegistry.get(toolKey);
  if (!info) {
    throw new Error(`未找到 MCP 工具：${toolKey}`);
  }

  const callPayload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: info.rawName,
      arguments: args
    }
  };

  const res = await fetch(info.postEndpoint, {
    method: "POST",
    headers: info.headers,
    body: JSON.stringify(callPayload),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MCP 服务响应错误 (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`MCP 调用报错：${data.error.message || JSON.stringify(data.error)}`);
  }

  return data.result ?? data;
}

function getAllTools() {
  const tools = [];
  for (const info of mcpToolRegistry.values()) {
    const s = mcpServers.get(info.serverId);
    if (s) {
      const match = s.tools.find((t) => t.key === info.rawName || t.rawName === info.rawName);
      if (match) {
        tools.push(match.openAiTool);
      }
    }
  }
  return tools;
}

function buildToolPrompt() {
  const mcpList = Array.from(mcpServers.values());
  if (mcpList.length === 0) {
    return "当前未挂载任何外部 MCP 工具服务。";
  }

  const serverDetails = mcpList.map((s) => {
    const toolsStr = s.tools.map((t) => `\`${t.key}\` (${t.rawName})`).join(", ");
    return `- 【${s.name}】提供工具：${toolsStr}`;
  }).join("\n");

  return [
    "# 已连接的 MCP 外部工具环境",
    "你拥有操作以下外部 MCP 服务的全部可用工具：",
    serverDetails,
    "【强制规则】",
    "1. 严禁猜测或臆造任何外部资源或操作结果！",
    "2. 当用户意图涉及上述工具领域时，必须通过调用对应以 `mcp_` 开头的工具完成真实操作与数据获取。",
    "3. 工具执行完毕后，请基于工具返回的真实数据进行完整答复。"
  ].join("\n");
}

function upstreamChatCompletionsUrl() {
  if (UPSTREAM_BASE_URL.endsWith("/chat/completions")) {
    return UPSTREAM_BASE_URL;
  }
  if (UPSTREAM_BASE_URL.endsWith("/v1")) {
    return `${UPSTREAM_BASE_URL}/chat/completions`;
  }
  return `${UPSTREAM_BASE_URL}/v1/chat/completions`;
}

function isAgentContext(requestBody) {
  if (mcpToolRegistry.size === 0) return false;
  const rawMessages = requestBody.messages || [];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return false;

  const combinedText = rawMessages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
      }
      return "";
    })
    .join("\n");

  const names = Array.from(mcpServers.values()).map((s) => s.name);
  const pattern = new RegExp(`(mcp|工具|${names.join("|")})`, "i");
  return pattern.test(combinedText);
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
    clientResponse.end();
  } else {
    clientResponse.end();
  }
}

function buildUpstreamPayload(messages, requestBody, stream = true, forceTool = false) {
  const tools = getAllTools();
  return {
    ...requestBody,
    messages,
    tools,
    tool_choice: forceTool ? "required" : "auto",
    stream,
    n: 1
  };
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

async function runAgent(requestBody, clientResponse) {
  if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
    throw new Error("messages 必须是非空数组。");
  }

  const isStream = requestBody.stream === true;
  const rawMessages = requestBody.messages;
  const toolPrompt = buildToolPrompt();

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
    const forceToolInFirstRound = round === 0;
    const payload = buildUpstreamPayload(messages, requestBody, true, forceToolInFirstRound);

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

    const agentCalls = accumulatedToolCalls.filter((tc) => mcpToolRegistry.has(tc.name || ""));

    if (agentCalls.length === 0) {
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
      tool_calls: agentCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments }
      }))
    });

    for (const tc of agentCalls) {
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
        result = { error: "工具参数不是有效 JSON。" };
      } else {
        try {
          result = await callMcpTool(toolName, args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "执行 MCP 工具失败。" };
        }
      }

      if (isStream) {
        const preview = JSON.stringify(result);
        const brief = preview.length > 300 ? `${preview.slice(0, 300)}...` : preview;
        sendReasoningChunk(
          clientResponse,
          `> \`${toolName}\` 执行完成，响应：\n\`\`\`json\n${brief}\n\`\`\`\n\n`,
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

  throw new Error("工具调用轮数达到上限。");
}

function renderHtmlDashboard() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Agent 控制台</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #151c2e;
      --card-border: #232f48;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --accent: #10b981;
      --danger: #ef4444;
      --input-bg: #0b0f19;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      background: var(--bg);
      color: var(--text-main);
      line-height: 1.5;
      padding: 24px 16px;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header { margin-bottom: 24px; border-bottom: 1px solid var(--card-border); padding-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 6px; }
    .subtitle { color: var(--text-muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (min-width: 768px) { .grid-2 { grid-template-columns: 1fr 1fr; } }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 20px;
    }
    .card-title { font-size: 16px; font-weight: 600; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
      background: #0284c7;
      color: #fff;
    }
    .badge-green { background: #059669; }
    .param-box { background: var(--input-bg); border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px; margin-bottom: 12px; word-break: break-all; }
    .param-label { color: var(--text-muted); font-size: 12px; margin-bottom: 4px; }
    .input-group { margin-bottom: 14px; }
    .input-group label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px; }
    .input-group input, .input-group textarea, .input-group select {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px 12px;
      color: #fff;
      font-size: 14px;
      outline: none;
    }
    .input-group input:focus, .input-group textarea:focus { border-color: var(--primary); }
    button.btn {
      background: var(--primary);
      color: #0b0f19;
      border: none;
      font-weight: 600;
      padding: 9px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    button.btn:hover { background: var(--primary-hover); }
    button.btn-danger { background: var(--danger); color: #fff; }
    button.btn-sm { padding: 4px 8px; font-size: 12px; }
    .server-item {
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .server-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .tool-tag {
      display: inline-block;
      background: #232f48;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 4px;
      margin: 2px 4px 2px 0;
      font-family: monospace;
      color: #e2e8f0;
    }
    pre { background: var(--input-bg); padding: 10px; border-radius: 6px; font-size: 12px; overflow-x: auto; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>MCP Agent 通用代理控制台</h1>
      <div class="subtitle">专用于将原生 MCP 服务转换并接入 Chatbox / OpenAI 客户端</div>
    </header>

    <div class="grid grid-2" style="margin-bottom: 20px;">
      <div class="card">
        <div class="card-title">Chatbox 接入设置 <span class="badge badge-green">已就绪</span></div>
        <div class="param-label">API 域名 (Base URL)</div>
        <div class="param-box" id="proxy-url">正在加载...</div>
        <div class="param-label">模型 (Model)</div>
        <div class="param-box">任意模型（由上游 CLIProxyAPI 提供）</div>
        <p style="font-size: 13px; color: var(--text-muted);">Chatbox 连接此地址后，只要对话中提及已连接 MCP 相关的需求，大模型将自动触发工具调用。</p>
      </div>

      <div class="card">
        <div class="card-title">手动连接新的 MCP 服务</div>
        <div class="input-group">
          <label>服务名称（标识前缀）</label>
          <input id="mcp-name" placeholder="例如：Cloudflare 或 GitHub" value="CF">
        </div>
        <div class="input-group">
          <label>MCP 服务地址 (SSE / HTTP Endpoint)</label>
          <input id="mcp-url" placeholder="https://your-mcp-server.com/sse">
        </div>
        <div class="input-group">
          <label>认证令牌 (Token / Key，可选)</label>
          <input id="mcp-token" type="password" placeholder="若无需认证可留空">
        </div>
        <button class="btn" id="connect-btn" onclick="handleConnectMcp()">连接并提取工具</button>
        <span id="connect-status" style="margin-left: 10px; font-size: 13px;"></span>
      </div>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <div class="card-title">已连接的 MCP 服务列表 <span class="badge" id="mcp-count">0</span></div>
      <div id="mcp-list"><div style="color: var(--text-muted); font-size: 13px;">尚未连接任何 MCP 服务，请在上方输入地址添加。</div></div>
    </div>

    <div class="card">
      <div class="card-title">已注册工具在线测试</div>
      <div class="grid grid-2">
        <div>
          <div class="input-group">
            <label>选择已注册工具</label>
            <select id="tool-select"></select>
          </div>
          <div class="input-group">
            <label>入参 (JSON 格式)</label>
            <textarea id="tool-args" rows="6">{}</textarea>
          </div>
          <button class="btn" onclick="handleExecuteTest()">手动运行工具</button>
        </div>
        <div>
          <label style="font-size: 13px; color: var(--text-muted); display: block; margin-bottom: 6px;">返回结果</label>
          <pre id="tool-result">等待执行...</pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    document.getElementById("proxy-url").innerText = window.location.origin + "/v1";

    async function loadServers() {
      try {
        const res = await fetch("/api/mcp/servers");
        const data = await res.json();
        const listEl = document.getElementById("mcp-list");
        document.getElementById("mcp-count").innerText = data.servers.length;

        if (data.servers.length === 0) {
          listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">尚未连接任何 MCP 服务，请在上方输入地址添加。</div>';
        } else {
          listEl.innerHTML = data.servers.map(s => `
            <div class="server-item">
              <div class="server-item-header">
                <div><strong>${s.name}</strong> <span class="badge badge-green">${s.toolCount} 个工具</span></div>
                <button class="btn btn-danger btn-sm" onclick="handleDeleteServer('${s.id}')">断开</button>
              </div>
              <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">地址: ${s.url}</div>
              <div>
                ${s.tools.map(t => `<span class="tool-tag" title="${t.description || ''}">${t.key}</span>`).join('')}
              </div>
            </div>
          `).join('');
        }

        const sel = document.getElementById("tool-select");
        if (data.allTools.length === 0) {
          sel.innerHTML = '<option value="">暂无可用工具</option>';
        } else {
          sel.innerHTML = data.allTools.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function handleConnectMcp() {
      const name = document.getElementById("mcp-name").value.trim();
      const url = document.getElementById("mcp-url").value.trim();
      const token = document.getElementById("mcp-token").value.trim();
      const statusEl = document.getElementById("connect-status");

      if (!name || !url) {
        statusEl.innerText = "名称与 URL 均为必填项。";
        statusEl.style.color = "#ef4444";
        return;
      }

      statusEl.innerText = "正在连接并读取工具...";
      statusEl.style.color = "#38bdf8";

      try {
        const res = await fetch("/api/mcp/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, url, token })
        });
        const result = await res.json();
        if (!res.ok) {
          throw new Error(result.error || "连接失败");
        }
        statusEl.innerText = `成功载入 ${result.toolCount} 个工具！`;
        statusEl.style.color = "#10b981";
        document.getElementById("mcp-url").value = "";
        document.getElementById("mcp-token").value = "";
        loadServers();
      } catch (err) {
        statusEl.innerText = err.message;
        statusEl.style.color = "#ef4444";
      }
    }

    async function handleDeleteServer(id) {
      if (!confirm("确认移除该 MCP 连接？")) return;
      await fetch('/api/mcp/servers/' + id, { method: "DELETE" });
      loadServers();
    }

    async function handleExecuteTest() {
      const tool = document.getElementById("tool-select").value;
      const resBox = document.getElementById("tool-result");
      if (!tool) return;
      let args = {};
      try {
        args = JSON.parse(document.getElementById("tool-args").value || "{}");
      } catch {
        resBox.innerText = "参数不是合法的 JSON。";
        return;
      }

      resBox.innerText = "正在调用工具...";
      try {
        const res = await fetch("/api/mcp/test-tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool, args })
        });
        const result = await res.json();
        resBox.innerText = JSON.stringify(result, null, 2);
      } catch (err) {
        resBox.innerText = "调用失败：" + err.message;
      }
    }

    loadServers();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      setCorsHeaders(response);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderHtmlDashboard());
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/api/mcp/servers") {
      const allTools = getAllTools().map((t) => ({ name: t.function.name, description: t.function.description }));
      sendJson(response, 200, {
        servers: Array.from(mcpServers.values()),
        allTools
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/connect") {
      const body = await readRequestBody(request);
      const serverInfo = await connectToMcpServer(body);
      sendJson(response, 200, serverInfo);
      return;
    }

    if (request.method === "DELETE" && request.url.startsWith("/api/mcp/servers/")) {
      const id = request.url.replace("/api/mcp/servers/", "");
      const ok = removeMcpServer(id);
      sendJson(response, 200, { success: ok });
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/test-tool") {
      const body = await readRequestBody(request);
      const toolName = body.tool;
      const toolArgs = body.args || {};
      const result = await callMcpTool(toolName, toolArgs);
      sendJson(response, 200, result);
      return;
    }

    if (!isAuthorized(request)) {
      sendOpenAIError(response, 401, "API Key 无效，请检查 Chatbox 填写的密钥是否与 Render 环境变量 PROXY_API_KEY 一致。", "authentication_error");
      return;
    }

    if (request.method === "GET" && request.url === "/v1/models") {
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
      const requestBody = await readRequestBody(request);
      if (isAgentContext(requestBody)) {
        await runAgent(requestBody, response);
      } else {
        await passThrough(requestBody, response);
      }
      return;
    }

    sendOpenAIError(response, 404, "接口不存在。");
  } catch (error) {
    if (response.headersSent) {
      try {
        const errChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          choices: [
            {
              index: 0,
              delta: { content: `\n\n[服务错误]: ${error instanceof Error ? error.message : "未知错误"}` },
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

    sendOpenAIError(
      response,
      500,
      error instanceof Error ? error.message : "服务内部错误。",
      "server_error"
    );
  }
});

server.listen(PORT, "0.0.0.0");
