import crypto from "node:crypto";
import {
  getActiveChannel,
  upstreamChatCompletionsUrl,
  addDebugLog,
  sendJson,
  setCorsHeaders,
  enabledModels,
  mcpToolRegistry
} from "./store.js";
import {
  callMcpTool,
  findToolInfo,
  getAllTools,
  selectRelevantTools,
  isWriteTool,
  extractErrorMessage
} from "./mcp.js";

export function createCombinedSignal(userSignal, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Upstream request timed out after ${timeoutMs / 1000}s`));
  }, timeoutMs);

  const onUserAbort = () => {
    clearTimeout(timer);
    controller.abort(userSignal?.reason || new Error("Client aborted"));
  };

  if (userSignal) {
    if (userSignal.aborted) {
      clearTimeout(timer);
      controller.abort(userSignal.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    userSignal.addEventListener("abort", onUserAbort, { once: true });
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (userSignal) {
      userSignal.removeEventListener("abort", onUserAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

export function compactContextMessages(messages, maxChars = 200000, activeFileCount = 5) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const totalChars = messages.reduce((sum, m) => sum + (typeof m?.content === "string" ? m.content.length : 0), 0);
  if (totalChars <= maxChars) {
    return messages;
  }

  // 1. 扫描所有 tool_calls，建立 tool_call_id 到文件路径和工具类型的映射
  const toolCallMap = new Map();
  const modifiedFiles = new Set();

  for (const m of messages) {
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc?.id) continue;
        const name = (tc.function?.name || tc.name || "").toLowerCase();
        const args = toolArguments(tc) || {};
        const filePath = args.path || args.file || args.filePath || "";
        toolCallMap.set(tc.id, { name, path: filePath, isWrite: isWriteTool(name) });
        if (filePath && isWriteTool(name)) {
          modifiedFiles.add(filePath);
        }
      }
    }
  }

  // 2. 从后往前扫描，确定最近活跃的 N 个文件（绝对保留 100% 完整源码）
  const activeFiles = new Set(modifiedFiles);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "tool" && m.tool_call_id) {
      const meta = toolCallMap.get(m.tool_call_id);
      if (meta?.path && !activeFiles.has(meta.path)) {
        activeFiles.add(meta.path);
        if (activeFiles.size >= activeFileCount + modifiedFiles.size) {
          break;
        }
      }
    }
  }

  // 3. 对超出活跃窗口的历史文件与过长非代码消息进行智能收敛
  let currentTotal = totalChars;
  for (let i = 0; i < messages.length - 10; i += 1) {
    if (currentTotal <= maxChars) break;
    const m = messages[i];
    if (!m || m.role !== "tool" || typeof m.content !== "string") continue;

    const meta = toolCallMap.get(m.tool_call_id) || {};
    const filePath = meta.path || "";
    const isFileContent = m.content.startsWith("successfully downloaded text file") || m.content.startsWith("Resource Text:") || meta.name?.includes("file");

    if (isFileContent) {
      // 若该文件是最新活跃文件或曾被修改，严禁触碰，保留 100% 完整源码
      if (filePath && activeFiles.has(filePath)) {
        continue;
      }
      // 仅对非活跃的历史陈旧文件折叠中间实现代码，保留前 2200 字符骨架和后 400 字符闭合
      if (m.content.length > 5000) {
        const origLen = m.content.length;
        const head = m.content.slice(0, 2200);
        const tail = m.content.slice(-400);
        m.content = `${head}\n\n// ... [已折叠该历史已读文件的中间实现代码 (原文件共 ${origLen} 字符)。该文件已在早期轮次完成分析。如需对该文件进行精确局部编辑，请直接调用 get_file_contents 重新读取] ...\n\n${tail}`;
        currentTotal -= (origLen - m.content.length);
      }
    } else if (m.content.length > 6000) {
      // 早期过长非代码输出（如目录树、commit 记录、workflow 列表）温和精简
      const origLen = m.content.length;
      m.content = m.content.slice(0, 3000) + "\n\n[早期查询结果已自动精简，核心信息已在历史对话中提取]";
      currentTotal -= (origLen - m.content.length);
    }
  }

  return messages;
}

export function formatCardMarkdown(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/([^\n\r])\s*(目标说明[：:])/g, "$1\n\n$2")
    .replace(/([^\n\r])\s*(调用工具[：:])/g, "$1\n$2")
    .replace(/([^\n\r])\s*(检索内容[：:])/g, "$1\n$2");
}

export function parseContentArg(contentArg, paramsSchema = {}, contextText = "") {
  let parsedArgs = {};
  if (!contentArg || typeof contentArg !== "string") return parsedArgs;
  const raw = contentArg.trim();

  // 1. JSON 格式解析
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      parsedArgs = JSON.parse(raw);
      if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
        return coerceArgTypes(parsedArgs, paramsSchema);
      }
    } catch {}
    parsedArgs = {};
  }

  // 2. 键值对提取（支持中英文键名与全角半角冒号）
  const kvRegex = /([\w\u4e00-\u9fa5]+)\s*[:：]\s*([^,\n\r;]+)/g;
  let match;
  while ((match = kvRegex.exec(raw)) !== null) {
    const rawKey = match[1].trim().toLowerCase();
    const val = match[2].trim().replace(/^`+|`+$/g, "");

    if (/^(?:仓库|repo|repository|项目)$/.test(rawKey)) {
      if (val.includes("/")) {
        const slashIdx = val.indexOf("/");
        parsedArgs.owner = val.slice(0, slashIdx).trim();
        parsedArgs.repo = val.slice(slashIdx + 1).trim();
      } else {
        parsedArgs.repo = val;
      }
    } else if (/^(?:所有者|owner|user|用户|组织|org)$/.test(rawKey)) {
      parsedArgs.owner = val;
    } else if (/^(?:路径|path|文件|file|filepath|filename)$/.test(rawKey)) {
      parsedArgs.path = val;
    } else if (/^(?:分支|branch|ref|引用)$/.test(rawKey)) {
      parsedArgs.branch = val;
      parsedArgs.ref = val;
    } else if (/^(?:说明|message|commit|msg)$/.test(rawKey)) {
      parsedArgs.message = val;
    } else if (/^(?:查询|query|q|检索)$/.test(rawKey)) {
      parsedArgs.query = val;
      parsedArgs.q = val;
    } else if (/^(?:动作|action|method|操作)$/.test(rawKey)) {
      parsedArgs.action = val;
      parsedArgs.method = val;
    } else if (/^(?:递归|recursive)$/.test(rawKey)) {
      parsedArgs.recursive = val;
    } else if (/^(?:代码|code|脚本)$/.test(rawKey)) {
      parsedArgs.code = val;
    } else if (/^(?:网址|url|start_url|地址)$/.test(rawKey)) {
      parsedArgs.url = val;
      parsedArgs.start_url = val;
    } else if (/^(?:会话|session|session_id)$/.test(rawKey)) {
      parsedArgs.session_id = val;
    } else if (/^(?:old_str|待替换代码|原始代码)$/.test(rawKey)) {
      parsedArgs.old_str = val;
    } else if (/^(?:new_str|新代码|替换后代码)$/.test(rawKey)) {
      parsedArgs.new_str = val;
    } else {
      parsedArgs[rawKey] = val;
    }
  }

  // 3. 兜底提取 owner / repo
  const repoMatchInRaw = raw.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/);
  if (repoMatchInRaw) {
    if (!parsedArgs.owner || parsedArgs.owner === "Wu22") parsedArgs.owner = repoMatchInRaw[1].trim();
    if (!parsedArgs.repo || parsedArgs.repo === "Wu22") parsedArgs.repo = repoMatchInRaw[2].trim();
  }

  // 若 owner 或 repo 依然缺失，从上下文 contextText 中寻找诸如 Wu2200/OpenMCP
  if ((paramsSchema.owner || paramsSchema.repo) && (!parsedArgs.owner || !parsedArgs.repo || parsedArgs.owner === "Wu22")) {
    const ctxRepoMatch = contextText.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/);
    if (ctxRepoMatch) {
      if (!parsedArgs.owner || parsedArgs.owner === "Wu22") parsedArgs.owner = ctxRepoMatch[1].trim();
      if (!parsedArgs.repo || parsedArgs.repo === "Wu22") parsedArgs.repo = ctxRepoMatch[2].trim();
    }
  }

  // 4. 兜底提取 path
  if (paramsSchema.path && !parsedArgs.path) {
    const pathMatch =
      raw.match(/(?:路径|path|文件|file)[:：\s]*([^\s,;，；]+(?:\.[a-zA-Z0-9_]+|\/[^\s,;，；]+))/i) ||
      raw.match(/\b([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9_]+)\b/);
    if (pathMatch) {
      parsedArgs.path = pathMatch[1].trim();
    }
  }

  // 5. 过滤清洗
  const result = {};
  for (const [k, v] of Object.entries(parsedArgs)) {
    if (paramsSchema[k]) {
      result[k] = v;
    }
  }

  if (paramsSchema.owner && parsedArgs.owner) result.owner = parsedArgs.owner;
  if (paramsSchema.repo && parsedArgs.repo) result.repo = parsedArgs.repo;
  if (paramsSchema.path && parsedArgs.path) result.path = parsedArgs.path;
  if (paramsSchema.branch && parsedArgs.branch) result.branch = parsedArgs.branch;
  if (paramsSchema.ref && parsedArgs.ref) result.ref = parsedArgs.ref;
  if (paramsSchema.recursive !== undefined && parsedArgs.recursive !== undefined) {
    result.recursive = parsedArgs.recursive;
  }

  // 6. 如果仍然未得到任何参数，回退到 schema 单一参数
  if (Object.keys(result).length === 0) {
    if (paramsSchema.query) result.query = raw;
    else if (paramsSchema.q) result.q = raw;
    else if (paramsSchema.path) result.path = raw;
    else if (paramsSchema.files) result.files = [raw];
    else {
      const properties = Object.keys(paramsSchema);
      if (properties.length === 1) result[properties[0]] = raw;
    }
  }

  return coerceArgTypes(result, paramsSchema);
}

function coerceArgTypes(args, schema = {}) {
  const coerced = { ...args };
  for (const [key, val] of Object.entries(coerced)) {
    const propSchema = schema[key] || {};
    const expectedType = propSchema.type;

    if (expectedType === "boolean" || typeof val === "boolean") {
      if (typeof val === "string") {
        const lower = val.trim().toLowerCase();
        coerced[key] = lower === "true" || lower === "1" || lower === "yes";
      }
    } else if (expectedType === "number" || expectedType === "integer") {
      if (typeof val === "string" && /^-?\d+(?:\.\d+)?$/.test(val.trim())) {
        coerced[key] = Number(val.trim());
      }
    } else if (typeof val === "string") {
      if (val.trim().toLowerCase() === "true" && propSchema.type === "boolean") {
        coerced[key] = true;
      } else if (val.trim().toLowerCase() === "false" && propSchema.type === "boolean") {
        coerced[key] = false;
      }
    }
  }
  return coerced;
}

export function parseTextToolCalls(text, activeTools, contextText = "", requireTrailingNewlineOnLast = false) {
  if (!text || typeof text !== "string" || !Array.isArray(activeTools) || activeTools.length === 0) {
    return [];
  }
  const cleanText = formatCardMarkdown(text);
  const regex = /目标说明[：:]\s*([^\n\r]*)\r?\n+调用工具[：:]\s*`?([a-zA-Z0-9_\-]+)`?\r?\n+检索内容[：:]\s*`?([^\n\r`]+)`?(?=(?:\r?\n|$))/g;
  const calls = [];
  let match;

  while ((match = regex.exec(cleanText)) !== null) {
    // 若在流式实时检测阶段要求最后一张卡片必须已经输出完换行符，则检查匹配末尾是否已有换行
    if (requireTrailingNewlineOnLast) {
      const afterMatch = cleanText.slice(match.index + match[0].length);
      if (!/^\r?\n/.test(afterMatch)) {
        continue;
      }
    }

    const rawToolName = match[2].trim();
    let contentArg = match[3].trim().replace(/^`+|`+$/g, "").trim();

    const resolvedInfo = findToolInfo(rawToolName);
    const matchedTool = activeTools.find((t) => {
      if (!t) return false;
      const toolName = t.function?.name || t.name || "";
      if (!toolName) return false;
      if (resolvedInfo && (toolName === resolvedInfo.key || toolName === resolvedInfo.rawName)) {
        return true;
      }
      return (
        toolName === rawToolName ||
        toolName.endsWith(`_${rawToolName}`) ||
        rawToolName.endsWith(`_${toolName}`) ||
        rawToolName.endsWith(toolName)
      );
    });

    if (!matchedTool && !resolvedInfo) continue;
    const finalToolName = resolvedInfo?.key || matchedTool?.function?.name || matchedTool?.name || rawToolName;
    const paramsSchema =
      matchedTool?.function?.parameters?.properties ||
      matchedTool?.parameters?.properties ||
      resolvedInfo?.openAiTool?.function?.parameters?.properties ||
      {};

    const parsedArgs = parseContentArg(contentArg, paramsSchema, contextText || text);

    calls.push({
      id: `call_text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: finalToolName,
      arguments: JSON.stringify(parsedArgs),
      goal: match[1].trim()
    });
  }

  return calls;
}

