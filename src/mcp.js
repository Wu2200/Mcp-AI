import crypto from "node:crypto";
import {
  mcpServers,
  mcpToolRegistry,
  addDebugLog,
  getStoredServers,
  saveServerToStorage
} from "./store.js";
import {
  isGitHubMcpServer,
  buildBuiltInGitHubTools,
  executeBuiltInGitHubTool
} from "./github-edit.js";

export { mcpServers, mcpToolRegistry, buildBuiltInGitHubTools };

const AUTO_SYNC_TIMEOUT_MS = 10000;
const inflightSyncs = new Map();

export function matchesServerFilter(server, targetFilter = "") {
  const filter = String(targetFilter || "").trim().toLowerCase();
  if (!filter || filter === "all") return true;
  const serverName = String(server?.name || "").trim().toLowerCase();
  const serverId = String(server?.id || "").trim().toLowerCase();
  return serverName === filter || serverId === filter || serverName.includes(filter) || filter.includes(serverName);
}

export async function parseMcpResponse(response) {
  const contentType = response.headers.get("Content-Type") || "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch {}
    }
    throw new Error("MCP 服务返回了无法解析的事件流");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("MCP 服务返回了无效 JSON");
  }
}

export function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  return schema;
}

function normalizeTool(serverName, tool) {
  const rawName = String(tool?.name || "").trim();
  if (!rawName) return null;
  const safePrefix = String(serverName || "mcp").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = safeName.startsWith(`${safePrefix}_`) ? safeName : `${safePrefix}_${safeName}`;
  return {
    key,
    rawName,
    description: typeof tool.description === "string" ? tool.description : rawName,
    inputSchema: sanitizeToolSchema(tool.inputSchema),
    enabled: true
  };
}

function attachBuiltInTools(serverName, serverUrl, upstreamTools, previousTools = []) {
  const cleanTools = upstreamTools.filter((tool) => tool && !tool.isBuiltIn);
  if (!isGitHubMcpServer({ name: serverName, url: serverUrl, tools: cleanTools })) return cleanTools;
  const preferences = new Map((previousTools || []).map((tool) => [tool.rawName, tool.enabled !== false]));
  const existingNames = new Set(cleanTools.map((tool) => tool.rawName));
  for (const def of buildBuiltInGitHubTools()) {
    if (existingNames.has(def.name)) continue;
    const normalized = normalizeTool(serverName, def);
    if (!normalized) continue;
    normalized.isBuiltIn = true;
    if (preferences.has(normalized.rawName)) normalized.enabled = preferences.get(normalized.rawName);
    cleanTools.push(normalized);
  }
  return cleanTools;
}

function registerServer(server) {
  if (server.status !== "active") return;
  for (const tool of server.tools || []) {
    if (tool.enabled === false) continue;
    const registryItem = {
      serverId: server.id,
      serverName: server.name,
      rawName: tool.rawName,
      isBuiltIn: Boolean(tool.isBuiltIn),
      postEndpoint: server.postEndpoint,
      headers: server.headers,
      serverTools: server.tools
    };
    mcpToolRegistry.set(tool.key, registryItem);
    if (!mcpToolRegistry.has(tool.rawName)) mcpToolRegistry.set(tool.rawName, registryItem);
  }
}

export function rebuildMcpToolRegistry() {
  mcpToolRegistry.clear();
  for (const server of mcpServers.values()) registerServer(server);
}

