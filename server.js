import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  PORT,
  PROXY_API_KEY,
  PANEL_PASSWORD,
  PROJECT_ROOT,
  dbPool,
  initDatabase,
  loadUpstreamChannelsFromEnv,
  loadSettingsFromStorage,
  saveChannelsToStorage,
  loadChannelsFromStorage,
  upstreamChannels,
  activeChannelId,
  setActiveChannelId,
  getActiveChannel,
  upstreamModelsUrl,
  maskApiKey,
  saveActiveChannelToStorage,
  debugLogs,
  mcpCallLogs,
  loggingEnabled,
  saveLoggingConfigToStorage,
  enabledModels,
  saveEnabledModelsToStorage,
  mcpServers,
  mcpToolRegistry,
  deleteServerFromStorage,
  saveServerToStorage,
  generateSessionToken,
  verifySessionToken,
  parseCookies,
  isProxyAuthorized,
  isPanelAuthorized,
  setCorsHeaders,
  sendJson,
  sendOpenAIError,
  readRequestBody,
  addDebugLog,
  startNewConversationLog
} from "./src/store.js";
import {
  loadMcpServersFromStorage,
  connectToMcpServer,
  updateMcpServer,
  checkAllTools,
  registerVirtualTools,
  callMcpTool,
  sanitizeToolSchema
} from "./src/mcp.js";
import {
  passThrough,
  runAgent,
  handleGeminiGenerateContent,
  isModelEnabledForMcp,
  isTitleGenerationRequest
} from "./src/agent.js";

process.on("uncaughtException", (err) => {
  if (err && (err.message === "aborted" || err.code === "ECONNRESET" || err.code === "EPIPE")) {
    return;
  }
  console.error("[FATAL] 进程未捕获异常 (uncaughtException):", err?.message || err);
});

process.on("unhandledRejection", (reason) => {
  if (reason && (reason.message === "aborted" || reason.code === "ECONNRESET" || reason.name === "AbortError" || reason.isClientAbort)) {
    return;
  }
  console.error("[FATAL] 未处理的 Promise 拒绝 (unhandledRejection):", reason?.message || reason);
});

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

if (dbPool) {
  await initDatabase();
}
await loadMcpServersFromStorage();
await loadSettingsFromStorage();

function getExportedMcpTools(targetFilter = "") {
  const tools = [];
  const seenNames = new Set();
  const filter = (targetFilter || "").trim().toLowerCase();

  const activeServers = Array.from(mcpServers.values()).filter(
    (s) => s.status === "active" && Array.isArray(s.tools)
  );

  for (const serverInfo of activeServers) {
    const sName = String(serverInfo.name || "").trim().toLowerCase();
    const sId = String(serverInfo.id || "").trim().toLowerCase();

    // 如果指定了具体名称/ID进行过滤（非空且非 all）
    if (filter && filter !== "all") {
      const isMatch = sName === filter || sId === filter || sName.includes(filter) || filter.includes(sName);
      if (!isMatch) continue;
    }

    for (const tool of serverInfo.tools) {
      if (tool.enabled === false || !tool.key || !mcpToolRegistry.has(tool.key)) continue;

      // 默认 100% 采用原生工具名，无需任何额外配置或 query 过滤
      // 仅当多服务存在完全同名工具冲突时，才退回 tool.key 避免覆盖丢失
      const rawName = tool.rawName || tool.key;
      let exportName = rawName;
      if (seenNames.has(exportName)) {
        exportName = tool.key;
      }
      if (seenNames.has(exportName)) continue;
      seenNames.add(exportName);

      // 清洗描述：去除类似 "[github] " 这类前缀污染，保持纯净原生说明
      let cleanDescription = tool.description || tool.rawName || exportName;
      cleanDescription = cleanDescription.replace(/^\[[^\]]+\]\s*/, "").trim();

      // 原生 inputSchema 优先，并进行跨平台兼容性清洗（剔除顶层 anyOf/$schema 等易导致第三方客户端报错的字段）
      const rawSchema = tool.inputSchema || tool.openAiTool?.function?.parameters || { type: "object", properties: {} };
      const schema = sanitizeToolSchema(rawSchema);

      tools.push({
        name: exportName,
        rawName: tool.rawName || exportName,
        key: tool.key,
        serverId: serverInfo.id,
        serverName: serverInfo.name,
        description: cleanDescription,
        inputSchema: schema
      });
    }
  }

  return tools;
}