export function toolArguments(toolCall) {
  try {
    const raw = toolCall.function?.arguments ?? toolCall.arguments;
    if (typeof raw === "object" && raw !== null) return raw;
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  } catch {
    return null;
  }
}

export async function executeConcurrentPool(items, concurrency, workerFn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const poolSize = Math.min(concurrency, items.length);
  const workers = Array.from({ length: poolSize }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await workerFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function formatToolCallDetails(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];

  if (args.action) {
    parts.push(`动作: ${args.action}`);
  }

  if (args.method) {
    parts.push(`操作: ${args.method}`);
  }

  if (args.owner && args.repo) {
    parts.push(`仓库: ${args.owner}/${args.repo}`);
  } else if (args.repo) {
    parts.push(`仓库: ${args.repo}`);
  } else if (args.owner) {
    parts.push(`所有者: ${args.owner}`);
  }

  if (args.path) {
    parts.push(`路径: ${args.path}`);
  } else if (args.file || args.filePath || args.filename) {
    parts.push(`文件: ${args.file || args.filePath || args.filename}`);
  }

  if (args.resource_id) {
    parts.push(`资源ID: ${args.resource_id}`);
  } else if (args.run_id) {
    parts.push(`运行ID: ${args.run_id}`);
  } else if (args.job_id) {
    parts.push(`任务ID: ${args.job_id}`);
  }

  if (args.recursive !== undefined) {
    parts.push(`递归: ${args.recursive}`);
  }

  if (args.old_str !== undefined && args.new_str !== undefined) {
    parts.push(`局部替换 (${String(args.old_str).length} 字符 -> ${String(args.new_str).length} 字符)`);
  } else if (Array.isArray(args.edits) && args.edits.length > 0) {
    parts.push(`批量局部替换 (${args.edits.length} 处)`);
  }

  if (Array.isArray(args.files) && args.files.length > 0) {
    const filePaths = args.files
      .map((f) => (typeof f === "string" ? f : f?.path || ""))
      .filter(Boolean);
    if (filePaths.length > 0) {
      parts.push(`涉及文件: ${filePaths.slice(0, 3).join(", ")}${filePaths.length > 3 ? " 等" : ""}`);
    }
  }

  if (args.start_url || args.url) {
    const u = String(args.start_url || args.url).trim();
    parts.push(`网址: ${u.length > 60 ? `${u.slice(0, 60)}...` : u}`);
  }

  if (args.query) {
    const q = String(args.query).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`查询: ${q.length > 60 ? `${q.slice(0, 60)}...` : q}`);
  } else if (args.q) {
    const q = String(args.q).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`查询: ${q.length > 60 ? `${q.slice(0, 60)}...` : q}`);
  }

  if (args.branch) {
    parts.push(`分支: ${args.branch}`);
  } else if (args.ref) {
    parts.push(`引用: ${args.ref}`);
  }

  if (args.session_id) {
    parts.push(`会话: ${String(args.session_id).slice(0, 10)}...`);
  }

  if (args.code) {
    const c = String(args.code).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`代码: ${c.length > 50 ? `${c.slice(0, 50)}...` : c}`);
  }

  if (args.pullNumber || args.pull_number) {
    parts.push(`PR #${args.pullNumber || args.pull_number}`);
  }

  if (args.issue_number || args.issueNumber) {
    parts.push(`Issue #${args.issue_number || args.issueNumber}`);
  }

  if (args.message) {
    const m = String(args.message).replace(/[\r\n\t]+/g, " ").trim();
    parts.push(`说明: ${m.length > 40 ? `${m.slice(0, 40)}...` : m}`);
  }

  if (parts.length === 0) {
    const keys = Object.keys(args).filter((k) => typeof args[k] === "string" || typeof args[k] === "number");
    for (const k of keys.slice(0, 2)) {
      const v = String(args[k]).replace(/[\r\n\t]+/g, " ").trim();
      if (v) {
        parts.push(`${k}: ${v.length > 40 ? `${v.slice(0, 40)}...` : v}`);
      }
    }
  }

  return parts.join(", ");
}