async function connectRemote({
  id = crypto.randomUUID(),
  name,
  url,
  token,
  previousTools = [],
  status = "active",
  timeoutMs = 20000,
  persist = true,
  log = true
}) {
  const cleanName = String(name || "").trim();
  const cleanUrl = String(url || "").trim().replace(/\/+$/, "");
  if (!cleanName || !cleanUrl) throw new Error("名称与 MCP 服务地址不能为空");
  let parsedUrl;
  try {
    parsedUrl = new URL(cleanUrl);
  } catch {
    throw new Error("MCP 服务地址格式无效");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("MCP 服务地址必须使用 HTTP 或 HTTPS");

  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "mcp-proxy/1.0.0"
  };
  const normalizedToken = String(token || "").trim();
  if (normalizedToken) headers.Authorization = /^Bearer\s/i.test(normalizedToken) ? normalizedToken : `Bearer ${normalizedToken}`;

  const initResponse = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-proxy", version: "1.0.0" } }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!initResponse.ok) {
    const text = await initResponse.text();
    throw new Error(`MCP 初始化失败 (${initResponse.status}): ${text.slice(0, 300)}`);
  }
  const initData = await parseMcpResponse(initResponse);
  if (initData.error) throw new Error(initData.error.message || "MCP 初始化失败");
  const sessionId = initResponse.headers.get("MCP-Session-Id") || "";
  const protocolVersion = initData.result?.protocolVersion || "2024-11-05";
  headers["MCP-Protocol-Version"] = protocolVersion;
  if (sessionId) headers["MCP-Session-Id"] = sessionId;

  await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(timeoutMs)
  }).catch(() => {});

  const listResponse = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!listResponse.ok) {
    const text = await listResponse.text();
    throw new Error(`获取 MCP 工具列表失败 (${listResponse.status}): ${text.slice(0, 300)}`);
  }
  const listData = await parseMcpResponse(listResponse);
  if (listData.error) throw new Error(listData.error.message || "获取 MCP 工具列表失败");
  const preferences = new Map((previousTools || []).map((tool) => [tool.rawName, tool.enabled !== false]));
  const upstreamTools = (Array.isArray(listData.result?.tools) ? listData.result.tools : [])
    .map((tool) => {
      const normalized = normalizeTool(cleanName, tool);
      if (normalized && preferences.has(normalized.rawName)) normalized.enabled = preferences.get(normalized.rawName);
      return normalized;
    })
    .filter(Boolean);
  if (upstreamTools.length === 0) throw new Error("该 MCP 服务未返回任何工具，请检查认证权限或服务地址。");

  const tools = attachBuiltInTools(cleanName, cleanUrl, upstreamTools, previousTools);

  const server = {
    id,
    name: cleanName,
    url: cleanUrl,
    status,
    postEndpoint: cleanUrl,
    headers,
    toolCount: tools.length,
    tools
  };
  if (persist) {
    mcpServers.set(id, server);
    rebuildMcpToolRegistry();
    await saveServerToStorage();
  }
  if (log) addDebugLog("MCP_SERVER", `MCP 服务已连接: ${cleanName}`, { serverId: id, url: cleanUrl, toolCount: tools.length });
  return server;
}

export async function connectToMcpServer(config) {
  return connectRemote(config || {});
}

export async function updateMcpServer({ id, name, url, token }) {
  const existing = mcpServers.get(id);
  if (!existing) throw new Error("未找到要更新的 MCP 服务");
  const oldToken = existing.headers?.Authorization || "";
  const updated = await connectRemote({
    id,
    name: String(name || "").trim() || existing.name,
    url: String(url || "").trim() || existing.url,
    token: String(token || "").trim() || oldToken,
    previousTools: existing.tools,
    status: existing.status
  });
  addDebugLog("MCP_SERVER", `MCP 服务配置已更新: ${updated.name}`, { serverId: id, url: updated.url, toolCount: updated.toolCount });
  return updated;
}

async function syncSingleServer(server) {
  const existingTask = inflightSyncs.get(server.id);
  if (existingTask) return existingTask;

  const task = (async () => {
    const previousTools = Array.isArray(server.tools) ? server.tools : [];
    const previousSignature = JSON.stringify(previousTools.map(({ key, rawName, description, inputSchema }) => ({ key, rawName, description, inputSchema })));
    try {
      const refreshed = await connectRemote({
        id: server.id,
        name: server.name,
        url: server.url,
        token: server.headers?.Authorization || "",
        previousTools,
        status: server.status,
        timeoutMs: AUTO_SYNC_TIMEOUT_MS,
        persist: false,
        log: false
      });
      const current = mcpServers.get(server.id);
      if (!current) return false;
      refreshed.status = current.status;
      mcpServers.set(server.id, refreshed);

      const nextSignature = JSON.stringify(refreshed.tools.map(({ key, rawName, description, inputSchema }) => ({ key, rawName, description, inputSchema })));
      if (previousSignature !== nextSignature) {
        addDebugLog("MCP_SERVER", `已自动同步最新工具: ${refreshed.name} (${previousTools.length} -> ${refreshed.toolCount})`, {
          serverId: refreshed.id,
          url: refreshed.url,
          toolCount: refreshed.toolCount
        });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addDebugLog("ERROR", `自动拉取 MCP 工具失败，继续使用缓存 [${server.name}]: ${message}`, {
        serverId: server.id,
        url: server.url
      });
      return false;
    } finally {
      inflightSyncs.delete(server.id);
    }
  })();

  inflightSyncs.set(server.id, task);
  return task;
}

export async function syncMcpServers(targetFilter = "") {
  const candidates = Array.from(mcpServers.values()).filter(
    (server) => server.status === "active" && matchesServerFilter(server, targetFilter)
  );
  if (candidates.length === 0) return;
  const results = await Promise.all(candidates.map((server) => syncSingleServer(server)));
  if (results.some(Boolean)) {
    rebuildMcpToolRegistry();
    await saveServerToStorage();
  }
}

export function extractMcpResultContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((block) => {
    if (typeof block?.text === "string") return block.text;
    if (block?.resource?.text) return block.resource.text;
    if (block?.type === "image") return "[image content]";
    return "";
  }).filter(Boolean).join("\n\n");
}

