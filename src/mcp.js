import crypto from "node:crypto";
import {
  mcpServers,
  mcpToolRegistry,
  enabledModels,
  addDebugLog,
  getActiveChannel,
  upstreamChatCompletionsUrl,
  getStoredServers,
  saveServerToStorage
} from "./store.js";

export { mcpServers, mcpToolRegistry };

export async function parseMcpResponse(res) {
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

export function findToolInfo(toolKey) {
  if (!toolKey || typeof toolKey !== "string") return null;
  const rawTarget = toolKey.trim();

  // 1. 精确匹配
  let info = mcpToolRegistry.get(rawTarget);
  if (info) return info;

  // 2. 忽略大小写匹配
  const lowerTarget = rawTarget.toLowerCase();
  for (const [k, v] of mcpToolRegistry.entries()) {
    if (k.toLowerCase() === lowerTarget) return v;
  }

  // 3. 归一化名称（去除常见前缀和后缀，去除下划线与中划线差异）
  const normalize = (name) => {
    return String(name || "")
      .toLowerCase()
      .replace(/^(?:github_|mcp_|copilot_|tool_|default_api_)+/g, "")
      .replace(/(?:_mcp_github|_mcp|_tool|_server|_github)+$/g, "")
      .replace(/[^a-z0-9]/g, "");
  };

  const normTarget = normalize(rawTarget);
  if (normTarget) {
    // 3.1 归一化全等匹配
    for (const [k, v] of mcpToolRegistry.entries()) {
      if (normalize(k) === normTarget || normalize(v.rawName) === normTarget) {
        return v;
      }
    }

    // 4. 后缀模糊包含匹配
    for (const [k, v] of mcpToolRegistry.entries()) {
      const normK = normalize(k);
      const normRaw = normalize(v.rawName);
      if (
        (normRaw && normTarget.endsWith(normRaw)) ||
        (normK && normTarget.endsWith(normK)) ||
        (normTarget && normK.endsWith(normTarget)) ||
        (normTarget && normRaw.endsWith(normTarget))
      ) {
        return v;
      }
    }

    // 5. 常见标准动作别名映射
    const aliasMap = {
      readfile: "get_file_contents",
      getfile: "get_file_contents",
      viewfile: "get_file_contents",
      catfile: "get_file_contents",
      writefile: "create_or_update_file",
      createfile: "create_or_update_file",
      updatefile: "create_or_update_file",
      editfile: "github_edit_file",
      modifyfile: "github_edit_file",
      patchfile: "github_edit_file"
    };

    const mappedAlias = aliasMap[normTarget];
    if (mappedAlias) {
      const normMapped = normalize(mappedAlias);
      for (const [k, v] of mcpToolRegistry.entries()) {
        if (normalize(k) === normMapped || normalize(v.rawName) === normMapped) {
          return v;
        }
      }
    }
  }

  return null;
}

export async function connectToMcpServer({ name, url, token }) {
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
      signal: AbortSignal.timeout(20000)
    });

    await fetch(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }),
      signal: AbortSignal.timeout(20000)
    }).catch(() => {});
  } catch {}

  const listPayload = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const listRes = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(20000)
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
      description: t.description || t.name,
      enabled: true,
      status: "unchecked",
      statusMessage: "",
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

  registerVirtualTools(serverInfo);
  mcpServers.set(serverId, serverInfo);
  await saveServerToStorage();
  addDebugLog("TOOL", `成功挂载 MCP 服务: ${name}`, { serverId, url: cleanUrl, toolCount: serverInfo.tools.length });
  return serverInfo;
}

export async function updateMcpServer({ id, name, url, token }) {
  const existing = mcpServers.get(id);
  if (!existing) {
    throw new Error("未找到要更新的 MCP 服务");
  }

  const targetName = (name || "").trim() || existing.name;
  const targetUrl = (url || "").trim() || existing.url;
  const cleanUrl = targetUrl.replace(/\/+$/, "");

  const hasNewToken = token !== undefined && token !== null && String(token).trim() !== "";
  const finalToken = hasNewToken ? String(token).trim() : (existing.rawToken || "");

  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "mcp-agent-proxy/1.0.0"
  };

  if (finalToken) {
    headers["Authorization"] = finalToken.startsWith("Bearer ") ? finalToken : `Bearer ${finalToken}`;
  }

  // 1. 初始化握手
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
      signal: AbortSignal.timeout(20000)
    });

    await fetch(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }),
      signal: AbortSignal.timeout(20000)
    }).catch(() => {});
  } catch {}

  // 2. 拉取工具列表
  const listPayload = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const listRes = await fetch(cleanUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(20000)
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

  // 3. 记录已存在工具的启用与检测状态
  const oldToolPref = new Map();
  if (Array.isArray(existing.tools)) {
    for (const ot of existing.tools) {
      if (ot.rawName) {
        oldToolPref.set(ot.rawName, {
          enabled: ot.enabled !== false,
          status: ot.status || "unchecked",
          statusMessage: ot.statusMessage || ""
        });
      }
    }
  }

  // 4. 清理旧注册项
  for (const [key, val] of mcpToolRegistry.entries()) {
    if (val.serverId === id) {
      mcpToolRegistry.delete(key);
    }
  }

  // 5. 注册新工具并恢复偏好
  const registeredTools = [];
  for (const t of rawTools) {
    const safePrefix = targetName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const sanitizedToolName = t.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const toolKey = sanitizedToolName.startsWith(`${safePrefix}_`)
      ? sanitizedToolName
      : `${safePrefix}_${sanitizedToolName}`;

    const prev = oldToolPref.get(t.name);
    const isEnabled = prev ? prev.enabled : true;
    const status = prev ? prev.status : "unchecked";
    const statusMessage = prev ? prev.statusMessage : "";

    registeredTools.push({
      key: toolKey,
      rawName: t.name,
      description: t.description || t.name,
      enabled: isEnabled,
      status,
      statusMessage,
      openAiTool: {
        type: "function",
        function: {
          name: toolKey,
          description: `[${targetName}] ${t.description || t.name}`,
          parameters: t.inputSchema || { type: "object", properties: {} }
        }
      }
    });

    if (existing.status !== "disabled" && isEnabled) {
      mcpToolRegistry.set(toolKey, {
        serverId: id,
        serverName: targetName,
        rawName: t.name,
        postEndpoint: cleanUrl,
        headers
      });
    }
  }

  existing.name = targetName;
  existing.url = cleanUrl;
  existing.rawToken = finalToken;
  existing.postEndpoint = cleanUrl;
  existing.headers = headers;
  existing.toolCount = registeredTools.length;
  existing.tools = registeredTools;

  registerVirtualTools(existing);
  await saveServerToStorage();
  addDebugLog("TOOL", `成功更新 MCP 服务: ${targetName}`, { serverId: id, url: cleanUrl, toolCount: existing.tools.length });
  return existing;
}