export function redactToolArguments(value, key = "") {
  if (/api.?key|token|secret|password|authorization|credential/i.test(key)) {
    return "[已隐藏]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactToolArguments(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactToolArguments(childValue, childKey)
      ])
    );
  }
  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}...`;
  }
  return value;
}

export function buildChineseToolGoal(rawAction, args = {}, toolMeta = null, activeTools = []) {
  const action = String(rawAction || "").toLowerCase();
  const argsObj = args && typeof args === "object" ? args : {};

  // 1. 浏览器与自动化交互族 (Playwright / Puppeteer / WebMCP / Browser)
  const isBrowserRelated = /browser|playwright|puppeteer|webmcp|selenium|page/i.test(action);
  if (isBrowserRelated) {
    const subAction = String(argsObj.action || argsObj.method || "").toLowerCase();
    const targetUrl = argsObj.start_url || argsObj.url || "";
    const codeSnippet = String(argsObj.code || "").trim();

    if (action.includes("connection_context")) {
      return "检查当前环境连接上下文与运行范围";
    }

    if (subAction === "create" || subAction === "launch" || subAction === "new") {
      if (targetUrl) {
        try {
          const u = new URL(targetUrl);
          return `启动云端浏览器并访问 ${u.hostname}`;
        } catch {
          return `启动云端浏览器并访问目标网址 (${String(targetUrl).slice(0, 30)})`;
        }
      }
      return "启动新的云端浏览器实例";
    }

    if (subAction === "delete" || subAction === "close" || subAction === "destroy") {
      return "关闭并释放当前云端浏览器会话";
    }

    if (subAction === "list") {
      if (action.includes("webmcp") || action.includes("page")) {
        return "获取网页当前 DOM 结构与可交互元素列表";
      }
      return "检查当前浏览器活跃会话与窗口状态";
    }

    if (subAction === "click") {
      return "在网页中点击指定的交互元素";
    }

    if (subAction === "type" || subAction === "input" || subAction === "fill") {
      const textVal = argsObj.text || argsObj.value || "";
      return textVal ? `在网页输入框中填写：“${String(textVal).slice(0, 20)}”` : "向网页输入框填写内容";
    }

    if (codeSnippet) {
      if (/waitForLoadState|waitForNavigation|waitForTimeout|waitFor\(/i.test(codeSnippet)) {
        return "等待网页资源加载与页面渲染就绪";
      }
      if (/waitForSelector/i.test(codeSnippet)) {
        return "等待目标页面元素渲染呈现";
      }
      if (/goto\(|navigate\(/i.test(codeSnippet)) {
        const matchUrl = codeSnippet.match(/goto\(\s*['"`]([^'"`]+)['"`]/i);
        return matchUrl ? `控制浏览器导航至 ${matchUrl[1].slice(0, 35)}` : "控制浏览器跳转至指定网页";
      }
      if (/locator\(|querySelector|\$\(|textContent|innerText|getAttribute|evaluate/i.test(codeSnippet)) {
        if (/search|result|h3|title|item|list/i.test(codeSnippet)) {
          return "提取网页中的搜索结果与数据信息";
        }
        return "定位网页元素并提取页面内容";
      }
      if (/click\(/i.test(codeSnippet)) {
        return "执行 Playwright 模拟用户点击操作";
      }
      if (/fill\(|type\(|press\(/i.test(codeSnippet)) {
        return "执行 Playwright 模拟键盘输入操作";
      }
      if (/screenshot\(/i.test(codeSnippet)) {
        return "截取当前网页屏幕快照";
      }
      return "在云端浏览器中执行 Playwright 自动化交互脚本";
    }

    return "执行浏览器端自动化交互操作";
  }

  // 2. GitHub 仓库操作族
  if (/get_me$/i.test(action)) return "获取当前 GitHub 用户的基本信息";
  if (/get_file_contents$/i.test(action)) {
    return argsObj.path ? `读取文件内容: ${argsObj.path}` : "读取指定文件或目录内容";
  }
  if (/get_repository_tree$/i.test(action)) return "查看仓库目录与文件结构";
  if (/list_commits$/i.test(action)) return "查看仓库近期提交记录";
  if (/get_commit$/i.test(action)) return "查看特定提交的详细变更";
  if (/search_code$/i.test(action)) {
    const q = argsObj.query || argsObj.q || "";
    return q ? `搜索仓库代码: ${String(q).slice(0, 25)}` : "在仓库中精确搜索代码";
  }
  if (/search_repositories$/i.test(action)) return "搜索相关 GitHub 仓库";
  if (/list_pull_requests$/i.test(action)) return "查看拉取请求 (PR) 列表";
  if (/get_pull_request$/i.test(action)) return "查看拉取请求详情";
  if (/list_issues$/i.test(action)) return "查看仓库问题 (Issue) 列表";
  if (/search_issues$/i.test(action)) return "搜索相关问题与讨论";
  if (/create_or_update_file$/i.test(action)) {
    return argsObj.path ? `写入/更新文件: ${argsObj.path}` : "创建或更新仓库文件";
  }
  if (/github_edit_file$|edit_file$/i.test(action)) {
    return argsObj.path ? `局部编辑并更新代码: ${argsObj.path}` : "局部编辑修改文件";
  }
  if (/actions_list$/i.test(action)) {
    const m = String(argsObj.method || "").toLowerCase();
    if (m === "list_workflow_runs") return "查看云端工作流 (Actions) 运行记录";
    if (m === "list_workflows") return "查看仓库所有工作流列表";
    return "查看 GitHub Actions 运行记录";
  }
  if (/actions_get$/i.test(action)) {
    return "查看 GitHub Actions 任务详情";
  }
  if (/actions_run_trigger$/i.test(action)) {
    return "手动触发 GitHub Actions 编译构建";
  }
  if (/get_job_logs$/i.test(action)) {
    return "获取 Actions 编译构建错误日志";
  }

  // 3. Cloudflare 操作族
  if (/cloudflare/i.test(action) || (toolMeta?.serverName && /cloudflare/i.test(toolMeta.serverName))) {
    const path = String(argsObj.path || "").toLowerCase();
    if (path.includes("/workers/scripts")) {
      return argsObj.method === "PUT" ? "部署/更新 Cloudflare Worker 脚本" : "读取 Cloudflare Worker 脚本代码";
    }
    if (path.includes("/kv/namespaces")) return "操作 Cloudflare KV 键值数据";
    if (path.includes("/d1/database")) return "执行 Cloudflare D1 数据库查询";
    if (path.includes("/dns_records")) return "查询/管理 Cloudflare DNS 解析记录";
    return "调用 Cloudflare 接口管理云端资源";
  }

  // 4. 命令执行与终端操作族
  if (/bash|exec|terminal|command|shell|run_command/i.test(action)) {
    const cmd = argsObj.command || argsObj.cmd || "";
    return cmd ? `在环境中执行命令: ${String(cmd).slice(0, 30)}` : "在环境中执行终端命令";
  }

  // 5. 文件读写通用模式
  const pathArg = argsObj.path || argsObj.filePath || argsObj.file || argsObj.filename || "";
  if (/read|cat|view|get/i.test(action) && pathArg) {
    return `读取目标文件: ${pathArg}`;
  }
  if (/write|create|save|put/i.test(action) && pathArg) {
    return `写入目标文件: ${pathArg}`;
  }
  if (/edit|modify|patch|update/i.test(action) && pathArg) {
    return `修改目标文件: ${pathArg}`;
  }
  if (/delete|remove|rm/i.test(action) && pathArg) {
    return `删除目标文件: ${pathArg}`;
  }

  // 6. 搜索与查询通用模式
  const qArg = argsObj.query || argsObj.q || "";
  if (/search|find|grep|lookup/i.test(action)) {
    return qArg ? `检索相关信息: ${String(qArg).slice(0, 25)}` : "检索相关内容与数据";
  }

  // 7. 从工具自带的 description 中提取核心中文或简短动作
  const matchedTool = activeTools.find((t) => {
    const tn = t.function?.name || t.name || "";
    return tn === rawAction || tn.endsWith(`_${rawAction}`) || rawAction.endsWith(tn);
  });
  const desc = matchedTool?.function?.description || toolMeta?.description || "";
  if (desc) {
    const cleanDesc = desc.replace(/^\[[^\]]+\]\s*/, "").trim();
    const cnMatch = cleanDesc.match(/[\u4e00-\u9fa5]{4,25}/);
    if (cnMatch) {
      return cnMatch[0];
    }
    const firstSentence = cleanDesc.split(/[.\n;]/)[0].trim();
    if (firstSentence && firstSentence.length <= 40) {
      return `执行操作: ${firstSentence}`;
    }
  }

  // 8. 优雅兜底：根据工具名与动词拆解，严禁复读用户输入长句
  const subOp = argsObj.action || argsObj.method || argsObj.operation || "";
  if (subOp) {
    return `调用工具 ${rawAction} 执行 ${subOp} 操作`;
  }

  const cleanActionName = rawAction.replace(/^[^_]+_/, "").replace(/_/g, " ");
  return `调用工具执行 ${cleanActionName} 操作`;
}

export function formatToolActionCard(toolCall, activeTools = [], userText = "", hasPendingBuild = false) {
  if (!toolCall) return "";
  const toolName = toolCall.function?.name || toolCall.name || "unknown_tool";
  const toolInfo = mcpToolRegistry.get(toolName) || Array.from(mcpToolRegistry.entries())
    .find(([key, info]) => key.endsWith(toolName) || (info?.rawName && toolName.endsWith(info.rawName)))?.[1];
  const rawAction = toolInfo?.rawName || toolName;
  const rawArguments = toolCall.function?.arguments ?? toolCall.arguments;
  const parsedArguments = toolArguments({ function: { arguments: rawArguments } }) || {};
  const safeArguments = redactToolArguments(parsedArguments);
  const explicitGoal = String(toolCall.goal || "").replace(/[\r\n]+/g, " ").trim();

  let goal = "";
  if (explicitGoal && /[\u3400-\u9fff]/.test(explicitGoal) && !explicitGoal.startsWith("根据需求执行工具操作")) {
    goal = explicitGoal;
  } else {
    goal = buildChineseToolGoal(rawAction, parsedArguments, toolInfo, activeTools);
  }

  const isActions = /actions_(list|get)/i.test(rawAction);
  if (isActions && hasPendingBuild) {
    goal = "查看并等待 GitHub Actions 云端构建结果";
  }

  let details = formatToolCallDetails(safeArguments);
  if (!details) {
    details = JSON.stringify(safeArguments);
    if (details.length > 300) details = `${details.slice(0, 300)}...`;
  }
  return `目标说明：${goal}\n调用工具：\`${rawAction}\`\n检索内容：${details}`;
}

export function generateToolCallKey(toolName, args) {
  if (!args || typeof args !== "object") return `${toolName}:{}`;
  try {
    const sortedKeys = Object.keys(args).sort();
    const normalized = {};
    for (const k of sortedKeys) {
      normalized[k] = args[k];
    }
    return `${toolName}:${JSON.stringify(normalized)}`;
  } catch {
    return `${toolName}:${JSON.stringify(args)}`;
  }
}

export function sendSSEChunk(clientResponse, delta, model = "default") {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null
      }
    ]
  };
  clientResponse.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function sendReasoningChunk(clientResponse, text, model = "default") {
  sendSSEChunk(clientResponse, { reasoning_content: text }, model);
}

export function isTruncatedFinishReason(reason) {
  if (!reason || typeof reason !== "string") return false;
  const r = reason.toLowerCase().trim();
  return (
    r === "length" ||
    r === "max_tokens" ||
    r === "model_length" ||
    r.includes("max_output_tokens") ||
    r === "incomplete"
  );
}

export function extractFinishReason(parsedChunkOrJson) {
  if (!parsedChunkOrJson || typeof parsedChunkOrJson !== "object") return null;
  const choice = parsedChunkOrJson.choices?.[0];
  if (choice) {
    if (choice.finish_reason) return choice.finish_reason;
    if (choice.finishReason) return choice.finishReason;
  }
  const candidate = parsedChunkOrJson.candidates?.[0];
  if (candidate?.finishReason) return candidate.finishReason;
  if (parsedChunkOrJson.finish_reason) return parsedChunkOrJson.finish_reason;
  if (parsedChunkOrJson.finishReason) return parsedChunkOrJson.finish_reason;
  if (parsedChunkOrJson.status === "incomplete" && parsedChunkOrJson.incomplete_details?.reason) {
    return parsedChunkOrJson.incomplete_details.reason;
  }
  return null;
}

export function isTitleGenerationRequest(userText) {
  if (!userText || typeof userText !== "string") return false;
  return (
    /give this conversation a name/i.test(userText) ||
    /based on the chat history,\s*give this conversation/i.test(userText) ||
    /generate a (?:short )?title for this conversation/i.test(userText)
  );
}

export function detectActionIntent(userText) {
  if (!userText || typeof userText !== "string") {
    return { needsTool: false, isWrite: false };
  }
  const text = userText.trim();
  if (isTitleGenerationRequest(text)) {
    return { needsTool: false, isWrite: false };
  }

  const isConsultation =
    /^(?:为什么|为啥|为何|请问|帮我看下为什么|分析|排查原因|查下原因|怎么回事|怎么会|why|how|what)/i.test(text) ||
    /(?:为什么|为啥|为何|怎么回事|正常吗)[？?\s]*$/i.test(text);
  if (isConsultation && !/(?:帮我|直接|请|现在).*(?:修改|改一下|修复|更新|写入|提交|替换)/i.test(text)) {
    return { needsTool: false, isWrite: false };
  }

  const writeVerb = /(修改|修改下|改下|改一下|修一下|修复|更新|更新下|添加|增加|加一个|删除|删掉|重写|创建|新建|写入|覆盖|替换|调整|优化|补齐|同步|把.+改成|提交|推送|打包|编译|运行|commit|push|write|update|create|delete|edit|trigger|build)/i;
  const writeTarget = /(代码|文件|配置|仓库|bug|接口|函数|样式|组件|依赖|项目|分支|插件|脚本|产物|测试|pr|github|readme|dist|打包|编译|workflow|actions|\.[a-z0-9]{1,6})/i;
  const isDirectWrite = writeVerb.test(text) && (writeTarget.test(text) || text.length <= 60);

  const readVerb = /(查看|看一下|读取|获取|搜索|查一下|查找|找一下|列出|分析|检查|排查|看看|读一下|fetch|get|read|search|list)/i;
  const readTarget = /(文件|代码|目录|仓库|分支|提交|日志|报错|错误|问题|原因|commit|pr|issue|内容|log|\.[a-z0-9]{1,6})/i;
  const isDirectRead = readVerb.test(text) && (readTarget.test(text) || text.length <= 60);

  const isWrite = Boolean(isDirectWrite);
  const needsTool = Boolean(isDirectWrite || isDirectRead);
  return { needsTool, isWrite };
}

export function isModelEnabledForMcp(modelName) {
  if (!modelName || enabledModels.size === 0) return false;
  const target = modelName.trim().toLowerCase();
  for (const m of enabledModels) {
    const pattern = m.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === target) return true;
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`, "i");
      if (regex.test(target)) return true;
    }
  }
  return false;
}

export async function passThrough(requestBody, clientResponse, reqMeta, abortSignal) {
  setCorsHeaders(clientResponse);
  const isStream = requestBody.stream === true;
  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("未配置上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 转发请求至上游: ${requestBody.model || "default"} - stream=${isStream}`, {
    channel: channel.name,
    url: targetUrl,
    model: requestBody.model,
    stream: isStream,
    messagesCount: requestBody.messages?.length || 0,
    upstreamPayloadSummary: {
      reasoning_effort: requestBody.reasoning_effort,
      thinkingConfig: requestBody.thinkingConfig,
      thinking_budget: requestBody.thinking_budget
    }
  });

  let currentMessages = [...(requestBody.messages || [])];
  let continueRound = 0;
  const MAX_AUTO_CONTINUES = 30;
  let hasInitiatedStream = false;
  let fullAccumulatedContent = "";

  while (continueRound <= MAX_AUTO_CONTINUES) {
    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止请求与续接`);
      break;
    }

    let upstreamResponse = null;
    let fetchAttempts = 0;
    const MAX_FETCH_ATTEMPTS = 2;
    const roundStartTime = Date.now();
    if (continueRound > 0) {
      addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 第 ${continueRound + 1} 轮断点续接上游请求 - 消息量: ${currentMessages.length}`);
    }

    while (fetchAttempts < MAX_FETCH_ATTEMPTS) {
      if (abortSignal?.aborted || clientResponse.destroyed) break;
      fetchAttempts += 1;

      const { signal: combinedSignal, cleanup } = createCombinedSignal(abortSignal, 180000);
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${channel.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ...requestBody,
            messages: currentMessages
          }),
          signal: combinedSignal
        });
        cleanup();
        break;
      } catch (err) {
        cleanup();
        if (abortSignal?.aborted || (err.name === "AbortError" && abortSignal?.aborted)) {
          addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，上游请求已中止`);
          return;
        }

        const isNetworkOrTimeout =
          err.name === "AbortError" ||
          err.message?.includes("fetch failed") ||
          err.message?.includes("timeout") ||
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT";

        if (isNetworkOrTimeout && fetchAttempts < MAX_FETCH_ATTEMPTS && !clientResponse.destroyed) {
          addDebugLog("UPSTREAM", `⚠️ [直通模式] [${channel.name}] 上游网络波动 (${err.message})，正在尝试第 ${fetchAttempts} 次自动重试...`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        addDebugLog("ERROR", `[直通模式] [${channel.name}] 上游请求彻底失败: ${err.message}`, err.stack || err);
        if (isStream && hasInitiatedStream && !clientResponse.destroyed) {
          const errorChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model || "default",
            choices: [
              {
                index: 0,
                delta: { content: `\n\n⚠️ [直通模式网络连接中断]: ${err.message}` },
                finish_reason: "stop"
              }
            ]
          };
          clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          clientResponse.write("data: [DONE]\n\n");
          clientResponse.end();
          return;
        }
        throw err;
      }
    }

    if (!upstreamResponse) return;

    const duration = Date.now() - roundStartTime;
    addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 上游响应状态: ${upstreamResponse.status} - 耗时 ${duration}ms`, {
      channel: channel.name,
      status: upstreamResponse.status,
      contentType: upstreamResponse.headers.get("Content-Type")
    });

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止处理`);
      return;
    }

    if (!upstreamResponse.ok) {
      const errTxt = await upstreamResponse.text();
      addDebugLog("ERROR", `[直通模式] [${channel.name}] 上游报错 (${upstreamResponse.status})`, errTxt);
      if (isStream && hasInitiatedStream) {
        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: requestBody.model || "default",
          choices: [
            {
              index: 0,
              delta: { content: `\n\n⚠️ [上游接口返回错误 ${upstreamResponse.status}]: ${errTxt.slice(0, 500)}` },
              finish_reason: "stop"
            }
          ]
        };
        clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        clientResponse.write("data: [DONE]\n\n");
        clientResponse.end();
      } else {
        sendJson(clientResponse, upstreamResponse.status, {
          error: { code: upstreamResponse.status, message: errTxt }
        });
      }
      return;
    }

    if (!isStream) {
      const json = await upstreamResponse.json();
      if (abortSignal?.aborted || clientResponse.destroyed) return;
      const rawReason = extractFinishReason(json);
      const choice = json.choices?.[0];
      const content = choice?.message?.content || "";
      fullAccumulatedContent += content;

      if (isTruncatedFinishReason(rawReason) && content && !abortSignal?.aborted && !clientResponse.destroyed) {
        continueRound += 1;
        addDebugLog("AGENT", `⚠️ [抗截断触发] 直通非流式检测到截断 (${rawReason})！正在自动进行第 ${continueRound} 次无感断点续接...`, {
          round: continueRound,
          finishReason: rawReason,
          accumulatedLength: fullAccumulatedContent.length
        });
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content },
          { role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" }
        ];
        continue;
      }

      if (continueRound > 0 && choice?.message) {
        choice.message.content = fullAccumulatedContent;
      }
      addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 非流式完成输出 - 结束原因: ${rawReason || "stop"}`);
      addDebugLog("CONVERSATION", `【直通对话完成】上游响应已全部交付客户端`);
      sendJson(clientResponse, 200, json);
      return;
    }

    if (!hasInitiatedStream) {
      clientResponse.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      hasInitiatedStream = true;
    }

    let buffer = "";
    let roundContent = "";
    let lastFinishReason = null;
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (abortSignal?.aborted || clientResponse.destroyed) {
          addDebugLog("DOWNSTREAM", `[直通模式] 客户端在流式传输中断开连接，已停止上游拉取`);
          await reader.cancel().catch(() => {});
          break;
        }
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
            const choice = parsed.choices?.[0];
            const reason = extractFinishReason(parsed);
            if (reason) {
              lastFinishReason = reason;
            }
            if (choice?.delta?.content) {
              roundContent += choice.delta.content;
            }

            if (isTruncatedFinishReason(reason)) {
              const sanitized = {
                ...parsed,
                choices: choice ? [{ ...choice, finish_reason: null, finishReason: null }] : []
              };
              clientResponse.write(`data: ${JSON.stringify(sanitized)}\n\n`);
            } else {
              clientResponse.write(`${line}\n\n`);
            }
          } catch {
            clientResponse.write(`${line}\n\n`);
          }
        }
      }
    } catch (err) {
      if (abortSignal?.aborted || err.name === "AbortError") {
        addDebugLog("DOWNSTREAM", `[直通模式] 客户端中断传输`);
        return;
      }
      throw err;
    }

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[直通模式] 客户端已断开，终止自动续接`);
      break;
    }

    fullAccumulatedContent += roundContent;

    if (isTruncatedFinishReason(lastFinishReason) && roundContent && !abortSignal?.aborted && !clientResponse.destroyed) {
      continueRound += 1;
      addDebugLog("AGENT", `⚠️ [抗截断触发] 直通流式检测到截断 (${lastFinishReason})！正在自动进行第 ${continueRound} 次无感断点续接...`, {
        round: continueRound,
        finishReason: lastFinishReason,
        accumulatedLength: fullAccumulatedContent.length
      });
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: roundContent },
        { role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" }
      ];
      continue;
    }

    addDebugLog("UPSTREAM", `[直通模式] [${channel.name}] 流式完成输出 - 结束原因: ${lastFinishReason || "stop"}`);
    addDebugLog("CONVERSATION", `【直通对话完成】流式传输结束`);
    break;
  }

  if (!abortSignal?.aborted && !clientResponse.destroyed) {
    clientResponse.write("data: [DONE]\n\n");
    clientResponse.end();
  }
}

export function convertGeminiToOpenAIMessages(body) {
  const messages = [];
  if (body.systemInstruction?.parts) {
    const sysText = body.systemInstruction.parts.map((p) => p.text || "").join("\n");
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) {
      const role = c.role === "model" ? "assistant" : "user";
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const contentItems = [];
      const toolCalls = [];
      let hasImage = false;

      for (const p of parts) {
        if (p.text) {
          contentItems.push({ type: "text", text: p.text });
        }
        const idata = p.inlineData || p.inline_data;
        if (idata) {
          hasImage = true;
          const mime = idata.mimeType || idata.mime_type || "image/jpeg";
          const b64 = idata.data || "";
          const url = b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64}`;
          contentItems.push({
            type: "image_url",
            image_url: { url }
          });
        }
        const fdata = p.fileData || p.file_data;
        if (fdata) {
          hasImage = true;
          const uri = fdata.fileUri || fdata.file_uri || "";
          contentItems.push({
            type: "image_url",
            image_url: { url: uri }
          });
        }
        if (p.functionCall) {
          toolCalls.push({
            id: `call_${crypto.randomUUID()}`,
            type: "function",
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {})
            }
          });
        }
        if (p.functionResponse) {
          messages.push({
            role: "tool",
            tool_call_id: p.functionResponse.id || `call_${crypto.randomUUID()}`,
            content: JSON.stringify(p.functionResponse.response || {})
          });
        }
      }

      let finalContent = null;
      if (hasImage) {
        finalContent = contentItems;
      } else if (contentItems.length > 0) {
        finalContent = contentItems.map((item) => item.text).join("");
      }

      if (finalContent !== null || toolCalls.length > 0) {
        const msg = { role, content: finalContent };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    }
  }
  return messages;
}

