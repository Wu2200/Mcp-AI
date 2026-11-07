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
  loadSettingsFromStorage,
  loggingEnabled,
  saveLoggingConfigToStorage,
  mcpCallLogs,
  mcpServers,
  mcpToolRegistry,
  saveServerToStorage,
  deleteServerFromStorage,
  generateSessionToken,
  verifySessionToken,
  parseCookies,
  isProxyAuthorized,
  isPanelAuthorized,
  setCorsHeaders,
  sendJson,
  readRequestBody,
  addDebugLog
} from "./src/store.js";
import {
  loadMcpServersFromStorage,
  connectToMcpServer,
  updateMcpServer,
  callMcpTool,
  sanitizeToolSchema,
  rebuildMcpToolRegistry
} from "./src/mcp.js";

process.on("uncaughtException", (error) => {
  if (["ECONNRESET", "EPIPE"].includes(error?.code) || error?.message === "aborted") return;
  console.error("[FATAL] 未捕获异常:", error?.message || error);
});

process.on("unhandledRejection", (reason) => {
  if (["ECONNRESET", "EPIPE"].includes(reason?.code) || reason?.message === "aborted" || reason?.name === "AbortError") return;
  console.error("[FATAL] 未处理的 Promise 拒绝:", reason?.message || reason);
});

function getLoginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP 控制台认证</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px 24px; width: 100%; max-width: 360px; box-shadow: 0 4px 6px -1px #0000000d; text-align: center; }
    h1 { font-size: 18px; margin-bottom: 8px; }
    p { font-size: 13px; color: #64748b; margin-bottom: 20px; }
    input { width: 100%; border: 1px solid #cbd5e1; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
    button { width: 100%; background: #2563eb; color: #fff; border: 0; font-weight: 600; font-size: 14px; padding: 10px; border-radius: 8px; cursor: pointer; }
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
      const password = document.getElementById("pwd").value.trim();
      const error = document.getElementById("err-msg");
      if (!password) { error.textContent = "请输入管理密码"; return; }
      try {
        const response = await fetch("/api/panel/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
        if (response.ok) location.reload();
        else error.textContent = "密码错误，请重新输入";
      } catch (reason) {
        error.textContent = reason.message;
      }
    }
  </script>
</body>
</html>`;
}

if (dbPool) await initDatabase();
await loadMcpServersFromStorage();
await loadSettingsFromStorage();

function getExportedMcpTools(targetFilter = "") {
  const filter = String(targetFilter || "").trim().toLowerCase();
  const tools = [];
  const seenNames = new Set();
  for (const server of mcpServers.values()) {
    if (server.status !== "active" || !Array.isArray(server.tools)) continue;
    const serverName = String(server.name || "").trim().toLowerCase();
    const serverId = String(server.id || "").trim().toLowerCase();
    if (filter && filter !== "all" && serverName !== filter && serverId !== filter && !serverName.includes(filter) && !filter.includes(serverName)) continue;
    for (const tool of server.tools) {
      if (tool.enabled === false || !tool.key || !mcpToolRegistry.has(tool.key)) continue;
      let name = tool.rawName || tool.key;
      if (seenNames.has(name)) name = tool.key;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      tools.push({
        name,
        rawName: tool.rawName || name,
        key: tool.key,
        serverId: server.id,
        serverName: server.name,
        description: tool.description || tool.rawName || name,
        inputSchema: sanitizeToolSchema(tool.inputSchema)
      });
    }
  }
  return tools;
}

const mcpSseSessions = new Map();

async function handleMcpMessage(message, serverFilter, reqUrl, clientIp) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const { id, method, params } = message;
  if (id === undefined || id === null) return null;

  if (method === "initialize") {
    const protocolVersion = params?.protocolVersion === "2025-03-26" ? "2025-03-26" : "2024-11-05";
    addDebugLog("MCP_INIT", `MCP 客户端握手 -> ${reqUrl.pathname}`, {
      clientInfo: params?.clientInfo || {},
      protocolVersion,
      serverFilter: serverFilter || "全部服务",
      clientIp
    }, "mcp");
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `mcp-proxy-${serverFilter || "hub"}`, version: "1.0.0" }
      }
    };
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    const tools = getExportedMcpTools(serverFilter);
    addDebugLog("MCP_LIST", `返回 ${tools.length} 个 MCP 工具`, {
      path: reqUrl.pathname,
      serverFilter: serverFilter || "全部服务",
      tools: tools.map((tool) => tool.name)
    }, "mcp");
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      }
    };
  }

  if (method === "tools/call") {
    const requestedName = String(params?.name || "");
    const tool = getExportedMcpTools(serverFilter).find((item) =>
      item.name === requestedName || item.rawName === requestedName || item.key === requestedName
    );
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `未找到已启用的 MCP 工具：${requestedName}` }], isError: true }
      };
    }
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    addDebugLog("MCP_CALL", `调用 MCP 工具 [${requestedName}]`, {
      requestedTool: requestedName,
      resolvedKey: tool.key,
      path: reqUrl.pathname,
      clientIp
    }, "mcp");
    try {
      const result = await callMcpTool(tool.key, args);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: detail }], isError: true } };
    }
  }

  if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
  if (method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
  if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const httpServer = http.createServer(async (request, response) => {
  request.on("error", (error) => {
    if (error?.code !== "ECONNRESET" && error?.message !== "aborted") console.error("[HTTP] 请求错误:", error?.message || error);
  });
  response.on("error", (error) => {
    if (error?.code !== "EPIPE" && error?.code !== "ECONNRESET") console.error("[HTTP] 响应错误:", error?.message || error);
  });

  try {
    const reqUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      if (reqUrl.pathname === "/mcp" || reqUrl.pathname.startsWith("/mcp/")) {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
        response.setHeader("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
      }
      response.writeHead(204);
      response.end();
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && (reqUrl.pathname === "/" || reqUrl.pathname === "")) {
      setCorsHeaders(response);
      if (PANEL_PASSWORD && !verifySessionToken(parseCookies(request).panel_auth)) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(request.method === "HEAD" ? "" : getLoginHtml());
        return;
      }
      const html = fs.readFileSync(path.join(PROJECT_ROOT, "dashboard.html"), "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? "" : html);
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
          "Content-Type": "application/json; charset=utf-8",
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
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "panel_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
      });
      response.end(JSON.stringify({ success: true }));
      return;
    }

    const mcpMatch = reqUrl.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (mcpMatch) {
      const querySessionId = (reqUrl.searchParams.get("sessionId") || "").trim();
      const headerSessionId = String(request.headers["mcp-session-id"] || "").trim();
      const activeSessionId = querySessionId || headerSessionId;
      const hasValidSession = Boolean(activeSessionId && mcpSseSessions.has(activeSessionId));
      if (!isProxyAuthorized(request) && !hasValidSession) {
        setCorsHeaders(response);
        response.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "WWW-Authenticate": "Bearer" });
        response.end(JSON.stringify({ error: "需要有效的 Bearer API Key" }));
        return;
      }
      if (!["GET", "POST", "DELETE"].includes(request.method)) {
        setCorsHeaders(response);
        response.writeHead(405, { Allow: "GET, POST, DELETE", "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "MCP endpoint only supports GET, POST, and DELETE" }));
        return;
      }

      const serverFilter = mcpMatch[1]
        ? decodeURIComponent(mcpMatch[1]).trim()
        : (reqUrl.searchParams.get("server") || reqUrl.searchParams.get("name") || "").trim();
      const clientIp = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "";

      if (request.method === "DELETE") {
        if (activeSessionId && mcpSseSessions.has(activeSessionId)) {
          const session = mcpSseSessions.get(activeSessionId);
          clearInterval(session.timer);
          session.response.end();
          mcpSseSessions.delete(activeSessionId);
        }
        sendJson(response, 200, { status: "closed" });
        return;
      }

      if (request.method === "GET") {
        const sessionId = activeSessionId || crypto.randomUUID();
        setCorsHeaders(response);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "MCP-Session-Id": sessionId
        });
        const timer = setInterval(() => {
          if (response.writableEnded || response.destroyed) {
            clearInterval(timer);
            mcpSseSessions.delete(sessionId);
            return;
          }
          response.write(": keep-alive\n\n");
        }, 15000);
        mcpSseSessions.set(sessionId, { response, serverFilter, timer, createdAt: Date.now() });
        if (!headerSessionId) {
          const endpoint = `${reqUrl.pathname}?sessionId=${encodeURIComponent(sessionId)}`;
          response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
          addDebugLog("MCP_INIT", `MCP SSE 客户端连接 -> ${reqUrl.pathname}`, { sessionId, endpoint, clientIp }, "mcp");
        } else {
          response.write(": connected\n\n");
        }
        request.on("close", () => {
          clearInterval(timer);
          mcpSseSessions.delete(sessionId);
        });
        return;
      }

      let body;
      try {
        body = await readRequestBody(request);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { error: error.message || "无效 JSON" });
        return;
      }
      const isBatch = Array.isArray(body);
      const messages = isBatch ? body : [body];
      const responses = [];
      for (const message of messages) {
        const result = await handleMcpMessage(message, serverFilter, reqUrl, clientIp);
        if (result !== null) responses.push(result);
      }

      const sseSession = querySessionId ? mcpSseSessions.get(querySessionId) : null;
      if (sseSession && !sseSession.response.writableEnded && !sseSession.response.destroyed) {
        for (const result of responses) sseSession.response.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
        setCorsHeaders(response);
        response.writeHead(202, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Accepted");
        return;
      }
      if (responses.length === 0) {
        setCorsHeaders(response);
        response.writeHead(202);
        response.end();
        return;
      }
      setCorsHeaders(response);
      response.setHeader("MCP-Session-Id", headerSessionId || crypto.randomUUID());
      response.setHeader("Access-Control-Expose-Headers", "MCP-Protocol-Version, MCP-Session-Id");
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(isBatch ? responses : responses[0]));
      return;
    }

    if (reqUrl.pathname.startsWith("/api/")) {
      if (!isPanelAuthorized(request)) {
        sendJson(response, 401, { error: "控制台未授权，请输入管理密码" });
        return;
      }
      if (request.method === "GET" && reqUrl.pathname === "/api/logs") {
        sendJson(response, 200, { enabled: loggingEnabled, mcpLogs: mcpCallLogs });
        return;
      }
      if (request.method === "POST" && reqUrl.pathname === "/api/logs/toggle") {
        const body = await readRequestBody(request);
        await saveLoggingConfigToStorage(typeof body.enabled === "boolean" ? body.enabled : !loggingEnabled);
        sendJson(response, 200, { success: true, enabled: loggingEnabled });
        return;
      }
      if (request.method === "POST" && reqUrl.pathname === "/api/logs/clear") {
        mcpCallLogs.length = 0;
        sendJson(response, 200, { success: true, mcpLogs: mcpCallLogs });
        return;
      }
      if (request.method === "GET" && reqUrl.pathname === "/api/mcp/servers") {
        const servers = Array.from(mcpServers.values()).map((server) => ({
          id: server.id,
          name: server.name,
          url: server.url,
          status: server.status,
          toolCount: server.toolCount,
          tools: (server.tools || []).map((tool) => ({ key: tool.key, rawName: tool.rawName, enabled: tool.enabled !== false }))
        }));
        sendJson(response, 200, { servers });
        return;
      }
      if (request.method === "POST" && reqUrl.pathname === "/api/mcp/connect") {
        try {
          const server = await connectToMcpServer(await readRequestBody(request));
          sendJson(response, 200, { toolCount: server.toolCount });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
        return;
      }
      const updateMatch = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/update$/);
      if (request.method === "POST" && updateMatch) {
        try {
          const id = decodeURIComponent(updateMatch[1]);
          const updated = await updateMcpServer({ id, ...(await readRequestBody(request)) });
          sendJson(response, 200, { success: true, toolCount: updated.toolCount, name: updated.name });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
        return;
      }
      const toggleMatch = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools\/([^/]+)\/toggle$/);
      if (request.method === "POST" && toggleMatch) {
        const server = mcpServers.get(decodeURIComponent(toggleMatch[1]));
        if (!server) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        const tool = server.tools.find((item) => item.key === decodeURIComponent(toggleMatch[2]));
        if (!tool) {
          sendJson(response, 404, { error: "未找到该工具" });
          return;
        }
        const body = await readRequestBody(request);
        tool.enabled = typeof body.enabled === "boolean" ? body.enabled : tool.enabled === false;
        rebuildMcpToolRegistry();
        await saveServerToStorage();
        sendJson(response, 200, { success: true, enabled: tool.enabled });
        return;
      }
      const startMatch = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const server = mcpServers.get(decodeURIComponent(startMatch[1]));
        if (!server) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        server.status = "active";
        rebuildMcpToolRegistry();
        await saveServerToStorage();
        sendJson(response, 200, { success: true, status: server.status });
        return;
      }
      const stopMatch = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const server = mcpServers.get(decodeURIComponent(stopMatch[1]));
        if (!server) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        server.status = "disabled";
        rebuildMcpToolRegistry();
        await saveServerToStorage();
        sendJson(response, 200, { success: true, status: server.status });
        return;
      }
      const deleteMatch = reqUrl.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        if (!mcpServers.has(id)) {
          sendJson(response, 404, { error: "未找到该服务" });
          return;
        }
        mcpServers.delete(id);
        rebuildMcpToolRegistry();
        await deleteServerFromStorage();
        sendJson(response, 200, { success: true });
        return;
      }
      sendJson(response, 404, { error: "接口不存在" });
      return;
    }

    sendJson(response, 404, { error: "此服务仅提供 MCP 反向代理功能" });
  } catch (error) {
    if (["ECONNRESET", "EPIPE"].includes(error?.code) || error?.message === "aborted" || error?.name === "AbortError") return;
    console.error(`[ERROR] 服务请求异常: ${error?.message || error}`);
    addDebugLog("ERROR", `服务请求异常: ${error?.message || error}`, error?.stack || "", "mcp");
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
    } else {
      sendJson(response, 500, { error: error?.message || "服务器内部错误" });
    }
  }
});

httpServer.keepAliveTimeout = 1800000;
httpServer.requestTimeout = 1800000;
httpServer.headersTimeout = 1800000;

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
process.on("SIGINT", () => process.exit(0));

httpServer.listen(PORT, "0.0.0.0", () => {
  const activeCount = Array.from(mcpServers.values()).filter((server) => server.status === "active").length;
  console.log(`[MCP-AI] MCP 反向代理就绪 (端口: ${PORT} | 已挂载服务: ${activeCount}个)`);
});