export function extractMcpResultContent(data) {
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

export function extractErrorMessage(text) {
  if (!text) return "";
  if (typeof text === "object") {
    if (typeof text.error === "string") return text.error;
    if (text.error?.message) return text.error.message;
    if (typeof text.message === "string") return text.message;
    return JSON.stringify(text).slice(0, 300);
  }
  let str = String(text).trim();
  str = str.replace(/^(?:执行失败\s*[:：]?\s*)+/i, "");
  try {
    const parsed = JSON.parse(str);
    return extractErrorMessage(parsed);
  } catch {}
  const jsonMatch = str.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const inner = parsed.error?.message || parsed.message || parsed.error;
      if (typeof inner === "string") {
        const prefix = str.slice(0, jsonMatch.index).replace(/^(?:执行失败\s*[:：]?\s*)+/i, "").trim();
        return prefix ? `${prefix} ${inner}` : inner;
      }
    } catch {}
  }
  const singleLine = str.replace(/[\r\n\t]+/g, " ").trim();
  return singleLine.length > 350 ? `${singleLine.slice(0, 350)}...` : singleLine;
}

export function parseRateLimitWaitSeconds(errorText) {
  if (!errorText || typeof errorText !== "string") return 0;
  const match =
    errorText.match(/retry after\s+(\d+)\s*s/i) ||
    errorText.match(/retry after\s+(\d+)\s*seconds?/i) ||
    errorText.match(/wait\s+(\d+)\s*s/i) ||
    errorText.match(/wait\s+(\d+)\s*seconds?/i);
  if (match) {
    const sec = parseInt(match[1], 10);
    if (!isNaN(sec) && sec > 0 && sec <= 120) {
      return sec;
    }
  }
  if (/rate limit exceeded|secondary rate limit|too many requests/i.test(errorText)) {
    return 35;
  }
  return 0;
}

