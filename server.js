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
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();

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
  sendJson(response, statusCode, {
    error: { message, type, code: null }
  });
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
  const token = (request.headers["x-panel-password"] || "").trim();
  return token === PANEL_PASSWORD;
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

async function githubApi(token, endpoint, options = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-agent-proxy",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub 接口报错 (${res.status}): ${err.slice(0, 300)}`);
  }
  return res.json();
}

async function cloudflareApi(token, endpoint, options = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "mcp-agent-proxy",
      ...(options.contentType ? { "Content-Type": options.contentType } : options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.rawBody ? options.rawBody : options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    const msg = data.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new Error(`Cloudflare 接口报错: ${msg}`);
  }
  return data.result;
}

function registerBuiltinGithub(token) {
  const serverId = crypto.randomUUID();
  const serverName = "GitHub";

  const toolsDef = [
    {
      name: "github_list_repositories",
      description: "列出当前用户的 GitHub 代码仓库列表",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const repos = await githubApi(token, "/user/repos?per_page=100&sort=updated");
        return repos.map((r) => ({ name: r.full_name, private: r.private, default_branch: r.default_branch, url: r.html_url }));
      }
    },
    {
      name: "github_get_file_contents",
      description: "获取指定仓库中指定文件或目录的内容",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "仓库所有者用户名" },
          repo: { type: "string", description: "仓库名称" },
          path: { type: "string", description: "文件路径（根目录传空字符串）" }
        },
        required: ["owner", "repo", "path"]
      },
      handler: async (args) => {
        const cleanPath = (args.path || "").replace(/^\/+/, "");
        const res = await githubApi(token, `/repos/${args.owner}/${args.repo}/contents/${cleanPath}`);
        if (Array.isArray(res)) {
          return res.map((item) => ({ name: item.name, path: item.path, type: item.type, size: item.size }));
        }
        let content = "";
        if (res.content) content = Buffer.from(res.content, res.encoding || "base64").toString("utf8");
        return { path: res.path, sha: res.sha, size: res.size, content: content.slice(0, 100000) };
      }
    },
    {
      name: "github_create_or_update_file",
      description: "在指定 GitHub 仓库中创建新文件或覆盖更新已有文件",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "仓库所有者用户名" },
          repo: { type: "string", description: "仓库名称" },
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "完整的新文件文本内容" },
          message: { type: "string", description: "提交信息 (commit message)" },
          sha: { type: "string", description: "可选。更新已有文件时提供的原文件 sha" }
        },
        required: ["owner", "repo", "path", "content", "message"]
      },
      handler: async (args) => {
        const cleanPath = (args.path || "").replace(/^\/+/, "");
        let fileSha = args.sha;
        if (!fileSha) {
          try {
            const cur = await githubApi(token, `/repos/${args.owner}/${args.repo}/contents/${cleanPath}`);
            fileSha = cur.sha;
          } catch {}
        }
        const body = {
          message: args.message,
          content: Buffer.from(args.content || "", "utf8").toString("base64")
        };
        if (fileSha) body.sha = fileSha;
        const res = await githubApi(token, `/repos/${args.owner}/${args.repo}/contents/${cleanPath}`, { method: "PUT", body });
        return { success: true, path: cleanPath, commit_sha: res.commit?.sha };
      }
    },
    {
      name: "github_create_repository",
      description: "在当前 GitHub 账号下创建一个新的代码仓库",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "新仓库名称" },
          description: { type: "string", description: "仓库描述" },
          private: { type: "boolean", description: "是否为私有仓库，默认为 false" }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const res = await githubApi(token, "/user/repos", {
          method: "POST",
          body: { name: args.name, description: args.description || "", private: Boolean(args.private), auto_init: true }
        });
        return { success: true, name: res.full_name, html_url: res.html_url };
      }
    }
  ];

  const registeredTools = [];
  for (const t of toolsDef) {
    const toolKey = `mcp_github_${t.name.replace(/^github_/, "")}`;
    const openAiTool = {
      type: "function",
      function: {
        name: toolKey,
        description: `[GitHub 官方驱动] ${t.description}`,
        parameters: t.inputSchema
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
      serverName,
      type: "builtin",
      handler: t.handler
    });
  }

  const serverInfo = {
    id: serverId,
    name: serverName,
    type: "GitHub 官方直连",
    connectedAt: new Date().toISOString(),
    toolCount: registeredTools.length,
    tools: registeredTools
  };

  mcpServers.set(serverId, serverInfo);
  return serverInfo;
}