const mcpSseSessions = new Map();

async function handleSingleMcpRpcMessage(rpcMsg, serverFilter, reqUrl, clientIp) {
  if (!rpcMsg || typeof rpcMsg !== "object") {
    return null;
  }

  const { id, method, params } = rpcMsg;

  // JSON-RPC 通知消息（无 id，如 notifications/initialized），无需返回响应体
  if (id === undefined || id === null) {
    return null;
  }

  try {
    if (method === "initialize") {
      const clientName = params?.clientInfo?.name || "未知客户端";
      const clientVersion = params?.clientInfo?.version || "";
      const requestedProto = params?.protocolVersion || "2024-11-05";
      const negotiatedProto = requestedProto === "2025-03-26" ? "2025-03-26" : "2024-11-05";

      addDebugLog(
        "MCP_INIT",
        `第三方 MCP 客户端握手连接 [${clientName}${clientVersion ? " v" + clientVersion : ""}] -> ${reqUrl.pathname}`,
        {
          clientInfo: params?.clientInfo || {},
          protocolVersion: requestedProto,
          negotiatedProtocolVersion: negotiatedProto,
          path: reqUrl.pathname,
          serverFilter: serverFilter || "全部服务",
          clientIp
        },
        "mcp"
      );

      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiatedProto,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: `mcp-ai-${serverFilter || "hub"}`,
            version: "1.0.0"
          }
        }
      };
    }

    if (method === "ping") {
      return {
        jsonrpc: "2.0",
        id,
        result: {}
      };
    }

    if (method === "tools/list") {
      const tools = getExportedMcpTools(serverFilter);
      addDebugLog(
        "MCP_LIST",
        `第三方客户端拉取工具列表 -> 返回 ${tools.length} 个原生工具${serverFilter ? ` (筛选: ${serverFilter})` : ""}`,
        {
          path: reqUrl.pathname,
          serverFilter: serverFilter || "全部服务",
          toolCount: tools.length,
          tools: tools.map((t) => t.name)
        },
        "mcp"
      );

      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        }
      };
    }

    if (method === "tools/call") {
      const requestedName = params?.name || "";
      const toolArgs = params?.arguments || {};
      const targetTools = getExportedMcpTools(serverFilter);
      const matchedTool = targetTools.find(
        (tool) => tool.name === requestedName || tool.rawName === requestedName || tool.key === requestedName
      );
      const lookupKey = matchedTool?.key || matchedTool?.rawName || requestedName;

      addDebugLog(
        "MCP_CALL",
        `收到第三方 MCP 工具调用请求: [${requestedName}]`,
        {
          requestedTool: requestedName,
          resolvedKey: lookupKey,
          arguments: toolArgs,
          path: reqUrl.pathname,
          clientIp
        },
        "mcp"
      );

      try {
        const result = await callMcpTool(lookupKey, toolArgs, { logCategory: "mcp", skipLogging: false });
        const contentBlocks =
          Array.isArray(result.rawContent) && result.rawContent.length > 0
            ? result.rawContent
            : [{ type: "text", text: String(result.content ?? "") }];

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: contentBlocks,
            ...(result.isError ? { isError: true } : {})
          }
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: errMsg }],
            isError: true
          }
        };
      }
    }

    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }

    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }

    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addDebugLog("ERROR", `处理第三方 MCP 请求异常 [${method}]: ${errMsg}`, err?.stack || errMsg, "mcp");
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: errMsg
      }
    };
  }
}