export function convertOpenAiChunkToGemini(parsedChunk) {
  const choice = parsedChunk.choices?.[0];
  const delta = choice?.delta;
  const parts = [];

  if (delta?.reasoning_content) {
    parts.push({
      thought: true,
      text: delta.reasoning_content
    });
  }

  if (delta?.content) {
    parts.push({
      text: formatCardMarkdown(delta.content)
    });
  }

  const rawReason = extractFinishReason(parsedChunk);
  let finishReason = undefined;
  if (rawReason) {
    const r = String(rawReason).toLowerCase().trim();
    if (r === "stop") finishReason = "STOP";
    else if (isTruncatedFinishReason(rawReason)) finishReason = "MAX_TOKENS";
  }

  return {
    candidates: [
      {
        content: {
          parts: parts.length > 0 ? parts : [{ text: "" }],
          role: "model"
        },
        finishReason,
        index: 0
      }
    ]
  };
}

export async function passThroughAndTransformGemini(requestBody, clientResponse, isStream, abortSignal) {
  const startTime = Date.now();
  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("未配置上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  addDebugLog("UPSTREAM", `[Gemini 直通模式] [${channel.name}] 转发转换至上游: ${requestBody.model || "default"}`, {
    channel: channel.name,
    url: targetUrl,
    model: requestBody.model,
    stream: isStream,
    messagesCount: requestBody.messages?.length || 0
  });

  let currentMessages = [...requestBody.messages];
  let continueRound = 0;
  const MAX_AUTO_CONTINUES = 30;
  let hasInitiatedStream = false;
  let fullAccumulatedContent = "";

  while (continueRound <= MAX_AUTO_CONTINUES) {
    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已断开，终止续接`);
      break;
    }

    let upstreamResponse = null;
    let fetchAttempts = 0;
    const MAX_FETCH_ATTEMPTS = 2;

    while (fetchAttempts < MAX_FETCH_ATTEMPTS) {
      if (abortSignal?.aborted || clientResponse.destroyed) break;
      fetchAttempts += 1;

      const { signal: combinedSignal, cleanup } = createCombinedSignal(abortSignal, 180000);
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${channel.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ...requestBody,
            messages: currentMessages
          }),
          signal: combinedSignal
        });
        cleanup();
        break;
      } catch (err) {
        cleanup();
        if (abortSignal?.aborted || (err.name === "AbortError" && abortSignal?.aborted)) {
          addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已中止请求`);
          return;
        }

        const isNetworkOrTimeout =
          err.name === "AbortError" ||
          err.message?.includes("fetch failed") ||
          err.message?.includes("timeout") ||
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT";

        if (isNetworkOrTimeout && fetchAttempts < MAX_FETCH_ATTEMPTS && !clientResponse.destroyed) {
          addDebugLog("UPSTREAM", `⚠️ [Gemini 直通模式] [${channel.name}] 上游网络波动 (${err.message})，正在尝试第 ${fetchAttempts} 次自动重试...`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        throw err;
      }
    }

    if (!upstreamResponse) return;

    const duration = Date.now() - startTime;
    addDebugLog("UPSTREAM", `[Gemini 直通模式] [${channel.name}] 上游响应状态: ${upstreamResponse.status} - 耗时 ${duration}ms`, {
      channel: channel.name,
      status: upstreamResponse.status,
      contentType: upstreamResponse.headers.get("Content-Type")
    });

    if (abortSignal?.aborted || clientResponse.destroyed) return;

    if (!upstreamResponse.ok) {
      const errTxt = await upstreamResponse.text();
      sendJson(clientResponse, upstreamResponse.status, {
        error: { code: upstreamResponse.status, message: errTxt }
      });
      return;
    }

    if (!isStream) {
      const json = await upstreamResponse.json();
      if (abortSignal?.aborted || clientResponse.destroyed) return;
      const choice = json.choices?.[0];
      const candidateText = choice?.message?.content || "";
      const reasoning = choice?.message?.reasoning_content || "";
      const parts = [];
      if (reasoning) parts.push({ thought: true, text: reasoning });
      if (candidateText) parts.push({ text: candidateText });

      const rawReason = extractFinishReason(json);
      const geminiResp = {
        candidates: [
          {
            content: { parts: parts.length > 0 ? parts : [{ text: "" }], role: "model" },
            finishReason: isTruncatedFinishReason(rawReason) ? "MAX_TOKENS" : "STOP",
            index: 0
          }
        ]
      };
      sendJson(clientResponse, 200, geminiResp);
      return;
    }

    if (!hasInitiatedStream) {
      setCorsHeaders(clientResponse);
      clientResponse.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      hasInitiatedStream = true;
    }

    let buffer = "";
    let accumulatedContent = "";
    let lastFinishReason = null;
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (abortSignal?.aborted || clientResponse.destroyed) {
          addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端在流式传输中断开连接，已停止上游拉取`);
          await reader.cancel().catch(() => {});
          break;
        }
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
            const choice = parsed.choices?.[0];
            const reason = extractFinishReason(parsed);
            if (reason) {
              lastFinishReason = reason;
            }
            if (choice?.delta?.content) {
              accumulatedContent += choice.delta.content;
            }
            if (isTruncatedFinishReason(reason)) {
              const geminiChunk = convertOpenAiChunkToGemini({
                ...parsed,
                choices: choice ? [{ ...choice, finish_reason: null, finishReason: null }] : []
              });
              clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
            } else {
              const geminiChunk = convertOpenAiChunkToGemini(parsed);
              clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
            }
          } catch {}
        }
      }
    } catch (err) {
      if (abortSignal?.aborted || err.name === "AbortError") {
        addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端中断传输`);
        return;
      }
      throw err;
    }

    if (abortSignal?.aborted || clientResponse.destroyed) {
      addDebugLog("DOWNSTREAM", `[Gemini 直通模式] 客户端已断开，终止自动续接`);
      break;
    }

    fullAccumulatedContent += roundContent;

    if (isTruncatedFinishReason(lastFinishReason) && roundContent && !abortSignal?.aborted && !clientResponse.destroyed) {
      continueRound += 1;
      addDebugLog("AGENT", `⚠️ [抗截断触发] 检测到上游返回截断 (${lastFinishReason})！正在自动进行第 ${continueRound} 次无感断点续接...`, {
        round: continueRound,
        finishReason: lastFinishReason,
        accumulatedLength: fullAccumulatedContent.length
      });
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: accumulatedContent },
        { role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" }
      ];
      continue;
    }

    addDebugLog("CONVERSATION", `【Gemini 对话完成】响应已交付客户端`);
    break;
  }

  if (!abortSignal?.aborted && !clientResponse.destroyed) {
    clientResponse.write("data: [DONE]\n\n");
    clientResponse.end();
  }
}

export function checkPrimaryBuildStatus(contentStr, primaryWorkflowName = "", minCreatedAtTimestamp = 0) {
  try {
    const data = typeof contentStr === "object" ? contentStr : JSON.parse(contentStr);
    const rawRuns = Array.isArray(data.workflow_runs)
      ? data.workflow_runs
      : (Array.isArray(data.jobs) ? data.jobs : (data.status ? [data] : []));
    if (rawRuns.length === 0) {
      return { completed: false, status: "waiting_for_queue", isFailure: false, isWaitingForNewRun: true };
    }

    const isAux = (name = "") => /cleanup|lint|format|stale|dependabot|pages|greeting|notify|label/i.test(name);

    let runs = rawRuns;
    if (minCreatedAtTimestamp > 0) {
      runs = rawRuns.filter((r) => {
        const createdAt = new Date(r.created_at || r.run_started_at || 0).getTime();
        return createdAt >= minCreatedAtTimestamp - 15000;
      });

      if (runs.length === 0) {
        return {
          completed: false,
          status: "waiting_for_queue",
          isFailure: false,
          isWaitingForNewRun: true,
          runName: primaryWorkflowName || "最新提交构建"
        };
      }
    }

    let targetRun = runs.find((r) => primaryWorkflowName && r?.name && r.name.toLowerCase() === primaryWorkflowName.toLowerCase());
    if (!targetRun) {
      targetRun = runs.find((r) => r && !isAux(r.name)) || runs[0];
    }

    if (!targetRun) return { completed: true, status: "completed", isFailure: false };

    const status = (targetRun.status || "").toLowerCase();
    const conclusion = (targetRun.conclusion || "").toLowerCase();
    const isCompleted = status === "completed" || Boolean(conclusion);
    const isFailure = conclusion === "failure" || status === "failure";

    return {
      completed: isCompleted,
      isFailure,
      status: targetRun.status || "unknown",
      conclusion: targetRun.conclusion || null,
      runName: targetRun.name || "主要构建",
      runId: targetRun.id
    };
  } catch {
    return { completed: false, status: "unknown", isFailure: false };
  }
}

