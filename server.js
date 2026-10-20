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
  upstreamChannels,
  getActiveChannel,
  upstreamModelsUrl,
  maskApiKey,
  saveActiveChannelToStorage,
  debugLogs,
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
  addDebugLog
} from "./src/store.js";
import {
  loadMcpServersFromStorage,
  connectToMcpServer,
  checkAllTools,
  registerVirtualTools
} from "./src/mcp.js";
import {
  passThrough,
  runAgent,
  handleGeminiGenerateContent,
  isModelEnabledForMcp,
  isTitleGenerationRequest
} from "./src/agent.js";

process.on("uncaughtException", (err) => {
  console.error("[FATAL] 进程未捕获异常 (uncaughtException):", err?.message || err);
});

process.on("unhandledRejection", (reason) => {
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

loadUpstreamChannelsFromEnv();
if (dbPool) {
  await initDatabase();
}
await loadMcpServersFromStorage();
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
  const ch = getActiveChannel()?.name || "未配置";
  console.log(`[MCP-AI] 服务就绪 (端口: ${PORT} | 生效渠道: ${ch} | MCP工具: ${mcpToolRegistry.size}个)`);
});