function registerBuiltinCloudflare(token, accountId) {
  const serverId = crypto.randomUUID();
  const serverName = "Cloudflare";

  const toolsDef = [
    {
      name: "cf_list_workers",
      description: "列出当前 Cloudflare 账号下的所有 Worker 脚本项目",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const list = await cloudflareApi(token, `/accounts/${accountId}/workers/scripts`);
        return (list || []).map((w) => ({ id: w.id, created_on: w.created_on, modified_on: w.modified_on }));
      }
    },
    {
      name: "cf_deploy_worker",
      description: "在 Cloudflare 上新建或更新一个 Worker 项目并部署其 JavaScript 代码",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Worker 项目名称" },
          script: { type: "string", description: "Worker 的完整 JavaScript 脚本代码" }
        },
        required: ["name", "script"]
      },
      handler: async (args) => {
        const res = await cloudflareApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(args.name)}`, {
          method: "PUT",
          contentType: "application/javascript",
          rawBody: args.script
        });
        return { success: true, id: res?.id || args.name, modified_on: res?.modified_on };
      }
    },
    {
      name: "cf_list_pages_projects",
      description: "列出当前 Cloudflare 账号下的所有 Pages 项目",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const list = await cloudflareApi(token, `/accounts/${accountId}/pages/projects`);
        return (list || []).map((p) => ({ name: p.name, subdomain: p.subdomain, production_branch: p.production_branch }));
      }
    },
    {
      name: "cf_create_pages_project",
      description: "在 Cloudflare 上创建一个新的 Pages 项目",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Pages 项目名称" },
          production_branch: { type: "string", description: "生产分支名称，默认为 main" }
        },
        required: ["name"]
      },
      handler: async (args) => {
        const res = await cloudflareApi(token, `/accounts/${accountId}/pages/projects`, {
          method: "POST",
          body: { name: args.name, production_branch: args.production_branch || "main" }
        });
        return { success: true, name: res?.name || args.name, subdomain: res?.subdomain };
      }
    },
    {
      name: "cf_create_dns_record",
      description: "在 Cloudflare 上为指定域名添加一条 DNS 解析记录",
      inputSchema: {
        type: "object",
        properties: {
          zone_id: { type: "string", description: "Cloudflare Zone ID" },
          type: { type: "string", description: "记录类型，如 A、CNAME、TXT" },
          name: { type: "string", description: "子域名或主机名" },
          content: { type: "string", description: "IP 或目标地址" },
          proxied: { type: "boolean", description: "是否开启代理（小黄云）" }
        },
        required: ["zone_id", "type", "name", "content"]
      },
      handler: async (args) => {
        const res = await cloudflareApi(token, `/zones/${encodeURIComponent(args.zone_id)}/dns_records`, {
          method: "POST",
          body: { type: args.type.toUpperCase(), name: args.name, content: args.content, proxied: Boolean(args.proxied), ttl: 1 }
        });
        return { success: true, id: res?.id, name: res?.name, type: res?.type, content: res?.content };
      }
    }
  ];

  const registeredTools = [];
  for (const t of toolsDef) {
    const toolKey = `mcp_cf_${t.name.replace(/^cf_/, "")}`;
    const openAiTool = {
      type: "function",
      function: {
        name: toolKey,
        description: `[Cloudflare 官方驱动] ${t.description}`,
        parameters: t.inputSchema
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
      serverName,
      type: "builtin",
      handler: t.handler
    });
  }

  const serverInfo = {
    id: serverId,
    name: serverName,
    type: "Cloudflare 官方直连",
    connectedAt: new Date().toISOString(),
    toolCount: registeredTools.length,
    tools: registeredTools
  };

  mcpServers.set(serverId, serverInfo);
  return serverInfo;
}

async function connectToMcpUrl({ name, url, token }) {
  const serverId = crypto.randomUUID();
  const cleanUrl = url.trim();
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };
  if (token) headers["Authorization"] = `Bearer ${token.trim()}`;

  let postEndpoint = cleanUrl;
  try {
    const testResponse = await fetch(cleanUrl, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
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
              postEndpoint = new URL(nextLine.replace(/^data:\s*/, "").trim(), cleanUrl).toString();
              break;
            }
          }
        }
        if (postEndpoint !== cleanUrl) break;
      }
    }
  } catch {}

  const listRes = await fetch(postEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(15000)
  });

  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`MCP 服务读取工具失败 (${listRes.status}): ${err.slice(0, 300)}`);
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
      type: "http",
      postEndpoint,
      headers
    });
  }

  const serverInfo = {
    id: serverId,
    name,
    type: `远程 HTTP (${cleanUrl})`,
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
  if (!info) throw new Error(`未找到 MCP 工具：${toolKey}`);

  if (info.type === "builtin") {
    return info.handler(args);
  }

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
    const errText = await res.text();
    throw new Error(`MCP 服务响应错误 (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`MCP 调用报错：${data.error.message || JSON.stringify(data.error)}`);
  return data.result ?? data;
}

function getAllTools() {
  const tools = [];
  for (const s of mcpServers.values()) {
    for (const t of s.tools) {
      tools.push(t.openAiTool);
    }
  }
  return tools;
}