export async function runAgent(requestBody, clientResponse, reqMeta, abortSignal) {
  if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
    throw new Error("messages 必须是非空数组");
  }

  const channel = getActiveChannel();
  if (!channel) {
    throw new Error("未配置上游渠道环境变量");
  }
  const targetUrl = upstreamChatCompletionsUrl(channel);

  const isStream = requestBody.stream === true;
  let messages = [...requestBody.messages];

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const userText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : (Array.isArray(lastUserMsg?.content) ? lastUserMsg.content.map((c) => c.text || "").join(" ") : "");

  const clientTools = Array.isArray(requestBody.tools)
    ? requestBody.tools.filter((t) => t && (t.type === "function" || t.function))
    : [];
  const rawMcpTools = getAllTools();
  const relevantMcpTools = selectRelevantTools(userText, rawMcpTools);
  const tools = [...clientTools, ...relevantMcpTools];

  const { needsTool, isWrite } = detectActionIntent(userText);

  addDebugLog("AGENT", `启动 MCP 调度 [${channel.name}] - 模型 [${requestBody.model}] - 挂载工具数: ${tools.length} - 动作需求: ${needsTool} (写操作: ${isWrite})`, {
    channel: channel.name,
    model: requestBody.model,
    stream: isStream,
    toolCount: tools.length,
    needsTool,
    isWrite,
    initialMessages: messages.length
  });

  const systemRules = [
    "【工具调用与构建验证规范】\n1. 单轮最多规划并发调用 5 个最相关的真实工具；若目标较多，先执行优先级最高的工具，取得结果后再决定下一步，禁止一次性铺开大量无效调用。\n2. 严禁提前输出总结或草稿：在所有信息收集、操作执行或构建验证全部完成之前，严禁在中间轮次输出结论、答复文本或开场白！\n3. 【修改前完整推演，严禁边改边补】\n- 修改代码前必须先通过阅读与搜索，将涉及该问题的全链路逻辑（如外层手势拦截、点击冲突、父子组件结构、事件传递、协议与配套实现）彻底排查清楚并一次性规划好全部改动点。严禁在未理清全链路前草率先改一个文件，导致中途反复修改修补！\n- 局部编辑 old_str 规范：必须直接从本次对话中 get_file_contents 获取到的最新完整代码中原样复制。若某文件在较早轮次读取且被折叠，严禁使用带折叠标记的代码作为 old_str，必须先调用一次 get_file_contents 重新获取最新完整代码后再进行局部替换！对同一个文件的多处修改必须合并在同一个 github_edit_file 调用的 edits 数组中，严禁在同一轮对同一个文件发起两次独立的 github_edit_file 调用！\n4. 【大范围排查与阅读规范】\n- 当用户要求全面排查、检查全项目或寻找无用代码时，请先通过 get_repository_tree 宏观梳理工程架构与核心模块，有针对性地逐步深入，切勿在单轮内一次性盲目读取所有数十个源码文件导致上下文过度膨胀；每轮重点分析 1~3 个核心文件并提取关键发现。\n5. 【一次性集中修改与终局构建验证规范】\n- 当任务涉及多个文件或多步修改时，先连续集中完成所有文件的修改与提交，切勿在中间阶段等待构建！\n- 严禁在同一轮中一边读取文件/搜索代码、一边调用 actions_list！如果本轮还在审查或修改代码，说明任务尚未收敛，严禁调用 actions_list！\n- 仅当所有代码与文件均已全部修改完毕、且本轮不再调用任何读取、搜索或写工具时（项目彻底就绪）：\n  - 若该仓库配置了云端 CI/CD 构建（例如 iOS 打包、自动化测试、Docker 编译等），在独立终局轮次发起一次 actions_list（method: 'list_workflow_runs'）来等待并验证最终修改触发的云端构建结果！\n  - 服务端会在底层自动精准匹配最后一次代码提交所触发的构建任务，并在全场对话中至多进行一次构建等待。\n- 若云端构建成功，向用户汇报修改详情与构建成功结果；\n- 若云端构建失败（failure），必须激活自愈闭环：调用 get_job_logs 查看编译错误日志，分析报错原因并修复代码，修复后再次等待最终构建通过！\n- 若用户仅是查询历史构建耗时或记录，直接查询即可，无需等待。\n6. 优先使用原生 Tool Calls。仅当上游未发出原生调用时，才允许使用操作卡片作为兼容兜底；每轮最多 5 张，且必须对应真实工具调用。多个卡片之间必须使用双换行（\\n\\n）空行彻底分隔，严禁单行连续粘连：\n目标说明：[简明扼要说明本次操作目的与背景]\n调用工具：`[工具名称]`\n检索内容：`[核心参数，如仓库名、文件路径或检索语句]`\n\n7. 核心执行约束：输出上述操作卡片的同时，必须同时发起真实的底层工具调用（Tool Calls），严禁仅在正文中打印卡片文本而不发起工具调用！\n8. 深入的代码分析、逻辑推演等复杂思维过程，必须在深度思考（Thinking / Reasoning）中进行。\n9. 当所有工具调用完毕、进入最终答复轮次时，直接输出完整最终解答，终局轮次严禁输出操作卡片。"
  ];
  const hasCloudflare = tools.some((t) => {
    const n = (t?.function?.name || t?.name || "").toLowerCase();
    return n.includes("cloudflare");
  });
  if (hasCloudflare) {
    systemRules.push(
      "【Cloudflare 工具执行规范】\n1. 沙箱内已预置带有鉴权的全局客户端 `cloudflare.request({ method, path, body, contentType, rawBody })` 与全局变量 `accountId`。严禁自行拼接 BaseURL 或使用原生 fetch()，必须直接使用 `cloudflare.request`。\n2. 读取 Worker 脚本: `cloudflare.request({ method: 'GET', path: `/accounts/${accountId}/workers/scripts/${name}` })`。\n3. 更新单文件 Worker 脚本: `cloudflare.request({ method: 'PUT', path: `/accounts/${accountId}/workers/scripts/${name}`, body: codeString, contentType: 'application/javascript', rawBody: true })`（若为模块 Worker 则按 multipart/form-data格式）。切勿盲目遍历搜索庞大的 OpenAPI 规范。\n4. 若操作对象是 Cloudflare 资源，切勿跨平台在 GitHub 相关工具上搜索无关个人或仓库。"
    );
  }
  if (isWrite) {
    systemRules.push(
      "【执行规范】检测到代码或配置修改任务。请根据目标资源类型选择匹配的工具：\n- 若修改 GitHub 仓库文件，优先调用局部修改工具（如 github_edit_file）替换代码片段；\n- 若修改 Cloudflare Worker/KV 等远程云资源，直接使用 Cloudflare 工具处理，严禁跨平台跑到 GitHub 检索无关个人或仓库；\n- 修改已有代码前先快速获取关键逻辑上下文，一旦定位根因立即收敛修改，避免多轮无效探索。"
    );
  }

  const combinedSystemPrompt = systemRules.join("\n\n");
  if (messages.length > 0 && messages[0].role === "system") {
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n\n${combinedSystemPrompt}`
    };
  } else {
    messages.unshift({
      role: "system",
      content: combinedSystemPrompt
    });
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

  let keepAliveTimer = null;
  if (isStream) {
    keepAliveTimer = setInterval(() => {
      if (abortSignal?.aborted || clientResponse.destroyed) {
        clearInterval(keepAliveTimer);
        return;
      }
      try {
        clientResponse.write(": keep-alive\n\n");
      } catch {}
    }, 4000);
  }

  let finalFinishReason = null;
  let executedToolCount = 0;
  let actionsWaitChecked = false;
  let hasBuildTriggered = false;
  let hasWriteSuccess = false;
  let lastWriteTimestamp = 0;
  let hasPendingBuildVerification = false;
  let hasEverCompletedBuildSuccess = false;
  const toolCallHistory = new Map();
  const dialogReadCache = new Map();
  let consecutiveFailures = 0;
  const displayedActionCards = [];
  const MAX_AGENT_ROUNDS = 35;
  const MAX_TOOL_CALLS_PER_ROUND = 5;

  try {
    for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
      if (abortSignal?.aborted || clientResponse.destroyed) {
        addDebugLog("DOWNSTREAM", `客户端已断开，终止 MCP 调度循环`);
        break;
      }

      // 上下文安全滑动窗口：保证最近读取的 5 个文件 100% 完整无损，仅当总字符超限（>200,000）时智能折叠非活跃历史陈旧文件
      compactContextMessages(messages, 200000, 5);

      let roundMessages = [...messages];
      if (consecutiveFailures >= 2 && roundMessages.length > 0 && roundMessages[0].role === "system") {
        roundMessages[0] = {
          ...roundMessages[0],
          content: `${roundMessages[0].content}\n\n【错误自愈与收敛提示】检测到前序工具调用返回错误。请先检查参数与目标环境是否正确，切勿在未知或不存在的端点上机械试错；若核心逻辑已通过排查查明，请直接聚焦于问题修复与交付，避免过度扩散探索。`
        };
      }

      const activeTools = tools;
      let activeToolChoice = "auto";

      const payload = {
        ...requestBody,
        messages: roundMessages,
        stream: isStream
      };

      if (activeTools.length > 0) {
        payload.tools = activeTools;
        payload.tool_choice = activeToolChoice;
      }

      const roundStartTime = Date.now();
      addDebugLog("UPSTREAM", `[${channel.name}] 第 ${round + 1} 轮上游调用请求 - 消息量: ${roundMessages.length}`, {
        channel: channel.name,
        round: round + 1,
        toolsEnabled: Boolean(payload.tools),
        tool_choice: payload.tool_choice,
        messagesCount: roundMessages.length
      });

      let upstreamResponse = null;
      let fetchAttempts = 0;
      const MAX_FETCH_ATTEMPTS = 2;

      while (fetchAttempts < MAX_FETCH_ATTEMPTS) {
        if (abortSignal?.aborted || clientResponse.destroyed) break;
        fetchAttempts += 1;

        const { signal: combinedSignal, cleanup } = createCombinedSignal(abortSignal, 180000);
        try {
          upstreamResponse = await fetch(targetUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${channel.apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            signal: combinedSignal
          });
          cleanup();
          break;
        } catch (err) {
          cleanup();
          if (abortSignal?.aborted || (err.name === "AbortError" && abortSignal?.aborted)) {
            addDebugLog("DOWNSTREAM", `第 ${round + 1} 轮上游请求被客户端中止`);
            return;
          }

          const isNetworkOrTimeout =
            err.name === "AbortError" ||
            err.message?.includes("fetch failed") ||
            err.message?.includes("timeout") ||
            err.code === "ECONNRESET" ||
            err.code === "ETIMEDOUT";

          if (isNetworkOrTimeout && fetchAttempts < MAX_FETCH_ATTEMPTS && !clientResponse.destroyed) {
            addDebugLog("UPSTREAM", `⚠️ [${channel.name}] 第 ${round + 1} 轮上游请求网络异常 (${err.message})，正在尝试第 ${fetchAttempts} 次自动重试...`);
            if (isStream && !clientResponse.destroyed) {
              sendReasoningChunk(
                clientResponse,
                `\n> ⚠️ 上游网络连接波动/排队超时 (${err.message})，正在尝试重新连接...\n`,
                requestBody.model
              );
            }
            // 触发更低阈值的紧急收敛后再重试
            compactContextMessages(roundMessages, 120000, 3);
            payload.messages = roundMessages;
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          addDebugLog("ERROR", `[${channel.name}] 第 ${round + 1} 轮上游调用彻底失败: ${err.message}`, err.stack || err);
          if (isStream && !clientResponse.destroyed) {
            const errorMsg = `\n\n⚠️ 【上游接口连接失败】：向上游渠道 [${channel.name}] 发起请求失败 (${err.message})。可能由于网络连接重置或上游服务拥堵导致。已为您保留当前全部记录。`;
            sendSSEChunk(clientResponse, { content: errorMsg }, requestBody.model);
            clientResponse.write("data: [DONE]\n\n");
            clientResponse.end();
            return;
          }
          throw err;
        }
      }

      if (!upstreamResponse) return;

      const roundDuration = Date.now() - roundStartTime;
      if (abortSignal?.aborted || clientResponse.destroyed) return;

      if (!upstreamResponse.ok) {
        const errText = await upstreamResponse.text();
        addDebugLog("ERROR", `[${channel.name}] 第 ${round + 1} 轮上游报错 (${upstreamResponse.status}) - 耗时 ${roundDuration}ms`, errText);

        if (isStream) {
          const errorChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model || "default",
            choices: [
              {
                index: 0,
                delta: { content: `\n\n⚠️ [上游接口返回错误 ${upstreamResponse.status}]: ${errText.slice(0, 500)}` },
                finish_reason: "stop"
              }
            ]
          };
          if (!clientResponse.destroyed && !abortSignal?.aborted) {
            clientResponse.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            clientResponse.write("data: [DONE]\n\n");
            clientResponse.end();
          }
          return;
        }
        throw new Error(`上游接口返回错误 (${upstreamResponse.status})：${errText.slice(0, 500)}`);
      }

      if (!isStream) {
        const json = await upstreamResponse.json();
        if (abortSignal?.aborted || clientResponse.destroyed) return;
        const choice = json.choices?.[0];
        const message = choice?.message;
        const toolCalls = message?.tool_calls || [];
        finalFinishReason = extractFinishReason(json);

        let mcpCalls = toolCalls.filter((tc) => {
          const name = tc?.function?.name || tc?.name;
          if (!name) return false;
          return Boolean(findToolInfo(name));
        });

        let usedTextToolCallFallback = false;
        if (mcpCalls.length === 0 && activeTools.length > 0 && message?.content) {
          const textCalls = parseTextToolCalls(message.content, activeTools, userText, false);
          if (textCalls.length > 0) {
            usedTextToolCallFallback = true;
            addDebugLog("AGENT", `[自愈触发] 非流式检测到模型输出了 ${textCalls.length} 个操作卡片，自动转化为真实 MCP 调用`);
            mcpCalls = textCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              goal: tc.goal,
              function: { name: tc.name, arguments: tc.arguments }
            }));
          }
        }

        if (mcpCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
          addDebugLog("AGENT", `单轮工具调用超过上限，已截取前 ${MAX_TOOL_CALLS_PER_ROUND} 个`, {
            requested: mcpCalls.length,
            allowed: MAX_TOOL_CALLS_PER_ROUND
          });
          mcpCalls = mcpCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
        }

        if (mcpCalls.length === 0) {
          if (typeof message?.content === "string" && /(?:目标说明|调用工具|检索内容)\s*[：:]/.test(message.content)) {
            message.content = "输出了无法匹配到已启用工具的操作卡片，未执行任何工具。请根据当前可用工具直接回答。";
          }
          if (displayedActionCards.length > 0 && message) {
            const finalText = typeof message.content === "string" ? message.content : "";
            message.content = [displayedActionCards.join("\n\n"), finalText].filter(Boolean).join("\n\n");
          }
          addDebugLog("AGENT", `第 ${round + 1} 轮完成 - 非流式响应返回客户端 (累计执行工具 ${executedToolCount} 次)`, {
            finishReason: finalFinishReason,
            contentLength: message?.content?.length || 0
          });
          addDebugLog("CONVERSATION", `【对话完成】共执行 ${round + 1} 轮 Agent 交互 - 累计调用工具 ${executedToolCount} 次`);
          sendJson(clientResponse, 200, json);
          return;
        }

        displayedActionCards.push(...mcpCalls.map((tc) => formatToolActionCard(tc, activeTools, userText, hasBuildTriggered || hasPendingBuildVerification)));

        if (usedTextToolCallFallback) {
          messages.push({
            ...message,
            content: null,
            tool_calls: mcpCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.function?.name || tc.name, arguments: tc.function?.arguments || tc.arguments }
            }))
          });
        } else {
          messages.push(message);
        }

        let roundHasFailure = false;
        // 如果本轮包含写操作工具，强制使用串行（concurrency = 1），防止并发修改同一文件引发 SHA 冲突
        const hasWriteInRound = mcpCalls.some((tc) => {
          const n = tc.function?.name || tc.name || "";
          const info = findToolInfo(n);
          return isWriteTool(info?.rawName || n);
        });

        // 检查本轮是否混杂了除 Actions 之外的其他工作（例如代码读取、搜索、修改）
        const hasOtherWorkInRound = mcpCalls.some((tc) => {
          const n = (tc.function?.name || tc.name || "").toLowerCase();
          const info = findToolInfo(n);
          const raw = (info?.rawName || n).toLowerCase();
          return !raw.startsWith("actions_");
        });

        const CONCURRENCY_LIMIT = hasWriteInRound ? 1 : 4;
        const callResults = await executeConcurrentPool(mcpCalls, CONCURRENCY_LIMIT, async (tc, index) => {
          if (abortSignal?.aborted || clientResponse.destroyed) {
            return {
              tool_call_id: tc.id,
              content: JSON.stringify({ error: "Client aborted" }),
              isToolError: true
            };
          }
          if (index > 0 && mcpCalls.length > 1 && CONCURRENCY_LIMIT > 1) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(index * 60, 300)));
          }

          const rawArgs = tc.function?.arguments ?? tc.arguments;
          const args = toolArguments({ function: { arguments: rawArgs } });
          const toolCallName = tc.function?.name || tc.name || "";
          const toolInfo = findToolInfo(toolCallName);
          const resolvedToolKey = toolInfo?.key || toolCallName;
          const displayName = toolInfo?.serverName || "MCP";
          const rawAction = toolInfo?.rawName || toolCallName;
          const isWrite = isWriteTool(rawAction);
          const isActions = /actions_(list|get)/i.test(rawAction);
          const isActionsListMethod = isActions && (args?.method === "list_workflow_runs" || !args?.method);
          const isTrigger = /actions_run_trigger/i.test(rawAction);
          const actionDetails = formatToolCallDetails(args);
          const detailSuffix = actionDetails ? ` | ${actionDetails}` : "";

          let resultText = "";
          let isToolError = false;
          let errorMessage = "";
          let isCacheHit = false;
          let isCommitBuildPoll = false;

          if (args === null) {
            errorMessage = "无效参数";
            resultText = JSON.stringify({ error: errorMessage });
            isToolError = true;
          } else {
            const callKey = generateToolCallKey(resolvedToolKey, args);
            const prevAttempts = toolCallHistory.get(callKey) || 0;

            // 严格单次会话只等待一次：只有在从未成功验证过构建、修改就绪、本轮未混杂其他代码读写时，才启动云端构建等待
            isCommitBuildPoll = (hasBuildTriggered || hasPendingBuildVerification) && isActionsListMethod && !hasOtherWorkInRound && !hasEverCompletedBuildSuccess && !actionsWaitChecked;

            if (isCommitBuildPoll) {
              if (actionsWaitChecked) {
                resultText = JSON.stringify({
                  status: "already_checked",
                  note: "已完成本次提交的构建状态检查。规则限制只查看一次构建状态，严禁重复查询！请立即向用户交付最终汇报与修改详情。"
                });
                isToolError = false;
              } else {
                actionsWaitChecked = true;
                const primaryWorkflowName = "主要构建";
                addDebugLog("TOOL", "[Actions 即时检查] 提交后立即查询 GitHub Actions 构建状态");
                let toolRes = null;
                try {
                  toolRes = await callMcpTool(resolvedToolKey, args);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "获取构建状态失败";
                  errorMessage = extractErrorMessage(msg);
                  resultText = JSON.stringify({ error: msg });
                  isToolError = true;
                }

                if (toolRes && !toolRes.isError) {
                  let buildStatus = checkPrimaryBuildStatus(toolRes.content, primaryWorkflowName, lastWriteTimestamp);
                  const MAX_EXTENSIONS = 20;
                  let extensionCount = 0;
                  let queueWaitCount = 0;

                  while (!buildStatus.completed && extensionCount < MAX_EXTENSIONS) {
                    if (abortSignal?.aborted || clientResponse.destroyed) break;

                    if (buildStatus.isWaitingForNewRun) {
                      queueWaitCount += 1;
                      // 如果等待新排队超过 2 次（约 30 秒），说明 GitHub 没有自动触发构建，坚决退出等待，绝不空转！
                      if (queueWaitCount > 2) {
                        addDebugLog("TOOL", `[Actions 退出等待] 云端未检测到新提交排队或触发的构建任务（已等待约 30 秒），自动退出等待`);
                        break;
                      }
                    }

                    extensionCount += 1;
                    const waitPrompt = buildStatus.isWaitingForNewRun
                      ? `正在检测 GitHub Actions 云端调度状态（第 ${queueWaitCount}/2 次）...`
                      : `构建仍在打包中 [${buildStatus.status || "运行中"}]，自动延长等待 15 秒（第 ${extensionCount}/${MAX_EXTENSIONS} 次）...`;

                    addDebugLog("TOOL", `[Actions 加等] 主要构建 [${primaryWorkflowName}] ${waitPrompt}`);
                    for (let s = 0; s < 15; s += 1) {
                      if (abortSignal?.aborted || clientResponse.destroyed) break;
                      await new Promise((r) => setTimeout(r, 1000));
                    }
                    if (abortSignal?.aborted || clientResponse.destroyed) break;
                    try {
                      toolRes = await callMcpTool(resolvedToolKey, args);
                      buildStatus = checkPrimaryBuildStatus(toolRes.content, primaryWorkflowName, lastWriteTimestamp);
                    } catch {
                      break;
                    }
                  }

                  const totalWaited = extensionCount * 15;
                  if (buildStatus.isFailure) {
                    // 构建失败：解锁并引导模型调 get_job_logs 自动修复
                    actionsWaitChecked = false;
                    hasPendingBuildVerification = false;
                    hasBuildTriggered = false;
                    hasEverCompletedBuildSuccess = false;
                    resultText = `${toolRes.content}\n\n【构建失败自愈提示】检测到主要构建 [${primaryWorkflowName}] 失败 (${buildStatus.conclusion || "failure"})。请立即调用 get_job_logs 获取编译错误日志，分析报错原因并使用 github_edit_file 修复代码！`;
                  } else if (buildStatus.completed) {
                    hasPendingBuildVerification = false;
                    hasBuildTriggered = false;
                    hasEverCompletedBuildSuccess = true;
                    resultText = `${toolRes.content}\n\n【构建成功提示】主要工作流 [${primaryWorkflowName}] 构建成功！耗时约 ${totalWaited} 秒。项目所有修改与云端验证已全部完成，请立即向用户交付最终汇报。`;
                  } else if (buildStatus.isWaitingForNewRun) {
                    hasPendingBuildVerification = false;
                    hasBuildTriggered = false;
                    hasEverCompletedBuildSuccess = true;
                    resultText = `${toolRes.content}\n\n【未检测到云端自动构建任务】本次代码提交已成功推送到仓库，但在提交后 45 秒内未检测到 GitHub Actions 触发或排队新的构建任务（可能该代码变更未满足工作流触发条件或 GitHub 自动调度未响应）。项目代码已全部修改完成，无需继续等待，请直接向用户汇报修改详情。`;
                  } else {
                    hasPendingBuildVerification = false;
                    hasBuildTriggered = false;
                    hasEverCompletedBuildSuccess = true;
                    resultText = `${toolRes.content}\n\n【构建进行中提示】主要工作流 [${primaryWorkflowName}] 已在后台正常编译中（已等待 ${totalWaited} 秒）。无需继续原地空转死等，请立即向用户汇报修改详情并告知构建已在后台触发。`;
                  }
                  isToolError = toolRes.isError;
                  if (!isToolError) executedToolCount += 1;
                }
              }
            } else {
              const cachedContent = !isWrite && !isTrigger ? dialogReadCache.get(callKey) : null;

              if (cachedContent !== undefined && cachedContent !== null) {
                isCacheHit = true;
                toolCallHistory.set(callKey, prevAttempts + 1);
                resultText = cachedContent;
                addDebugLog("TOOL", `MCP 工具 [${resolvedToolKey}] 命中本次对话只读缓存，直接复用 (${cachedContent.length} 字符)`, { arguments: args });
                isToolError = false;
              } else if (prevAttempts >= 5) {
                errorMessage = "该文件或资源连续查询失败";
                resultText = JSON.stringify({
                  error: "该文件或资源已连续查询多次均未成功（可能路径不存在或拼写错误）。为防止反复重试浪费调用，请勿继续使用完全相同的路径重试，请先调用 get_repository_tree 查看真实文件目录结构。"
                });
                isToolError = true;
              } else {
                toolCallHistory.set(callKey, prevAttempts + 1);
                try {
                  const toolRes = await callMcpTool(resolvedToolKey, args);
                  resultText = toolRes.content;
                  isToolError = toolRes.isError;
                  if (isToolError && !errorMessage) {
                    errorMessage = extractErrorMessage(resultText);
                  }
                  if (!isToolError) {
                    executedToolCount += 1;
                    if (isWrite || isTrigger) {
                      hasWriteSuccess = true;
                      hasPendingBuildVerification = true;
                      lastWriteTimestamp = Date.now();
                      if (isTrigger) hasBuildTriggered = true;
                      actionsWaitChecked = false;
                      dialogReadCache.clear();
                      toolCallHistory.clear();
                      if (isTrigger) {
                        resultText = `${toolRes.content}\n\n【系统指令】工作流已成功触发并在云端开始排队运行！请紧接着调用 actions_list（method: 'list_workflow_runs'）来等待并查看本次构建结果，系统会在底层自动输出卡片并进行动态等待！严禁在此提前结束答复！`;
                      }
                    } else {
                      dialogReadCache.set(callKey, resultText);
                    }
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Tool execution failed";
                  errorMessage = extractErrorMessage(msg);
                  resultText = JSON.stringify({ error: msg });
                  isToolError = true;
                }
              }

              // 若本轮混杂了读写工具导致 actions_list 跳过了等待，给模型明确反馈
              if (isActionsListMethod && (hasBuildTriggered || hasPendingBuildVerification) && !isToolError) {
                if (hasEverCompletedBuildSuccess) {
                  resultText = `${resultText}\n\n【系统提示】本次对话已完成过云端构建验证，系统已跳过数分钟的耗时阻塞等待（0秒极速响应）。当前最新构建已在后台打包，请直接向用户交付最终汇报。`;
                } else if (hasOtherWorkInRound) {
                  resultText = `${resultText}\n\n【系统提示】检测到当前轮次中包含文件读取/搜索/修改工作，系统已跳过云端构建长等待（0 秒响应）。请集中完成所有文件的修改。待全部修改完成后，在独立终局轮次单独调用 actions_list 验证云端构建结果。`;
                }
              }
            }
          }
          return {
            tool_call_id: tc.id,
            content: resultText,
            isToolError
          };
        });

        for (const res of callResults) {
          if (res.isToolError) {
            roundHasFailure = true;
          }
          messages.push({
            role: "tool",
            tool_call_id: res.tool_call_id,
            content: res.content
          });
        }

        if (roundHasFailure) {
          consecutiveFailures += 1;
        } else {
          consecutiveFailures = 0;
        }
        continue;
      }

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedToolCalls = [];
      let assistantContent = "";
      let hasToolCalls = false;
      let roundFinishReason = null;
      let stoppedForTextToolCalls = false;
      let streamContentSent = false;
      let contentBuffer = "";

      try {
        while (true) {
          if (abortSignal?.aborted || clientResponse.destroyed) {
            addDebugLog("DOWNSTREAM", `[AGENT] 客户端在流式传输中断开连接，已停止上游拉取`);
            await reader.cancel().catch(() => {});
            break;
          }
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
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;
              const reason = extractFinishReason(parsed);
              if (reason) {
                roundFinishReason = reason;
              }

              if (delta?.tool_calls) {
                hasToolCalls = true;
                for (const tc of delta.tool_calls) {
                  if (!tc) continue;
                  const index = tc.index ?? 0;
                  if (!accumulatedToolCalls[index]) {
                    accumulatedToolCalls[index] = {
                      id: tc.id || `call_${crypto.randomUUID()}`,
                      name: tc.function?.name || tc.name || "",
                      arguments: ""
                    };
                  }
                  if (tc.id) accumulatedToolCalls[index].id = tc.id;
                  if (tc.function?.name) accumulatedToolCalls[index].name = tc.function.name;
                  else if (tc.name) accumulatedToolCalls[index].name = tc.name;
                  if (tc.function?.arguments) accumulatedToolCalls[index].arguments += tc.function.arguments;
                  else if (tc.arguments) accumulatedToolCalls[index].arguments += tc.arguments;
                }
              }

              if (delta?.content) {
                assistantContent += delta.content;

                // 流式实时检测操作卡片：必须要求最后一张卡片末尾已经完整输出了换行符（requireTrailingNewlineOnLast = true），严禁在半句话时提前截断流！
                if (!hasToolCalls && activeTools.length > 0) {
                  const textCalls = parseTextToolCalls(assistantContent, activeTools, userText, true);
                  if (textCalls.length >= MAX_TOOL_CALLS_PER_ROUND) {
                    stoppedForTextToolCalls = true;
                    await reader.cancel().catch(() => {});
                    break;
                  }
                }

                // 实时流式输出正文：如果本轮未检测到工具调用，逐字打字机推送
                if (!hasToolCalls) {
                  if (streamContentSent) {
                    if (!clientResponse.destroyed && !abortSignal?.aborted) {
                      sendSSEChunk(clientResponse, { content: delta.content }, requestBody.model);
                    }
                  } else {
                    contentBuffer += delta.content;
                    const trimmedBuf = contentBuffer.trimStart();
                    const couldBeCard = "目标说明".startsWith(trimmedBuf) || trimmedBuf.startsWith("目标说明");
                    if (!couldBeCard || trimmedBuf.length > 25) {
                      if (!/(?:目标说明|调用工具)\s*[：:]/.test(trimmedBuf)) {
                        if (!clientResponse.destroyed && !abortSignal?.aborted) {
                          sendSSEChunk(clientResponse, { content: contentBuffer }, requestBody.model);
                        }
                        streamContentSent = true;
                        contentBuffer = "";
                      }
                    }
                  }
                }
              }

              if (delta?.reasoning_content) {
                if (!clientResponse.destroyed && !abortSignal?.aborted) {
                  const reasoningChunk = {
                    id: parsed.id || `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: parsed.created || Math.floor(Date.now() / 1000),
                    model: parsed.model || requestBody.model || "default",
                    choices: [
                      {
                        index: 0,
                        delta: { reasoning_content: delta.reasoning_content },
                        finish_reason: null
                      }
                    ]
                  };
                  clientResponse.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
                }
              }
            } catch {}
          }
          if (stoppedForTextToolCalls) break;
        }
      } catch (err) {
        if (abortSignal?.aborted || err.name === "AbortError") {
          addDebugLog("DOWNSTREAM", `[AGENT] 客户端中断传输`);
          return;
        }
        throw err;
      }

      if (abortSignal?.aborted || clientResponse.destroyed) {
        addDebugLog("DOWNSTREAM", `客户端已断开，终止后续 MCP 处理与续接`);
        break;
      }

      let mcpCalls = accumulatedToolCalls.filter((tc) => {
        const name = tc?.function?.name || tc?.name;
        if (!name) return false;
        return Boolean(findToolInfo(name));
      });

      let usedTextToolCallFallback = false;
      if (mcpCalls.length === 0 && activeTools.length > 0 && assistantContent) {
        const textCalls = parseTextToolCalls(assistantContent, activeTools, userText, false);
        if (textCalls.length > 0) {
          usedTextToolCallFallback = true;
          addDebugLog("AGENT", `[自愈触发] 流式检测到模型仅输出了 ${textCalls.length} 个操作卡片而未触发原生 tool_calls，自动转化为真实 MCP 调用`);
          mcpCalls = textCalls;
        }
      }

      if (mcpCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
        addDebugLog("AGENT", `单轮工具调用超过上限，已截取前 ${MAX_TOOL_CALLS_PER_ROUND} 个`, {
          requested: mcpCalls.length,
          allowed: MAX_TOOL_CALLS_PER_ROUND
        });
        mcpCalls = mcpCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      }

      if (mcpCalls.length === 0) {
        // 未使用流式实时推出去的短文本（如小于25字符），在此补发
        if (!streamContentSent && contentBuffer) {
          if (!/(?:目标说明|调用工具|检索内容)\s*[：:]/.test(contentBuffer)) {
            if (!clientResponse.destroyed && !abortSignal?.aborted) {
              sendSSEChunk(clientResponse, { content: contentBuffer }, requestBody.model);
            }
          } else if (!abortSignal?.aborted && !clientResponse.destroyed) {
            sendSSEChunk(clientResponse, { content: "输出了无法匹配到已启用工具的操作卡片，未执行任何工具。请根据当前可用工具直接回答。" }, requestBody.model);
          }
        }

        if (isTruncatedFinishReason(roundFinishReason) && assistantContent && !/(?:目标说明|调用工具|检索内容)\s*[：:]/.test(assistantContent) && !abortSignal?.aborted && !clientResponse.destroyed) {
          addDebugLog("AGENT", `⚠️ [抗截断触发] MCP 调度检测到截断 (${roundFinishReason})！正在自动进行无感断点续接...`, {
            round: round + 1,
            finishReason: roundFinishReason,
            accumulatedLength: assistantContent.length
          });
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({ role: "user", content: "请紧接着上一句未说完的内容继续输出，不要重复前面已输出的任何字，不要有任何多余的开场白。" });
          continue;
        }

        if (!abortSignal?.aborted && !clientResponse.destroyed) {
          clientResponse.write("data: [DONE]\n\n");
          clientResponse.end();
        }
        addDebugLog("AGENT", `第 ${round + 1} 轮流式完成输出 - 结束原因: ${roundFinishReason || "stop"} (累计执行工具 ${executedToolCount} 次)`, {
          round: round + 1,
          finishReason: roundFinishReason,
          totalRounds: round + 1
        });
        addDebugLog("CONVERSATION", `【对话完成】共执行 ${round + 1} 轮 Agent 交互 - 累计调用工具 ${executedToolCount} 次`);
        return;
      }

      const visibleActionCards = mcpCalls.map((tc) => formatToolActionCard(tc, activeTools, userText, hasBuildTriggered || hasPendingBuildVerification));
      if (visibleActionCards.length > 0 && !abortSignal?.aborted && !clientResponse.destroyed) {
        sendSSEChunk(clientResponse, { content: `${visibleActionCards.join("\n\n")}\n\n` }, requestBody.model);
      }

      messages.push({
        role: "assistant",
        content: usedTextToolCallFallback ? null : (assistantContent || null),
        tool_calls: mcpCalls.map((tc) => ({
          id: tc.id || `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: tc.function?.name || tc.name, arguments: tc.function?.arguments || tc.arguments }
        }))
      });

      let roundHasFailure = false;
      // 如果本轮包含写操作工具，强制使用串行（concurrency = 1），防止同一轮并发修改同一文件引发 SHA 冲突
      const hasWriteInRound = mcpCalls.some((tc) => {
        const n = tc.function?.name || tc.name || "";
        const info = findToolInfo(n);
        return isWriteTool(info?.rawName || n);
      });

      // 检查本轮是否混杂了除 Actions 之外的其他工作（例如代码读取、搜索、修改）
      const hasOtherWorkInRound = mcpCalls.some((tc) => {
        const n = (tc.function?.name || tc.name || "").toLowerCase();
        const info = findToolInfo(n);
        const raw = (info?.rawName || n).toLowerCase();
        return !raw.startsWith("actions_");
      });

      const CONCURRENCY_LIMIT = hasWriteInRound ? 1 : 4;
      const callResults = await executeConcurrentPool(mcpCalls, CONCURRENCY_LIMIT, async (tc, index) => {
        if (abortSignal?.aborted || clientResponse.destroyed) {
          return {
            tool_call_id: tc.id || `call_${crypto.randomUUID()}`,
            content: JSON.stringify({ error: "Client aborted" }),
            isToolError: true
          };
        }
        if (index > 0 && mcpCalls.length > 1 && CONCURRENCY_LIMIT > 1) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(index * 60, 300)));
        }

        const rawArgs = tc.function?.arguments ?? tc.arguments;
        const args = toolArguments({ function: { arguments: rawArgs } });
        const toolCallName = tc.function?.name || tc.name || "";
        const toolInfo = findToolInfo(toolCallName);
        const resolvedToolKey = toolInfo?.key || toolCallName;
        const displayName = toolInfo?.serverName || "MCP";
        const rawAction = toolInfo?.rawName || toolCallName;
        const isWrite = isWriteTool(rawAction);
        const isActions = /actions_(list|get)/i.test(rawAction);
        const isActionsListMethod = isActions && (args?.method === "list_workflow_runs" || !args?.method);
        const isTrigger = /actions_run_trigger/i.test(rawAction);
        const actionDetails = formatToolCallDetails(args);
        const detailSuffix = actionDetails ? ` | ${actionDetails}` : "";

        let resultText = "";
        let isToolError = false;
        let errorMessage = "";
        let isCacheHit = false;
        let isCommitBuildPoll = false;

        if (args === null) {
          errorMessage = "无效参数";
          resultText = JSON.stringify({ error: errorMessage });
          isToolError = true;
        } else {
          const callKey = generateToolCallKey(resolvedToolKey, args);
          const prevAttempts = toolCallHistory.get(callKey) || 0;

          // 严格单次会话只等待一次：只有在从未成功验证过构建、修改就绪、本轮未混杂其他代码读写时，才启动云端构建等待
          isCommitBuildPoll = (hasBuildTriggered || hasPendingBuildVerification) && isActionsListMethod && !hasOtherWorkInRound && !hasEverCompletedBuildSuccess && !actionsWaitChecked;

          if (isCommitBuildPoll) {
            if (actionsWaitChecked) {
              errorMessage = "重复检查已被拦截";
              resultText = JSON.stringify({
                status: "already_checked",
                note: "已完成本次提交的构建状态检查。规则限制只查看一次构建状态，严禁重复查询！请立即向用户交付最终汇报与修改详情。"
              });
              isToolError = false;
            } else {
              actionsWaitChecked = true;
              const primaryWorkflowName = "主要构建";
              addDebugLog("TOOL", "[Actions 即时检查] 提交后立即查询 GitHub Actions 构建状态");

              if (!abortSignal?.aborted && !clientResponse.destroyed) {
                sendReasoningChunk(
                  clientResponse,
                  "\n> ⏳ 修改已提交，正在立即查询 GitHub Actions 构建状态...\n",
                  requestBody.model
                );
              }

              let toolRes = null;
              try {
                toolRes = await callMcpTool(resolvedToolKey, args);
              } catch (err) {
                const msg = err instanceof Error ? err.message : "获取构建状态失败";
                errorMessage = extractErrorMessage(msg);
                resultText = JSON.stringify({ error: msg });
                isToolError = true;
              }

              // 3. 若未完成，加等 15 秒，最多 20 次（约 5 分钟）
              if (toolRes && !toolRes.isError) {
                let buildStatus = checkPrimaryBuildStatus(toolRes.content, primaryWorkflowName, lastWriteTimestamp);
                const MAX_EXTENSIONS = 20;
                let extensionCount = 0;
                let queueWaitCount = 0;

                while (!buildStatus.completed && extensionCount < MAX_EXTENSIONS) {
                  if (abortSignal?.aborted || clientResponse.destroyed) break;

                    if (buildStatus.isWaitingForNewRun) {
                      queueWaitCount += 1;
                    // 如果等待新排队超过 2 次（约 30 秒），说明 GitHub 没有自动触发构建，坚决退出等待，绝不空转！
                    if (queueWaitCount > 2) {
                      addDebugLog("TOOL", `[Actions 退出等待] 云端未检测到新提交排队或触发的构建任务（已等待约 30 秒），自动退出等待`);
                      break;
                    }
                  }

                  extensionCount += 1;
                  const waitPrompt = buildStatus.isWaitingForNewRun
                    ? `正在检测 GitHub Actions 云端调度状态（第 ${queueWaitCount}/2 次）...`
                    : `构建仍在打包中 [${buildStatus.status || "运行中"}]，自动延长等待 15 秒（第 ${extensionCount}/${MAX_EXTENSIONS} 次）...`;

                  addDebugLog("TOOL", `[Actions 加等] 主要构建 [${primaryWorkflowName}] ${waitPrompt}`);
                  if (!abortSignal?.aborted && !clientResponse.destroyed) {
                    sendReasoningChunk(
                      clientResponse,
                      `\n> ⏳ ${waitPrompt}\n`,
                      requestBody.model
                    );
                  }

                  for (let s = 0; s < 15; s += 1) {
                    if (abortSignal?.aborted || clientResponse.destroyed) break;
                    await new Promise((r) => setTimeout(r, 1000));
                  }
                  if (abortSignal?.aborted || clientResponse.destroyed) break;

                  try {
                    toolRes = await callMcpTool(resolvedToolKey, args, null);
                    buildStatus = checkPrimaryBuildStatus(toolRes.content, primaryWorkflowName, lastWriteTimestamp);
                  } catch {
                    break;
                  }
                }

                const totalWaited = extensionCount * 15;
                if (buildStatus.isFailure) {
                  // 构建失败：解锁并引导模型调 get_job_logs 自动修复
                  actionsWaitChecked = false;
                  hasPendingBuildVerification = false;
                  hasBuildTriggered = false;
                  hasEverCompletedBuildSuccess = false;
                  resultText = `${toolRes.content}\n\n【构建失败自愈提示】检测到主要构建 [${primaryWorkflowName}] 失败 (${buildStatus.conclusion || "failure"})。请立即调用 get_job_logs 获取编译错误日志，分析报错原因并使用 github_edit_file 修复代码！`;
                  if (!abortSignal?.aborted && !clientResponse.destroyed) {
                    sendReasoningChunk(
                      clientResponse,
                      `\n> ❌ 主要构建 [${primaryWorkflowName}] 失败，正在调取日志排查修复...\n`,
                      requestBody.model
                    );
                  }
                } else if (buildStatus.completed) {
                  hasPendingBuildVerification = false;
                  hasBuildTriggered = false;
                  hasEverCompletedBuildSuccess = true;
                  resultText = `${toolRes.content}\n\n【构建成功提示】主要工作流 [${primaryWorkflowName}] 构建成功！耗时约 ${totalWaited} 秒。项目所有修改与云端验证已全部完成，请立即向用户交付最终汇报。`;
                  if (!abortSignal?.aborted && !clientResponse.destroyed) {
                    sendReasoningChunk(
                      clientResponse,
                      `\n> ✅ 主要构建 [${primaryWorkflowName}] 构建成功！正在生成最终汇报...\n`,
                      requestBody.model
                    );
                  }
                } else if (buildStatus.isWaitingForNewRun) {
                  hasPendingBuildVerification = false;
                  hasBuildTriggered = false;
                  hasEverCompletedBuildSuccess = true;
                  resultText = `${toolRes.content}\n\n【未检测到云端自动构建任务】本次代码提交已成功推送到仓库，但在提交后约 30 秒内未检测到 GitHub Actions 触发或排队新的构建任务（可能该代码变更未满足工作流触发条件或 GitHub 自动调度未响应）。项目代码已全部修改完成，无需继续等待，请直接向用户汇报修改详情。`;
                  if (!abortSignal?.aborted && !clientResponse.destroyed) {
                    sendReasoningChunk(
                      clientResponse,
                      `\n> ℹ️ 未检测到云端触发新构建任务，代码已就绪，正在生成最终汇报...\n`,
                      requestBody.model
                    );
                  }
                } else {
                  hasPendingBuildVerification = false;
                  hasBuildTriggered = false;
                  hasEverCompletedBuildSuccess = true;
                  resultText = `${toolRes.content}\n\n【构建进行中提示】主要工作流 [${primaryWorkflowName}] 已在后台正常编译中（已等待 ${totalWaited} 秒）。无需继续原地空转死等，请立即向用户汇报修改详情并告知构建已在后台触发。`;
                  if (!abortSignal?.aborted && !clientResponse.destroyed) {
                    sendReasoningChunk(
                      clientResponse,
                      `\n> ⏱️ 主要构建 [${primaryWorkflowName}] 仍在后台编译打包中，准备交付答复...\n`,
                      requestBody.model
                    );
                  }
                }
                isToolError = toolRes.isError;
                if (!isToolError) executedToolCount += 1;
              }
            }
          } else {
            const cachedContent = !isWrite && !isTrigger ? dialogReadCache.get(callKey) : null;

            if (cachedContent !== undefined && cachedContent !== null) {
              isCacheHit = true;
              toolCallHistory.set(callKey, prevAttempts + 1);
              resultText = cachedContent;
              addDebugLog("TOOL", `MCP 工具 [${resolvedToolKey}] 命中本次对话只读缓存，直接复用 (${cachedContent.length} 字符)`, { arguments: args });
              isToolError = false;
            } else if (prevAttempts >= 5) {
              errorMessage = "该文件或资源连续查询失败";
              resultText = JSON.stringify({
                error: "该文件或资源已连续查询多次均未成功（可能路径不存在或拼写错误）。为防止反复重试浪费调用，请勿继续使用完全相同的路径重试，请先调用 get_repository_tree 查看真实文件目录结构。"
              });
              isToolError = true;
            } else {
              toolCallHistory.set(callKey, prevAttempts + 1);

              if (!abortSignal?.aborted && !clientResponse.destroyed) {
                sendReasoningChunk(
                  clientResponse,
                  `\n> ⏳ 正在调用 [${displayName}] 执行操作: \`${rawAction}\`${detailSuffix}...\n`,
                  requestBody.model
                );
              }

              try {
                const onWaitNotice = (waitSec) => {
                  if (!abortSignal?.aborted && !clientResponse.destroyed) {
                    sendReasoningChunk(
                      clientResponse,
                      `\n> ⏳ 触发访问频控，正在等待 ${waitSec + 1} 秒后自动重试...\n`,
                      requestBody.model
                    );
                  }
                };
                const toolRes = await callMcpTool(resolvedToolKey, args, onWaitNotice);
                resultText = toolRes.content;
                isToolError = toolRes.isError;
                if (isToolError && !errorMessage) {
                  errorMessage = extractErrorMessage(resultText);
                }
                if (!isToolError) {
                  executedToolCount += 1;
                  if (isWrite || isTrigger) {
                    hasWriteSuccess = true;
                    hasPendingBuildVerification = true;
                    lastWriteTimestamp = Date.now();
                    if (isTrigger) hasBuildTriggered = true;
                    actionsWaitChecked = false;
                    dialogReadCache.clear();
                    toolCallHistory.clear();
                    if (isTrigger) {
                      resultText = `${toolRes.content}\n\n【系统指令】工作流已成功触发并在云端开始排队运行！请紧接着调用 actions_list（method: 'list_workflow_runs'）来等待并查看本次构建结果，系统会在底层自动输出卡片并进行动态等待！严禁在此提前结束答复！`;
                    }
                  } else {
                    dialogReadCache.set(callKey, resultText);
                  }
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Tool execution failed";
                errorMessage = extractErrorMessage(msg);
                resultText = JSON.stringify({ error: msg });
                isToolError = true;
              }

              // 若本轮混杂了读写工具导致 actions_list 跳过了等待，给模型明确反馈
              if (isActionsListMethod && (hasBuildTriggered || hasPendingBuildVerification) && !isToolError) {
                if (hasEverCompletedBuildSuccess) {
                  resultText = `${resultText}\n\n【系统提示】本次对话已完成过云端构建验证，系统已跳过数分钟的耗时阻塞等待（0秒极速响应）。当前最新构建已在后台打包，请直接向用户交付最终汇报。`;
                } else if (hasOtherWorkInRound) {
                  resultText = `${resultText}\n\n【系统提示】检测到当前轮次中包含文件读取/搜索/修改工作，系统已跳过云端构建长等待（0 秒响应）。请集中完成所有文件的修改。待全部修改完成后，在独立终局轮次单独调用 actions_list 验证云端构建结果。`;
                }
              }
            }
          }
        }

        if (!abortSignal?.aborted && !clientResponse.destroyed) {
          if (isCacheHit) {
            sendReasoningChunk(
              clientResponse,
              `\n> ⚡ [${displayName}] \`${rawAction}\`${detailSuffix} (复用对话缓存)\n`,
              requestBody.model
            );
          } else if (isToolError) {
            const failReason = errorMessage ? `: ${errorMessage}` : "";
            sendReasoningChunk(
              clientResponse,
              `\n> ❌ [${displayName}] 执行失败${detailSuffix}${failReason}\n`,
              requestBody.model
            );
          } else if (!isCommitBuildPoll) {
            sendReasoningChunk(
              clientResponse,
              `\n> ✅ [${displayName}] 执行完成${detailSuffix}\n`,
              requestBody.model
            );
          }
        }

        return {
          tool_call_id: tc.id || `call_${crypto.randomUUID()}`,
          content: resultText,
          isToolError
        };
      });

      for (const res of callResults) {
        if (res.isToolError) {
          roundHasFailure = true;
        }
        messages.push({
          role: "tool",
          tool_call_id: res.tool_call_id,
          content: res.content
        });
      }

      if (roundHasFailure) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }
    }
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    dialogReadCache.clear();
  }
}