function parseRetryAfter(text) {
  const match = String(text || "").match(/(?:retry after|wait)\s+(\d+)\s*(?:s|seconds?)/i);
  if (match) {
    const seconds = Number(match[1]);
    if (seconds > 0 && seconds <= 120) return seconds;
  }
  return /rate limit exceeded|secondary rate limit|too many requests/i.test(String(text || "")) ? 35 : 0;
}

async function invokeRemoteTool(server, rawName, args) {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const response = await fetch(server.postEndpoint, {
      method: "POST",
      headers: server.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: rawName, arguments: args } }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
      const text = await response.text();
      const wait = parseRetryAfter(text);
      if (wait && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
        continue;
      }
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await parseMcpResponse(response);
    if (data.error) {
      const text = data.error.message || JSON.stringify(data.error);
      const wait = parseRetryAfter(text);
      if (wait && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
        continue;
      }
      throw new Error(text);
    }
    const result = data.result !== undefined ? data.result : data;
    const wait = result?.isError ? parseRetryAfter(extractMcpResultContent(result)) : 0;
    if (wait && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
      continue;
    }
    return result;
  }
  throw new Error("MCP 工具调用失败");
}

export async function callMcpTool(toolKey, args) {
  const info = mcpToolRegistry.get(toolKey) || Array.from(mcpToolRegistry.entries())
    .find(([key]) => key.toLowerCase() === String(toolKey).toLowerCase())?.[1];
  if (!info) throw new Error(`未找到工具：${toolKey}`);
  const startTime = Date.now();
  try {
    const result = info.isBuiltIn
      ? await executeBuiltInGitHubTool({
          rawName: info.rawName,
          args,
          headers: info.headers,
          serverTools: info.serverTools,
          invokeUpstream: (rawName, toolArgs) => invokeRemoteTool(info, rawName, toolArgs)
        })
      : await invokeRemoteTool(info, info.rawName, args);
    addDebugLog(result?.isError ? "ERROR" : "TOOL", `MCP 工具 [${info.rawName}] ${result?.isError ? "返回错误" : "调用完成"} - ${Date.now() - startTime}ms`, {
      arguments: args,
      outputPreview: extractMcpResultContent(result).slice(0, 500)
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addDebugLog("ERROR", `MCP 工具 [${info.rawName}] 调用失败 - ${Date.now() - startTime}ms`, { arguments: args, error: message });
    throw error;
  }
}

export async function callStandaloneGitHubTool(rawName, args) {
  const startTime = Date.now();
  try {
    const result = await executeBuiltInGitHubTool({ rawName, args });
    addDebugLog(result?.isError ? "ERROR" : "TOOL", `内置工具 [${rawName}] ${result?.isError ? "返回错误" : "调用完成"} - ${Date.now() - startTime}ms`, {
      arguments: args,
      outputPreview: extractMcpResultContent(result).slice(0, 500)
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addDebugLog("ERROR", `内置工具 [${rawName}] 调用失败 - ${Date.now() - startTime}ms`, { arguments: args, error: message });
    throw error;
  }
}

export async function loadMcpServersFromStorage() {
  const storedServers = await getStoredServers();
  let changed = false;
  for (const stored of storedServers) {
    if (!stored || !stored.id || !stored.url || !Array.isArray(stored.tools)) continue;
    const baseTools = stored.tools.filter((tool) => tool && !tool.isVirtual && !tool.isBuiltIn && tool.rawName !== "edit_file");
    if (baseTools.length !== stored.tools.filter((t) => t && !t.isBuiltIn).length) changed = true;
    for (const tool of baseTools) {
      if (typeof tool.enabled !== "boolean") tool.enabled = true;
      delete tool.isVirtual;
      delete tool.openAiTool;
      delete tool.status;
      delete tool.statusMessage;
    }
    const headers = stored.headers && typeof stored.headers === "object" ? stored.headers : { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
    if (!headers.Authorization && stored.rawToken) {
      headers.Authorization = /^Bearer\s/i.test(stored.rawToken) ? stored.rawToken : `Bearer ${stored.rawToken}`;
      changed = true;
    }
    const name = stored.name || stored.id;
    const tools = attachBuiltInTools(name, stored.url, baseTools, stored.tools);
    if (tools.length !== stored.tools.length) changed = true;
    const server = {
      id: stored.id,
      name,
      url: stored.url,
      status: stored.status || "active",
      postEndpoint: stored.postEndpoint || stored.url,
      headers,
      toolCount: tools.length,
      tools
    };
    delete stored.rawToken;
    mcpServers.set(server.id, server);
  }
  rebuildMcpToolRegistry();
  if (changed) await saveServerToStorage();
}