export async function invokeMcpRawTool(serverInfo, rawName, args, onWaitNotice = null) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let res;
    try {
      res = await fetch(serverInfo.postEndpoint, {
        method: "POST",
        headers: serverInfo.headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: rawName, arguments: args }
        }),
        signal: AbortSignal.timeout(35000)
      });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (!res.ok) {
      const txt = await res.text();
      const waitSec = parseRateLimitWaitSeconds(txt);
      if (waitSec > 0 && attempt < maxRetries) {
        if (typeof onWaitNotice === "function") {
          onWaitNotice(waitSec);
        }
        addDebugLog("TOOL", `[频控保护] 接口调用触发限制，正在等待 ${waitSec + 1} 秒后自动重试...`);
        await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
        continue;
      }
      throw new Error(`MCP HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const data = await parseMcpResponse(res);
    if (data.error) {
      const errMsg = data.error.message || JSON.stringify(data.error);
      const waitSec = parseRateLimitWaitSeconds(errMsg);
      if (waitSec > 0 && attempt < maxRetries) {
        if (typeof onWaitNotice === "function") {
          onWaitNotice(waitSec);
        }
        addDebugLog("TOOL", `[频控保护] 接口调用触发限制，正在等待 ${waitSec + 1} 秒后自动重试...`);
        await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
        continue;
      }
      throw new Error(errMsg);
    }

    const rawResult = data.result !== undefined ? data.result : data;
    const isToolError = Boolean(rawResult && (rawResult.isError === true || rawResult.is_error === true));
    const textContent = extractMcpResultContent(data);

    if (isToolError) {
      const waitSec = parseRateLimitWaitSeconds(textContent);
      if (waitSec > 0 && attempt < maxRetries) {
        if (typeof onWaitNotice === "function") {
          onWaitNotice(waitSec);
        }
        addDebugLog("TOOL", `[频控保护] 工具返回频率限制错误，正在等待 ${waitSec + 1} 秒后自动重试...`);
        await new Promise((resolve) => setTimeout(resolve, (waitSec + 1) * 1000));
        continue;
      }
    }

    return { data, rawResult, isToolError, textContent };
  }
}

export function extractFileContentAndSha(mcpRes) {
  const { rawResult, textContent } = mcpRes;
  let fileContent = "";
  let fileSha = "";
  let fileBranch = "";

  if (rawResult && Array.isArray(rawResult.content)) {
    for (const item of rawResult.content) {
      if (!item) continue;
      if (item.type === "text" && item.text) {
        const shaMatch = item.text.match(/SHA:\s*([0-9a-f]{40})/i);
        if (shaMatch) {
          fileSha = shaMatch[1];
        }
        try {
          const parsed = JSON.parse(item.text);
          if (parsed && typeof parsed === "object" && typeof parsed.url === "string") {
            const refMatch = parsed.url.match(/[?&]ref=([^&#"\s]+)/i);
            if (refMatch && !fileBranch) {
              fileBranch = decodeURIComponent(refMatch[1]);
            }
          }
        } catch {}
      }
      if ((item.type === "resource" || item.type === "embedded_resource") && item.resource) {
        if (typeof item.resource.text === "string") {
          fileContent = item.resource.text;
        } else if (item.resource.blob) {
          try {
            fileContent = Buffer.from(item.resource.blob, "base64").toString("utf8");
          } catch {
            fileContent = item.resource.blob;
          }
        }
        if (typeof item.resource.uri === "string" && !fileBranch) {
          const uriBranchMatch = item.resource.uri.match(/\/refs\/heads\/([^/]+)\/contents\//i);
          if (uriBranchMatch) {
            fileBranch = decodeURIComponent(uriBranchMatch[1]);
          }
        }
      }
    }
  }

  if (!fileContent && textContent) {
    const shaMatch = textContent.match(/SHA:\s*([0-9a-f]{40})/i);
    if (shaMatch && !fileSha) {
      fileSha = shaMatch[1];
    }
    fileContent = textContent.replace(/^successfully downloaded[^\n]*\r?\n+/, "");
  }

  if (fileContent) {
    const resourceMatch = fileContent.match(/^Resource Text:\s*([\s\S]*?)(?:\r?\nResource URI:|\r?\nResource MIME Type:|$)/);
    if (resourceMatch) {
      fileContent = resourceMatch[1];
    }
  }

  if (!fileSha && textContent) {
    const firstLine = textContent.split("\n")[0] || "";
    const shaMatch = firstLine.match(/\b([0-9a-f]{40})\b/i);
    if (shaMatch) {
      fileSha = shaMatch[1];
    }
  }

  return { fileContent, fileSha, fileBranch };
}

function getOccurrenceIndices(str, target) {
  const indices = [];
  let pos = 0;
  while ((pos = str.indexOf(target, pos)) !== -1) {
    indices.push(pos);
    pos += Math.max(1, target.length);
  }
  return indices;
}

function mapLfIndexToCrlf(crlfStr, lfIndex) {
  let lfCount = 0;
  let crlfIndex = 0;
  while (lfCount < lfIndex && crlfIndex < crlfStr.length) {
    if (crlfStr[crlfIndex] === "\r" && crlfStr[crlfIndex + 1] === "\n") {
      crlfIndex += 2;
      lfCount += 1;
    } else {
      crlfIndex += 1;
      lfCount += 1;
    }
  }
  return crlfIndex;
}

// 词法单元提取：将代码分割为独立 token 并记录在原字符串中的起始与结束偏移
function tokenizeWithPositions(str) {
  const tokens = [];
  const regex = /[A-Za-z0-9_\u4e00-\u9fa5]+|[^\s\w]/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

// 第 5 层智能 Token-Stream 匹配：完全无视多余换行、空格、缩进与操作符间距
function findTokenStreamMatch(content, oldStr, newStr, searchOffset = 0) {
  const contentTokens = tokenizeWithPositions(content);
  const oldTokens = tokenizeWithPositions(oldStr);

  if (oldTokens.length === 0 || oldTokens.length > contentTokens.length) {
    return null;
  }

  const matches = [];
  const firstText = oldTokens[0].text;
  const mLen = oldTokens.length;

  for (let i = 0; i <= contentTokens.length - mLen; i += 1) {
    if (contentTokens[i].text !== firstText) continue;

    let match = true;
    for (let j = 1; j < mLen; j += 1) {
      if (contentTokens[i + j].text !== oldTokens[j].text) {
        match = false;
        break;
      }
    }
    if (match) {
      matches.push(i);
    }
  }

  if (matches.length === 0) return null;

  let chosenTokenIdx = matches[0];
  if (matches.length > 1) {
    const afterOffset = matches.filter((idx) => contentTokens[idx].start >= searchOffset);
    if (afterOffset.length === 1) {
      chosenTokenIdx = afterOffset[0];
    } else if (afterOffset.length > 1) {
      const lineNumbers = afterOffset.map((idx) => content.slice(0, contentTokens[idx].start).split("\n").length);
      return { multiple: true, lineNumbers };
    } else {
      const lineNumbers = matches.map((idx) => content.slice(0, contentTokens[idx].start).split("\n").length);
      return { multiple: true, lineNumbers };
    }
  }

  const startToken = contentTokens[chosenTokenIdx];
  const endToken = contentTokens[chosenTokenIdx + mLen - 1];

  let startChar = startToken.start;
  let endChar = endToken.end;

  // 检查首行缩进对齐：若原文件行首到第一 token 间全为空格，且新代码也包含整行结构，则整行替换
  const lineStart = content.lastIndexOf("\n", startChar - 1) + 1;
  const leadingInContent = content.slice(lineStart, startChar);

  let replacement = newStr;
  if (/^[ \t]+$/.test(leadingInContent)) {
    const oldLeading = oldStr.match(/^[ \t]+/)?.[0] || "";
    const newLeading = newStr.match(/^[ \t]+/)?.[0] || "";

    if (newLeading.startsWith(leadingInContent) || oldLeading.startsWith(leadingInContent)) {
      startChar = lineStart;
    } else if (newLeading !== leadingInContent) {
      // 自动对齐缩进：为新代码的每一行补齐原文件该位置特有的基准缩进
      const newLines = newStr.replace(/\r\n/g, "\n").split("\n");
      const aligned = newLines.map((line, idx) => {
        if (!line.trim()) return line;
        if (idx === 0) return line;
        if (line.startsWith(newLeading)) {
          return leadingInContent + line.slice(newLeading.length);
        }
        return leadingInContent + line;
      });
      replacement = content.includes("\r\n") ? aligned.join("\r\n") : aligned.join("\n");
    }
  }

  // 换行符统一
  if (content.includes("\r\n") && !replacement.includes("\r\n")) {
    replacement = replacement.replace(/\n/g, "\r\n");
  }

  return { start: startChar, end: endChar, replacement };
}

// 相似度近邻诊断：当匹配失败时，向大模型清晰指出文件当前哪一行最接近，实际代码是什么，从而激活自愈
function findNearMatchDiagnostic(content, oldStr) {
  const contentTokens = tokenizeWithPositions(content);
  const oldTokens = tokenizeWithPositions(oldStr);
  if (oldTokens.length < 4 || contentTokens.length < 4) return "";

  const mLen = oldTokens.length;
  let bestScore = 0;
  let bestIdx = -1;

  const step = Math.max(1, Math.floor(mLen / 10));
  const sampleIndices = [];
  for (let s = 0; s < mLen; s += step) {
    sampleIndices.push(s);
  }
  if (!sampleIndices.includes(mLen - 1)) {
    sampleIndices.push(mLen - 1);
  }
  const sampleTexts = sampleIndices.map((i) => oldTokens[i].text);

  const windowSize = Math.min(contentTokens.length, Math.floor(mLen * 1.5) + 5);
  for (let i = 0; i <= contentTokens.length - windowSize; i += Math.max(1, Math.floor(step / 2))) {
    let score = 0;
    const windowSlice = contentTokens.slice(i, i + windowSize);
    const windowSet = new Set(windowSlice.map((t) => t.text));

    for (const t of sampleTexts) {
      if (windowSet.has(t)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const similarity = bestScore / sampleTexts.length;
  if (similarity >= 0.55 && bestIdx >= 0) {
    const token = contentTokens[bestIdx];
    const lineNum = content.slice(0, token.start).split("\n").length;
    const lineStart = content.lastIndexOf("\n", token.start - 1) + 1;
    const lineEnd = content.indexOf("\n", token.start + 180);
    const actualSnippet = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
    return `在第 ${lineNum} 行附近发现了高度相似的代码（特征吻合度约 ${Math.round(similarity * 100)}%），但待替换内容与当前文件存在差异。该位置实际最新代码为: "${actualSnippet}"。请核准后重试。`;
  }
  return "";
}

function findLineBasedMatch(contentLf, oldStrLf, newStrLf, originalContentWithCrlf = null) {
  const contentLines = contentLf.split("\n");
  const oldLines = oldStrLf.split("\n");
  const isCrlf = Boolean(originalContentWithCrlf);

  if (oldLines.length === 0) return null;

  // 1. 去除行尾不可见字符精确匹配
  let matchedIndices = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i += 1) {
    let match = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (contentLines[i + j].trimEnd() !== oldLines[j].trimEnd()) {
        match = false;
        break;
      }
    }
    if (match) {
      matchedIndices.push(i);
    }
  }

  // 2. 去除首尾空格匹配
  let isFullTrim = false;
  if (matchedIndices.length === 0) {
    for (let i = 0; i <= contentLines.length - oldLines.length; i += 1) {
      let match = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (contentLines[i + j].trim() !== oldLines[j].trim()) {
          match = false;
          break;
        }
      }
      if (match) {
        matchedIndices.push(i);
      }
    }
    isFullTrim = matchedIndices.length > 0;
  }

  if (matchedIndices.length === 1) {
    const lineStart = matchedIndices[0];
    const lineEnd = lineStart + oldLines.length;
    const charStartLf = contentLines.slice(0, lineStart).join("\n").length + (lineStart > 0 ? 1 : 0);
    const matchedBlockLf = contentLines.slice(lineStart, lineEnd).join("\n");
    const charEndLf = charStartLf + matchedBlockLf.length;

    let replacementLf = newStrLf;
    if (isFullTrim && oldLines.length > 0) {
      const origFirstIndent = (contentLines[lineStart].match(/^(\s*)/) || ["", ""])[1];
      const modelFirstIndent = (oldLines[0].match(/^(\s*)/) || ["", ""])[1];
      if (origFirstIndent !== modelFirstIndent) {
        const newLines = newStrLf.split("\n");
        replacementLf = newLines
          .map((line) => {
            if (!line.trim()) return line;
            if (line.startsWith(modelFirstIndent)) {
              return origFirstIndent + line.slice(modelFirstIndent.length);
            }
            return origFirstIndent + line;
          })
          .join("\n");
      }
    }

    if (isCrlf) {
      const realStart = mapLfIndexToCrlf(originalContentWithCrlf, charStartLf);
      const realMatched = matchedBlockLf.replace(/\n/g, "\r\n");
      const realEnd = realStart + realMatched.length;
      return {
        start: realStart,
        end: realEnd,
        replacement: replacementLf.replace(/\n/g, "\r\n")
      };
    }

    return {
      start: charStartLf,
      end: charEndLf,
      replacement: replacementLf
    };
  }

  if (matchedIndices.length > 1) {
    return { multiple: true, lineNumbers: matchedIndices.map((idx) => idx + 1) };
  }

  return null;
}

function findBestSnippetMatch(content, oldStr, newStr, filePath, editIndex, searchOffset = 0) {
  const isCrlf = content.includes("\r\n");

  // 1. 原生精确匹配
  let idx = content.indexOf(oldStr, searchOffset);
  if (idx === -1 && searchOffset > 0) {
    idx = content.indexOf(oldStr);
  }
  if (idx !== -1) {
    const occurrences = getOccurrenceIndices(content, oldStr);
    if (occurrences.length === 1) {
      return { start: idx, end: idx + oldStr.length, replacement: newStr };
    }
    const afterOffset = occurrences.filter((o) => o >= searchOffset);
    if (afterOffset.length === 1) {
      const chosen = afterOffset[0];
      return { start: chosen, end: chosen + oldStr.length, replacement: newStr };
    }
    const lineNumbers = occurrences.map((o) => content.slice(0, o).split("\n").length);
    throw new Error(
      `在文件 ${filePath} 中第 ${editIndex} 处找到多处 (${occurrences.length} 处) 完全相同的待替换片段 (位于第 ${lineNumbers.join(", ")} 行)。为防止误替换，请在 old_str 中包含周围 1~2 行上下文代码以确保唯一性。待查找代码: ${oldStr.slice(0, 100)}`
    );
  }

  // 2. 换行符 LF 归一化匹配
  const contentLf = content.replace(/\r\n/g, "\n");
  const oldStrLf = oldStr.replace(/\r\n/g, "\n");
  const newStrLf = newStr.replace(/\r\n/g, "\n");

  let lfIdx = contentLf.indexOf(oldStrLf);
  if (lfIdx !== -1) {
    const occurrences = getOccurrenceIndices(contentLf, oldStrLf);
    if (occurrences.length === 1) {
      const realStart = isCrlf ? mapLfIndexToCrlf(content, lfIdx) : lfIdx;
      const matchedText = isCrlf ? oldStrLf.replace(/\n/g, "\r\n") : oldStrLf;
      return {
        start: realStart,
        end: realStart + matchedText.length,
        replacement: isCrlf ? newStrLf.replace(/\n/g, "\r\n") : newStrLf
      };
    }
    const lineNumbers = occurrences.map((o) => contentLf.slice(0, o).split("\n").length);
    throw new Error(
      `在文件 ${filePath} 中第 ${editIndex} 处找到多处 (${occurrences.length} 处) 完全相同的待替换片段 (位于第 ${lineNumbers.join(", ")} 行)。为防止误替换，请在 old_str 中包含周围 1~2 行上下文代码以确保唯一性。待查找代码: ${oldStr.slice(0, 100)}`
    );
  }

  // 3. 去除首尾空白后匹配
  const trimmedOld = oldStrLf.trim();
  if (trimmedOld) {
    const trimmedOccurrences = getOccurrenceIndices(contentLf, trimmedOld);
    if (trimmedOccurrences.length === 1) {
      const tIdx = trimmedOccurrences[0];
      const realStart = isCrlf ? mapLfIndexToCrlf(content, tIdx) : tIdx;
      const matchedText = isCrlf ? trimmedOld.replace(/\n/g, "\r\n") : trimmedOld;
      return {
        start: realStart,
        end: realStart + matchedText.length,
        replacement: isCrlf ? newStr.replace(/\r?\n/g, "\r\n") : newStr.replace(/\r\n/g, "\n")
      };
    }
  }

  // 4. 行级修剪容错匹配
  const lineMatch = findLineBasedMatch(contentLf, oldStrLf, newStrLf, isCrlf ? content : null);
  if (lineMatch) {
    if (lineMatch.multiple) {
      throw new Error(
        `在文件 ${filePath} 中第 ${editIndex} 处行级匹配到多处 (${lineMatch.lineNumbers.length} 处) 相似片段 (位于第 ${lineMatch.lineNumbers.join(", ")} 行)。请在 old_str 中包含周围上下文代码以唯一确定修改位置。`
      );
    }
    return lineMatch;
  }

  // 5. 终极 Token-Stream 匹配：无视空白缩进与空行差异
  const tokenMatch = findTokenStreamMatch(content, oldStr, newStr, searchOffset);
  if (tokenMatch) {
    if (tokenMatch.multiple) {
      throw new Error(
        `在文件 ${filePath} 中第 ${editIndex} 处语法匹配到多处 (${tokenMatch.lineNumbers.length} 处) 相似片段 (位于第 ${tokenMatch.lineNumbers.join(", ")} 行)。请在 old_str 中包含更多上下文代码以确保唯一性。`
      );
    }
    return tokenMatch;
  }

  // 若以上全未命中，调用近邻分析给出有价值的诊断提示
  const diagnostic = findNearMatchDiagnostic(content, oldStr);
  throw new Error(
    `在文件 ${filePath} 中未找到第 ${editIndex} 处待替换片段 (old_str)。${diagnostic ? `\n【智能诊断】${diagnostic}\n` : ""}待查找片段预览:\n${oldStr.slice(0, 200)}`
  );
}

export function applyStringReplacements(content, edits, filePath = "") {
  let updated = content;
  let lastEnd = 0;

  for (let i = 0; i < edits.length; i += 1) {
    const { old_str, new_str } = edits[i];
    if (typeof old_str !== "string" || typeof new_str !== "string") {
      throw new Error(`第 ${i + 1} 处修改参数错误：old_str 与 new_str 必须为字符串`);
    }
    if (old_str === new_str) {
      throw new Error(`第 ${i + 1} 处修改无效：old_str 与 new_str 完全相同`);
    }

    const match = findBestSnippetMatch(updated, old_str, new_str, filePath, i + 1, lastEnd);
    if (!match) {
      throw new Error(
        `在文件 ${filePath} 中未找到第 ${i + 1} 处待替换片段 (old_str)。请核对代码内容、空格缩进及换行是否准确。待查找片段预览:\n${old_str.slice(0, 200)}`
      );
    }

    updated = updated.slice(0, match.start) + match.replacement + updated.slice(match.end);
    lastEnd = match.start + match.replacement.length;
  }

  return updated;
}

export async function executeGithubEditFile(serverInfo, readToolRawName, writeToolRawName, args, onWaitNotice = null) {
  const { owner, repo, path: filePath, old_str, new_str, edits, message, branch } = args || {};

  if (!owner || !repo || !filePath) {
    throw new Error("缺少必需参数：owner, repo, path");
  }

  let editList = [];
  if (Array.isArray(edits) && edits.length > 0) {
    editList = edits;
  } else if (typeof old_str === "string" && typeof new_str === "string") {
    editList = [{ old_str, new_str }];
  } else {
    throw new Error("必须提供 old_str 与 new_str，或 edits 数组");
  }

  const getArgs = { owner, repo, path: filePath };
  if (branch) {
    getArgs.ref = branch;
  }

  addDebugLog("TOOL", `[局部编辑] 读取文件: ${owner}/${repo}/${filePath} (分支: ${branch || "默认"})`);
  const getRes = await invokeMcpRawTool(serverInfo, readToolRawName, getArgs, onWaitNotice);
  if (getRes.isToolError) {
    throw new Error(`读取文件失败: ${getRes.textContent.slice(0, 300)}`);
  }

  const { fileContent, fileSha, fileBranch } = extractFileContentAndSha(getRes);
  if (!fileSha) {
    throw new Error(`未能获取到文件 SHA，请确认文件是否存在: ${filePath}`);
  }

  const updatedContent = applyStringReplacements(fileContent, editList, filePath);

  if (updatedContent === fileContent) {
    throw new Error("替换前后文件内容未发生任何改变");
  }

  let targetBranch = (branch || "").trim() || fileBranch;
  if (!targetBranch) {
    const branchTool = findServerTool(serverInfo, ["list_branches"]);
    if (branchTool) {
      try {
        const branchRes = await invokeMcpRawTool(serverInfo, branchTool.rawName, { owner, repo }, onWaitNotice);
        if (!branchRes.isToolError && branchRes.textContent) {
          const names = Array.from(branchRes.textContent.matchAll(/"name"\s*:\s*"([^"]+)"/g), (m) => m[1]);
          if (names.length > 0) {
            targetBranch = names.includes("main") ? "main" : (names.includes("master") ? "master" : names[0]);
          }
        }
      } catch {}
    }
  }
  if (!targetBranch) {
    targetBranch = "main";
  }

  const commitMsg = (message || "").trim() || `Update ${filePath}`;
  const putArgs = {
    owner,
    repo,
    path: filePath,
    content: updatedContent,
    message: commitMsg,
    sha: fileSha,
    branch: targetBranch
  };

  addDebugLog("TOOL", `[局部编辑] 提交更新到 GitHub: ${owner}/${repo}/${filePath} (SHA: ${fileSha})`);
  const putRes = await invokeMcpRawTool(serverInfo, writeToolRawName, putArgs, onWaitNotice);
  if (putRes.isToolError) {
    throw new Error(`提交更新失败: ${putRes.textContent.slice(0, 300)}`);
  }

  return {
    isError: false,
    content: `局部修改成功并已提交到 GitHub。仓库: ${owner}/${repo}，文件: ${filePath}，分支: ${targetBranch}，修改处数: ${editList.length}，原文件 SHA: ${fileSha}`
  };
}

export function findServerTool(serverInfo, targetNames) {
  if (!Array.isArray(serverInfo.tools)) return null;
  return serverInfo.tools.find((t) =>
    targetNames.some((n) => t.rawName === n || t.rawName.endsWith(`_${n}`))
  );
}

export function registerVirtualTools(serverInfo) {
  if (!serverInfo || !Array.isArray(serverInfo.tools)) return;
  const readTool = findServerTool(serverInfo, ["get_file_contents"]);
  const writeTool = findServerTool(serverInfo, ["create_or_update_file"]);
  if (!readTool || !writeTool) return;

  const serverNameLower = (serverInfo.name || "").toLowerCase();
  const safePrefix = serverNameLower.replace(/[^a-z0-9_]/g, "_");
  const virtualRawName = readTool.rawName.startsWith("github_") || serverNameLower.includes("github")
    ? "github_edit_file"
    : "edit_file";

  const toolKey = virtualRawName.startsWith(`${safePrefix}_`)
    ? virtualRawName
    : `${safePrefix}_${virtualRawName}`;

  let virtualTool = serverInfo.tools.find((t) => t.key === toolKey || t.rawName === virtualRawName);
  if (!virtualTool) {
    virtualTool = {
      key: toolKey,
      rawName: virtualRawName,
      description: `[${serverInfo.name}] 局部编辑 GitHub 文件`,
      enabled: true,
      status: "supported",
      statusMessage: "支持",
      isVirtual: true,
      openAiTool: {
        type: "function",
        function: {
          name: toolKey,
          description: `[${serverInfo.name}] 局部编辑 GitHub 仓库中的指定文件。通过比对替换指定的代码片段（old_str -> new_str），自动拉取最新文件、完成局部替换并提交更新，无需全量读取或全量重写。`,
          parameters: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "仓库所有者 (用户名或组织名)"
              },
              repo: {
                type: "string",
                description: "仓库名称"
              },
              path: {
                type: "string",
                description: "要修改的文件路径"
              },
              old_str: {
                type: "string",
                description: "待替换的原始代码片段。必须在文件中唯一存在，建议包含周围几行上下文以确保唯一性。"
              },
              new_str: {
                type: "string",
                description: "替换后的新代码片段。"
              },
              edits: {
                type: "array",
                description: "可选的多处同时替换列表。每项包含 old_str 与 new_str。若提供此项则按顺序批量替换。",
                items: {
                  type: "object",
                  properties: {
                    old_str: { type: "string", description: "待替换的代码片段" },
                    new_str: { type: "string", description: "替换后的新代码片段" }
                  },
                  required: ["old_str", "new_str"]
                }
              },
              message: {
                type: "string",
                description: "Git 提交说明"
              },
              branch: {
                type: "string",
                description: "目标分支名称 (可选，默认使用仓库默认分支)"
              }
            },
            required: ["owner", "repo", "path", "message"]
          }
        }
      }
    };
    serverInfo.tools.unshift(virtualTool);
    serverInfo.toolCount = serverInfo.tools.length;
  } else {
    virtualTool.isVirtual = true;
    virtualTool.status = "supported";
    virtualTool.statusMessage = "支持";
  }

  if (serverInfo.status === "active" && virtualTool.enabled !== false) {
    mcpToolRegistry.set(toolKey, {
      serverId: serverInfo.id,
      serverName: serverInfo.name,
      rawName: virtualRawName,
      isVirtual: true,
      handler: async (args, onWaitNotice) => {
        return await executeGithubEditFile(serverInfo, readTool.rawName, writeTool.rawName, args, onWaitNotice);
      }
    });
  }
}

export async function callMcpTool(toolKey, args, onWaitNotice = null) {
  const info = findToolInfo(toolKey);
  if (!info) throw new Error(`未找到工具：${toolKey}`);

  const isCfExecute =
    (toolKey.toLowerCase().includes("cloudflare") || (info?.serverName || "").toLowerCase().includes("cloudflare")) &&
    (toolKey.endsWith("execute") || info?.rawName === "execute");

  if (isCfExecute && typeof args?.code === "string") {
    const rawCode = args.code;
    if (
      rawCode.includes("DEFAULT_BASE_URL") ||
      /fetch\s*\(\s*[`'"]https?:\/\/api\.cloudflare\.com/i.test(rawCode) ||
      /fetch\s*\(\s*DEFAULT_BASE_URL/i.test(rawCode)
    ) {
      return {
        isError: true,
        content: JSON.stringify({
          error:
            "【Cloudflare execute 规范拦截】检测到代码中试图自行定义 DEFAULT_BASE_URL 或使用原生 fetch 请求 Cloudflare API。沙箱中已内置注入了带有鉴权的全局客户端 `cloudflare.request({ method, path, body })` 与全局变量 `accountId`。直接使用原生 fetch 会因缺少内置鉴权被 Cloudflare 拦截并返回 403 Forbidden（导致 Unexpected token 'F' 报错）。请改用 `return await cloudflare.request({ method: 'GET', path: `/accounts/${accountId}/...` })` 格式。"
        })
      };
    }
  }

  const startTime = Date.now();
  if (typeof info.handler === "function") {
    try {
      const res = await info.handler(args, onWaitNotice);
      const duration = Date.now() - startTime;
      const isError = Boolean(res && res.isError);
      const content = typeof res?.content === "string" ? res.content : JSON.stringify(res || {});
      addDebugLog(isError ? "ERROR" : "TOOL", `虚拟 MCP 工具 [${toolKey}] 执行${isError ? "失败" : "成功"} - 耗时 ${duration}ms`, {
        arguments: args,
        outputPreview: content.slice(0, 500)
      });
      return { isError, content };
    } catch (err) {
      const duration = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);
      addDebugLog("ERROR", `虚拟 MCP 工具 [${toolKey}] 异常 - 耗时 ${duration}ms`, msg);
      return { isError: true, content: JSON.stringify({ error: msg }) };
    }
  }

  try {
    const { rawResult, isToolError, textContent } = await invokeMcpRawTool(info, info.rawName, args, onWaitNotice);
    const duration = Date.now() - startTime;
    if (isToolError) {
      let refinedContent = textContent;
      if (isCfExecute && (textContent.includes("Unexpected token 'F'") || textContent.includes("Forbidden"))) {
        refinedContent = `${textContent}\n\n【诊断指引】此报错通常是因为在 execute 脚本中使用了原生 fetch 请求 Cloudflare 接口导致被 403 拦截并返回纯文本。请使用沙箱内置的 \`cloudflare.request({ method, path, body })\` 与全局变量 \`accountId\`，严禁在脚本中自拼 URL 或裸调 fetch。`;
      }
      addDebugLog("ERROR", `MCP 工具 [${toolKey}] 返回错误 - 耗时 ${duration}ms`, {
        arguments: args,
        errorOutput: refinedContent.slice(0, 500)
      });
      return { isError: true, content: refinedContent };
    }
    addDebugLog("TOOL", `MCP 工具 [${toolKey}] 执行成功 - 耗时 ${duration}ms, 输出 ${textContent.length} 字符`, {
      arguments: args,
      outputPreview: textContent.slice(0, 500)
    });
    return { isError: false, content: textContent };
  } catch (err) {
    const duration = Date.now() - startTime;
    let msg = err instanceof Error ? err.message : String(err);
    if (isCfExecute && (msg.includes("Unexpected token 'F'") || msg.includes("Forbidden"))) {
      msg = `${msg} (诊断指引: 请使用沙箱内置的 cloudflare.request 与 accountId，严禁使用原生 fetch 或自拼 DEFAULT_BASE_URL)`;
    }
    addDebugLog("ERROR", `MCP 工具 [${toolKey}] 异常 - 耗时 ${duration}ms`, msg);
    throw (err instanceof Error ? new Error(msg) : new Error(String(msg)));
  }
}