function buildToolPrompt() {
  const mcpList = Array.from(mcpServers.values());
  if (mcpList.length === 0) return "当前未挂载任何外部 MCP 工具服务。";

  const serverDetails = mcpList.map((s) => {
    const toolsStr = s.tools.map((t) => `\`${t.key}\``).join(", ");
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
  if (UPSTREAM_BASE_URL.endsWith("/chat/completions")) return UPSTREAM_BASE_URL;
  if (UPSTREAM_BASE_URL.endsWith("/v1")) return `${UPSTREAM_BASE_URL}/chat/completions`;
  return `${UPSTREAM_BASE_URL}/v1/chat/completions`;
}

function isAgentContext(requestBody) {
  if (mcpToolRegistry.size === 0) return false;
  const rawMessages = requestBody.messages || [];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return false;

  const combinedText = rawMessages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
      return "";
    })
    .join("\n");

  const names = Array.from(mcpServers.values()).map((s) => s.name);
  const pattern = new RegExp(`(mcp|工具|github|git|cloudflare|worker|dns|${names.join("|")})`, "i");
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
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
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
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]
  };
  clientResponse.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function runAgent(requestBody, clientResponse) {
  const isStream = requestBody.stream === true;
  const rawMessages = requestBody.messages;
  const toolPrompt = buildToolPrompt();

  const existingSystemIndex = rawMessages.findIndex((m) => m.role === "system");
  let messages;
  if (existingSystemIndex >= 0) {
    messages = rawMessages.map((m, idx) => {
      if (idx === existingSystemIndex) return { role: "system", content: `${m.content || ""}\n\n${toolPrompt}` };
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
    const payload = buildUpstreamPayload(messages, requestBody, true, round === 0);
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
        clientResponse.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: `\n\n上游返回错误: ${err.slice(0, 300)}` }, finish_reason: "stop" }]
        })}\n\ndata: [DONE]\n\n`);
        clientResponse.end();
        return;
      }
      throw new Error(`上游接口返回错误: ${err.slice(0, 300)}`);
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
                accumulatedToolCalls[index] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
              }
              if (tc.id) accumulatedToolCalls[index].id = tc.id;
              if (tc.function?.name) accumulatedToolCalls[index].name = tc.function.name;
              if (tc.function?.arguments) accumulatedToolCalls[index].arguments += tc.function.arguments;
            }
          } else if (!isCallingTool && delta?.content) {
            assistantContent += delta.content;
            if (isStream) clientResponse.write(`${line}\n\n`);
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
        choices: [{ index: 0, message: { role: "assistant", content: assistantContent }, finish_reason: "stop" }]
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
        sendReasoningChunk(clientResponse, `> \`${toolName}\` 执行完成，响应：\n\`\`\`json\n${brief}\n\`\`\`\n\n`, requestBody.model);
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

    if (request.method === "GET" && request.url === "/api/mcp/auth-status") {
      sendJson(response, 200, { required: Boolean(PANEL_PASSWORD) });
      return;
    }

    if (request.url.startsWith("/api/mcp/")) {
      if (!isPanelAuthorized(request)) {
        sendJson(response, 401, { error: "控制台密码验证失败，请重新登录。" });
        return;
      }

      if (request.method === "GET" && request.url === "/api/mcp/servers") {
        const allTools = getAllTools().map((t) => ({ name: t.function.name, description: t.function.description }));
        sendJson(response, 200, {
          servers: Array.from(mcpServers.values()).map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            toolCount: s.toolCount,
            tools: s.tools
          })),
          allTools
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/mcp/connect-builtin") {
        const body = await readRequestBody(request);
        let serverInfo;
        if (body.type === "github") {
          serverInfo = registerBuiltinGithub(body.token);
        } else if (body.type === "cloudflare") {
          serverInfo = registerBuiltinCloudflare(body.token, body.accountId);
        } else {
          throw new Error("不支持的内置服务。");
        }
        sendJson(response, 200, {
          id: serverInfo.id,
          name: serverInfo.name,
          type: serverInfo.type,
          toolCount: serverInfo.toolCount
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/mcp/connect-url") {
        const body = await readRequestBody(request);
        const serverInfo = await connectToMcpUrl(body);
        sendJson(response, 200, {
          id: serverInfo.id,
          name: serverInfo.name,
          type: serverInfo.type,
          toolCount: serverInfo.toolCount
        });
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
    }

    if (!isProxyAuthorized(request)) {
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
          choices: [{ index: 0, delta: { content: `\n\n[服务错误]: ${error instanceof Error ? error.message : "未知错误"}` }, finish_reason: "stop" }]
        };
        response.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      } catch {}
      return;
    }

    sendOpenAIError(response, 500, error instanceof Error ? error.message : "服务内部错误。", "server_error");
  }
});

server.listen(PORT, "0.0.0.0");