const server = http.createServer(async (request, response) => {
  request.on("error", (err) => {
    if (err?.message === "aborted" || err?.code === "ECONNRESET") return;
  });
  response.on("error", (err) => {
    if (err?.code === "EPIPE" || err?.code === "ECONNRESET") return;
  });

  try {
    const reqUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "OPTIONS") {
      if (reqUrl.pathname === "/mcp" || reqUrl.pathname.startsWith("/mcp/")) {
        setCorsHeaders(response);
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
        response.setHeader("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
      } else {
        setCorsHeaders(response);
      }
      response.writeHead(204);
      response.end();
      return;
    }

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
      const htmlPath = path.join(PROJECT_ROOT, "dashboard.html");
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

    const matchMcp = reqUrl.pathname.match(/^\/mcp(?:\/([^\/]+))?\/?$/);
    if (matchMcp) {
      const querySessionId = (reqUrl.searchParams.get("sessionId") || "").trim();
      const headerSessionId = (request.headers["mcp-session-id"] || "").trim();
      const activeSessionId = querySessionId || headerSessionId;
      const hasValidSession = Boolean(activeSessionId && mcpSseSessions.has(activeSessionId));

      if (!isProxyAuthorized(request) && !hasValidSession) {
        setCorsHeaders(response);
        response.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": "Bearer"
        });
        response.end(JSON.stringify({ error: "需要有效的 Bearer API Key" }));
        return;
      }

      if (!["GET", "POST", "DELETE"].includes(request.method)) {
        setCorsHeaders(response);
        response.writeHead(405, {
          "Allow": "GET, POST, DELETE",
          "Content-Type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify({ error: "MCP endpoint only supports GET, POST, and DELETE" }));
        return;
      }

      const pathServerName = matchMcp[1] ? decodeURIComponent(matchMcp[1]).trim() : "";
      const queryServerName = (reqUrl.searchParams.get("server") || reqUrl.searchParams.get("name") || "").trim();
      const serverFilter = pathServerName || queryServerName || "";
      const clientIp = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "";

      // 1. DELETE：关闭会话
      if (request.method === "DELETE") {
        if (activeSessionId && mcpSseSessions.has(activeSessionId)) {
          const sess = mcpSseSessions.get(activeSessionId);
          if (sess?.timer) clearInterval(sess.timer);
          try {
            sess?.response?.end();
          } catch {}
          mcpSseSessions.delete(activeSessionId);
        }
        setCorsHeaders(response);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "closed" }));
        return;
      }

      // 2. GET：支持旧版 SSE 握手 (event: endpoint) 及 Streamable HTTP 监听流
      if (request.method === "GET") {
        const sessionId = activeSessionId || crypto.randomUUID();
        setCorsHeaders(response);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "MCP-Session-Id": sessionId
        });

        const timer = setInterval(() => {
          if (response.writableEnded || response.destroyed) {
            clearInterval(timer);
            mcpSseSessions.delete(sessionId);
            return;
          }
          try {
            response.write(": keep-alive\n\n");
          } catch {}
        }, 15000);

        mcpSseSessions.set(sessionId, {
          response,
          serverFilter,
          timer,
          createdAt: Date.now()
        });

        // 若客户端未携带 MCP-Session-Id 头发起 GET，说明是旧版 SSE 模式，主动推送 endpoint 事件
        if (!headerSessionId) {
          const endpointUri = `${reqUrl.pathname}?sessionId=${encodeURIComponent(sessionId)}`;
          response.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
          addDebugLog(
            "MCP_INIT",
            `第三方客户端建立旧版 SSE 通道 -> ${reqUrl.pathname}`,
            { sessionId, endpointUri, clientIp },
            "mcp"
          );
        } else {
          response.write(": connected\n\n");
        }

        request.on("close", () => {
          clearInterval(timer);
          mcpSseSessions.delete(sessionId);
        });
        return;
      }

      // 3. POST：处理无状态 Streamable HTTP JSON-RPC 请求与旧版 SSE 消息投递
      let mcpBody;
      try {
        mcpBody = await readRequestBody(request);
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message || "无效 JSON" });
        return;
      }

      const isBatch = Array.isArray(mcpBody);
      const messages = isBatch ? mcpBody : [mcpBody];
      const responses = [];

      for (const msg of messages) {
        const resObj = await handleSingleMcpRpcMessage(msg, serverFilter, reqUrl, clientIp);
        if (resObj !== null) {
          responses.push(resObj);
        }
      }

      const sseSession = querySessionId ? mcpSseSessions.get(querySessionId) : null;

      // 若属于旧版 SSE 会话（URL 带有 ?sessionId=... 且 SSE 流存活），将结果通过 SSE 推送并返回 202
      if (sseSession && !sseSession.response.writableEnded && !sseSession.response.destroyed) {
        for (const resObj of responses) {
          sseSession.response.write(`event: message\ndata: ${JSON.stringify(resObj)}\n\n`);
        }
        setCorsHeaders(response);
        response.writeHead(202, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Accepted");
        return;
      }

      // 若全部为通知消息（如 notifications/initialized），按标准返回 202 Accepted
      if (responses.length === 0) {
        setCorsHeaders(response);
        response.writeHead(202);
        response.end();
        return;
      }

      // 标准无状态 Streamable HTTP：直接返回 200 OK JSON-RPC 响应
      const outSessionId = headerSessionId || crypto.randomUUID();
      setCorsHeaders(response);
      response.setHeader("MCP-Session-Id", outSessionId);
      response.setHeader("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify(isBatch ? responses : responses[0]));
      return;
    }

    if (reqUrl.pathname.startsWith("/api/")) {
      if (!isPanelAuthorized(request)) {
        sendJson(response, 401, { error: "控制台未授权，请输入管理密码" });
        return;
      }

      if (
        reqUrl.pathname.startsWith("/api/upstream/") ||
        reqUrl.pathname.startsWith("/api/settings/") ||
        reqUrl.pathname === "/api/mcp/check-tools"
      ) {
        sendJson(response, 404, { error: "此服务仅提供 MCP 反向代理功能" });
        return;
      }

      if (request.method === "GET" && reqUrl.pathname === "/api/upstream/channels") {
        const active = getActiveChannel();
        sendJson(response, 200, {
          activeChannelId: active ? active.id : "",
          channels: upstreamChannels.map((c) => ({
            id: c.id,
            name: c.name,
            envKey: c.envKey || "自定义",
            baseUrl: c.baseUrl,
            maskedKey: maskApiKey(c.apiKey),
            active: Boolean(active && active.id === c.id)
          }))
        });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/upstream/channels/add") {
        const body = await readRequestBody(request);
        const name = String(body.name || "").trim();
        let baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
        const apiKey = String(body.apiKey || "").trim().replace(/^Bearer\s+/i, "");

        if (!name || !baseUrl || !apiKey) {
          sendJson(response, 400, { error: "名称、API 链接与密钥不能为空" });
          return;
        }

        const id = `ch_custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newChannel = { id, name, envKey: "自定义", baseUrl, apiKey };
        upstreamChannels.push(newChannel);

        const active = getActiveChannel();
        if (!active) {
          await saveActiveChannelToStorage(id);
        }
        await saveChannelsToStorage();

        addDebugLog("UPSTREAM", `已添加并保存新上游渠道 [${name}]`, { id, name, baseUrl });
        sendJson(response, 200, { success: true, channel: { id, name, baseUrl, maskedKey: maskApiKey(apiKey) } });
        return;
      }

      if (request.method === "POST" && reqUrl.pathname === "/api/upstream/channels/update") {
        const body = await readRequestBody(request);
        const id = String(body.id || "").trim();
        const found = upstreamChannels.find((c) => c.id === id);
        if (!found) {
          sendJson(response, 404, { error: "未找到指定的上游渠道" });
          return;
        }

        const name = String(body.name || "").trim();
        let baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
        const rawKey = String(body.apiKey || "").trim().replace(/^Bearer\s+/i, "");

        if (name) found.name = name;
        if (baseUrl) found.baseUrl = baseUrl;
        if (rawKey) found.apiKey = rawKey;

        await saveChannelsToStorage();

        addDebugLog("UPSTREAM", `已更新并保存上游渠道 [${found.name}]`, { id: found.id, name: found.name, baseUrl: found.baseUrl });
        sendJson(response, 200, { success: true, name: found.name });
        return;
      }

      const matchDeleteChannel = reqUrl.pathname.match(/^\/api\/upstream\/channels\/([^/]+)$/);
      if (request.method === "DELETE" && matchDeleteChannel) {
        const id = decodeURIComponent(matchDeleteChannel[1]);
        const idx = upstreamChannels.findIndex((c) => c.id === id);
        if (idx === -1) {
          sendJson(response, 404, { error: "未找到该渠道" });
          return;
        }

        const deletedName = upstreamChannels[idx].name;
        upstreamChannels.splice(idx, 1);

        const active = getActiveChannel();
        if (active && active.id === id) {
          const nextId = upstreamChannels.length > 0 ? upstreamChannels[0].id : "";
          await saveActiveChannelToStorage(nextId);
        }
        await saveChannelsToStorage();

        addDebugLog("UPSTREAM", `已删除上游渠道 [${deletedName}]`, { id });
        sendJson(response, 200, { success: true });
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
          logs: debugLogs,
          mcpLogs: mcpCallLogs
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
        let body = {};
        try {
          body = await readRequestBody(request);
        } catch {}
        const category = body?.category || "all";
        if (category === "mcp") {
          mcpCallLogs.length = 0;
        } else if (category === "chat") {
          debugLogs.length = 0;
        } else {
          debugLogs.length = 0;
          mcpCallLogs.length = 0;
        }
        sendJson(response, 200, { success: true, logs: debugLogs, mcpLogs: mcpCallLogs });
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

      const matchUpdateServer = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/update$/);
      if (request.method === "POST" && matchUpdateServer) {
        const id = decodeURIComponent(matchUpdateServer[1]);
        const body = await readRequestBody(request);
        try {
          const updated = await updateMcpServer({ id, ...body });
          sendJson(response, 200, { success: true, toolCount: updated.toolCount, name: updated.name });
        } catch (e) {
          sendJson(response, 400, { error: e.message });
        }
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
              const regItem = {
                serverId: s.id,
                serverName: s.name,
                rawName: t.rawName,
                postEndpoint: s.postEndpoint,
                headers: s.headers
              };
              mcpToolRegistry.set(t.key, regItem);
              if (!mcpToolRegistry.has(t.rawName)) {
                mcpToolRegistry.set(t.rawName, regItem);
              }
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
            const regItem = {
              serverId: s.id,
              serverName: s.name,
              rawName: tool.rawName,
              postEndpoint: s.postEndpoint,
              headers: s.headers
            };
            mcpToolRegistry.set(tool.key, regItem);
            if (!mcpToolRegistry.has(tool.rawName)) {
              mcpToolRegistry.set(tool.rawName, regItem);
            }
          }
        } else {
          mcpToolRegistry.delete(tool.key);
          if (tool.rawName) mcpToolRegistry.delete(tool.rawName);
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
            const regItem = {
              serverId: s.id,
              serverName: s.name,
              rawName: t.rawName,
              postEndpoint: s.postEndpoint,
              headers: s.headers
            };
            mcpToolRegistry.set(t.key, regItem);
            if (!mcpToolRegistry.has(t.rawName)) {
              mcpToolRegistry.set(t.rawName, regItem);
            }
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

    if (reqUrl.pathname.startsWith("/v1/") || reqUrl.pathname.startsWith("/v1beta/")) {
      sendJson(response, 404, { error: "此服务仅提供 MCP 反向代理功能" });
      return;
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

      let body;
      try {
        body = await readRequestBody(request);
      } catch (err) {
        if (err.statusCode === 413) {
          sendOpenAIError(response, 413, "请求体过大（上限 30MB），请压缩图片后重试", "payload_too_large");
          return;
        }
        if (err.isClientAbort || err.message === "aborted" || request.destroyed || response.destroyed) {
          return;
        }
        sendOpenAIError(response, 400, "请求体解析失败: " + err.message);
        return;
      }

      const lastContent = Array.isArray(body?.contents) ? body.contents[body.contents.length - 1] : null;
      let geminiPromptText = "";
      if (Array.isArray(lastContent?.parts)) {
        geminiPromptText = lastContent.parts.map((p) => p.text || "").join(" ");
      }
      const isTitleReq = isTitleGenerationRequest(geminiPromptText);
      if (!isTitleReq) {
        startNewConversationLog({
          model: modelName,
          channel: getActiveChannel()?.name || "默认",
          userPrompt: geminiPromptText ? geminiPromptText.slice(0, 500) : "非文本内容",
          stream: isStream
        });
      }

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
      response.on("close", onClientClose);

      try {
        await handleGeminiGenerateContent(modelName, isStream, body, response, { ip: request.socket.remoteAddress }, abortController.signal);
      } finally {
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

        let body;
        try {
          body = await readRequestBody(request);
        } catch (err) {
          if (err.statusCode === 413) {
            sendOpenAIError(response, 413, "请求体过大（上限 30MB），请压缩图片后重试", "payload_too_large");
            return;
          }
          if (err.isClientAbort || err.message === "aborted" || request.destroyed || response.destroyed) {
            return;
          }
          sendOpenAIError(response, 400, "请求体解析失败: " + err.message);
          return;
        }

        const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
        const lastMsgText = typeof lastMsg?.content === "string"
          ? lastMsg.content
          : (Array.isArray(lastMsg?.content) ? lastMsg.content.map((c) => c.text || "").join(" ") : "");
        const isTitleReq = isTitleGenerationRequest(lastMsgText);
        const mcpEnabled = isModelEnabledForMcp(body.model) && mcpToolRegistry.size > 0 && !isTitleReq;

        if (!isTitleReq) {
          startNewConversationLog({
            model: body.model || "default",
            channel: channel.name,
            userPrompt: lastMsgText ? lastMsgText.slice(0, 500) : "非文本内容",
            stream: body.stream === true
          });
        }

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
        response.on("close", onClientClose);

        try {
          if (mcpEnabled) {
            await runAgent(body, response, { ip: request.socket.remoteAddress }, abortController.signal);
          } else {
            await passThrough(body, response, { ip: request.socket.remoteAddress }, abortController.signal);
          }
        } finally {
          response.off("close", onClientClose);
        }
        return;
      }
    }

    sendOpenAIError(response, 404, "接口不存在");
  } catch (err) {
    if (err.name === "AbortError" || err.message === "aborted" || err.code === "ECONNRESET" || err.isClientAbort) {
      return;
    }
    console.error(`[ERROR] 全局服务未捕获异常: ${err.message}`, err.stack || err);
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

process.on("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500);
});

process.on("SIGINT", () => {
  process.exit(0);
});

server.listen(PORT, "0.0.0.0", () => {
  const activeMcpServers = Array.from(mcpServers.values()).filter((item) => item.status === "active").length;
  console.log(`[MCP-AI] MCP 反向代理就绪 (端口: ${PORT} | 已挂载服务: ${activeMcpServers}个 | 工具索引: ${mcpToolRegistry.size}个)`);
});