export async function handleGeminiGenerateContent(modelName, isStream, geminiBody, clientResponse, reqMeta, abortSignal) {
  const openAiMessages = convertGeminiToOpenAIMessages(geminiBody);
  const openAiBody = {
    model: modelName,
    messages: openAiMessages,
    stream: isStream,
    temperature: geminiBody.generationConfig?.temperature,
    max_tokens: geminiBody.generationConfig?.maxOutputTokens
  };

  if (geminiBody.generationConfig?.thinkingConfig) {
    openAiBody.thinkingConfig = geminiBody.generationConfig.thinkingConfig;
    const tc = geminiBody.generationConfig.thinkingConfig;

    let level = "";
    if (typeof tc.thinkingLevel === "string") {
      level = tc.thinkingLevel.toLowerCase().trim();
    }

    if (typeof tc.thinkingBudget === "number") {
      openAiBody.thinking_budget = tc.thinkingBudget;
      if (tc.thinkingBudget <= 0) level = "off";
      else if (tc.thinkingBudget < 2048) level = "low";
      else if (tc.thinkingBudget < 8192) level = "medium";
      else level = "high";
    }

    if (level) {
      openAiBody.reasoning_effort = level;
      if (level === "off") {
        openAiBody.thinking_budget = 0;
      } else if (level === "low") {
        openAiBody.thinking_budget = 1024;
      } else if (level === "medium") {
        openAiBody.thinking_budget = 4096;
      } else if (level === "high") {
        openAiBody.thinking_budget = 16384;
      }
    }
  }

  if (geminiBody.generationConfig) {
    for (const [k, v] of Object.entries(geminiBody.generationConfig)) {
      if (!["temperature", "maxOutputTokens"].includes(k)) {
        openAiBody[k] = v;
      }
    }
  }

  const mcpEnabled = isModelEnabledForMcp(modelName) && mcpToolRegistry.size > 0;

  addDebugLog("DOWNSTREAM", `收到 Gemini 格式请求 [${modelName}] - stream=${isStream}`, {
    model: modelName,
    stream: isStream,
    mcpEnabled,
    messagesCount: openAiMessages.length,
    thinkingConfig: geminiBody.generationConfig?.thinkingConfig || null,
    reasoning_effort: openAiBody.reasoning_effort || null
  });

  if (!isStream) {
    const fakeClientResponse = {
      _headers: {},
      _body: "",
      statusCode: 200,
      get destroyed() { return clientResponse.destroyed; },
      get writableEnded() { return clientResponse.writableEnded; },
      setHeader(k, v) { this._headers[k] = v; },
      writeHead(code, headers) { this.statusCode = code; Object.assign(this._headers, headers); },
      write(chunk) { this._body += chunk.toString(); },
      end(chunk) {
        if (abortSignal?.aborted || clientResponse.destroyed) return;
        if (chunk) this._body += chunk.toString();
        try {
          const json = JSON.parse(this._body);
          const candidateText = json.choices?.[0]?.message?.content || "";
          const reasoning = json.choices?.[0]?.message?.reasoning_content || "";
          const parts = [];
          if (reasoning) parts.push({ thought: true, text: reasoning });
          if (candidateText) parts.push({ text: candidateText });
          const rawReason = extractFinishReason(json);
          const geminiResp = {
            candidates: [
              {
                content: { parts: parts.length > 0 ? parts : [{ text: "" }], role: "model" },
                finishReason: isTruncatedFinishReason(rawReason) ? "MAX_TOKENS" : "STOP",
                index: 0
              }
            ]
          };
          addDebugLog("CONVERSATION", `【Gemini 对话完成】响应已交付客户端`);
          sendJson(clientResponse, 200, geminiResp);
        } catch {
          sendJson(clientResponse, 500, { error: { message: "Gemini 响应解析失败" } });
        }
      }
    };
    if (mcpEnabled) {
      await runAgent(openAiBody, fakeClientResponse, reqMeta, abortSignal);
    } else {
      await passThroughAndTransformGemini(openAiBody, clientResponse, false, abortSignal);
    }
    return;
  }

  if (mcpEnabled) {
    setCorsHeaders(clientResponse);
    clientResponse.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    let buffer = "";
    const fakeStreamClientResponse = {
      _headers: {},
      get destroyed() { return clientResponse.destroyed; },
      get writableEnded() { return clientResponse.writableEnded; },
      setHeader(k, v) { this._headers[k] = v; },
      writeHead(code, headers) { Object.assign(this._headers, headers); },
      write(chunk) {
        if (abortSignal?.aborted || clientResponse.destroyed) return;
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            if (!clientResponse.writableEnded) clientResponse.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const geminiChunk = convertOpenAiChunkToGemini(parsed);
            if (!clientResponse.writableEnded) clientResponse.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
          } catch {}
        }
      },
      end() {
        if (!clientResponse.writableEnded) {
          clientResponse.end();
        }
      }
    };
    await runAgent(openAiBody, fakeStreamClientResponse, reqMeta, abortSignal);
  } else {
    await passThroughAndTransformGemini(openAiBody, clientResponse, true, abortSignal);
  }
}