export function getAllTools() {
  const tools = [];
  for (const s of mcpServers.values()) {
    if (s.status === "active") {
      for (const t of s.tools) {
        if (t.enabled !== false) {
          tools.push(t.openAiTool);
        }
      }
    }
  }
  return tools;
}

export function selectRelevantTools(userText, allTools) {
  if (!allTools || allTools.length === 0) {
    return [];
  }
  if (!userText || typeof userText !== "string") {
    return allTools;
  }

  const text = userText.toLowerCase();
  const scored = allTools.map((t) => {
    const name = (t.function?.name || "").toLowerCase();
    const desc = (t.function?.description || "").toLowerCase();
    let score = 0;

    const parts = name.split(/[^a-z0-9]+/);
    for (const p of parts) {
      if (p.length >= 3 && text.includes(p)) {
        score += 3;
      }
    }

    if (text.includes("git") || text.includes("github") || text.includes("仓库") || text.includes("提交") || text.includes("push")) {
      if (name.includes("git") || name.includes("push") || name.includes("commit") || name.includes("file") || name.includes("branch")) {
        score += 5;
      }
    }

    if (text.includes("改") || text.includes("写") || text.includes("修") || text.includes("创建") || text.includes("更新") || text.includes("替换")) {
      if (name.includes("write") || name.includes("push") || name.includes("create") || name.includes("update") || name.includes("edit")) {
        score += 5;
      }
    }

    if (text.includes("搜索") || text.includes("查") || text.includes("search")) {
      if (name.includes("search") || desc.includes("search") || desc.includes("搜索")) {
        score += 5;
      }
    }

    return { tool: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.tool);
}

export function isWriteTool(toolName) {
  if (!toolName || typeof toolName !== "string") return false;
  const lower = toolName.toLowerCase();
  const writePatterns = [
    "write", "create", "update", "delete", "edit", "patch",
    "push", "modify", "merge", "fork", "cancel", "rerun",
    "trigger", "comment", "star", "unstar", "manage"
  ];
  return writePatterns.some((pattern) => lower.includes(pattern));
}

export async function checkAllTools(modelName) {
  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("请先配置 UPSTREAM_1 等上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  let targetModel = (modelName || "").trim();
  if (!targetModel && enabledModels.size > 0) {
    for (const m of enabledModels) {
      const clean = m.replace(/\*/g, "").trim();
      if (clean) {
        targetModel = clean;
        break;
      }
    }
  }

  if (!targetModel) {
    throw new Error("未指定检测模型，请在输入框中指定要测试的上游模型名称");
  }

  let pingRes;
  try {
    pingRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channel.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    throw new Error(`上游请求失败: ${err.message}。未修改任何工具状态`);
  }

  if (!pingRes.ok) {
    const errText = await pingRes.text();
    let msg = errText;
    try {
      const errJson = JSON.parse(errText);
      msg = errJson.error?.message || errText;
    } catch {}
    throw new Error(`上游模型 [${targetModel}] 调用报错 (${pingRes.status}): ${msg.slice(0, 120)}。未修改任何工具状态`);
  }

  let total = 0;
  let supported = 0;
  let unsupported = 0;

  for (const s of mcpServers.values()) {
    if (!Array.isArray(s.tools) || s.tools.length === 0) continue;

    for (const t of s.tools) {
      total += 1;

      if (t.isVirtual) {
        supported += 1;
        t.status = "supported";
        t.statusMessage = "支持";
        t.enabled = true;
        if (s.status === "active") {
          registerVirtualTools(s);
        }
        continue;
      }

      let isSupported = true;
      let reason = "";

      try {
        const testRes = await fetch(targetUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${channel.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: targetModel,
            messages: [{ role: "user", content: "test" }],
            tools: [t.openAiTool],
            max_tokens: 1
          }),
          signal: AbortSignal.timeout(20000)
        });

        if (testRes.ok) {
          isSupported = true;
        } else {
          const errText = await testRes.text();
          let msg = errText;
          try {
            const errJson = JSON.parse(errText);
            msg = errJson.error?.message || errText;
          } catch {}
          if (testRes.status === 400 || testRes.status === 422) {
            isSupported = false;
            reason = msg.slice(0, 100);
          } else {
            isSupported = true;
          }
        }
      } catch {
        isSupported = true;
      }

      if (isSupported) {
        supported += 1;
        t.status = "supported";
        t.statusMessage = "支持";
        t.enabled = true;
        if (s.status === "active") {
          mcpToolRegistry.set(t.key, {
            serverId: s.id,
            serverName: s.name,
            rawName: t.rawName,
            postEndpoint: s.postEndpoint,
            headers: s.headers
          });
        }
      } else {
        unsupported += 1;
        t.status = "unsupported";
        t.statusMessage = reason || "参数格式不支持";
        t.enabled = false;
        mcpToolRegistry.delete(t.key);
      }
    }

    await saveServerToStorage();
  }

  addDebugLog("AGENT", `AI一键检测完成 - 渠道 [${channel.name}] - 测试模型 [${targetModel}] - 共 ${total} 个工具，支持 ${supported} 个，不支持已自动禁用 ${unsupported} 个`);
  return { total, supported, unsupported, model: targetModel };
}

export async function loadMcpServersFromStorage() {
  const list = await getStoredServers();
  for (const item of list) {
    const status = item.status || "active";
    item.status = status;
    for (const t of item.tools || []) {
      t.enabled = typeof t.enabled === "boolean" ? t.enabled : true;
      t.status = t.status || "unchecked";
      t.statusMessage = t.statusMessage || "";
    }
    mcpServers.set(item.id, item);
    registerVirtualTools(item);
    if (status === "active") {
      for (const t of item.tools || []) {
        if (t.enabled !== false && !t.isVirtual) {
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
  }
}
