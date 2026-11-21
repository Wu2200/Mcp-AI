import { GITHUB_TOKEN, GITHUB_API_URL } from "./store.js";

const GITHUB_EDIT_FILE_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string", description: "Repository owner (username or organization)" },
    repo: { type: "string", description: "Repository name" },
    path: { type: "string", description: "File path in the repository (e.g. 'src/index.js')" },
    branch: { type: "string", description: "Target branch name (defaults to the repository's default branch)" },
    message: { type: "string", description: "Commit message for the edit" },
    edits: {
      type: "array",
      description: "Sequential partial edits. Each item uses either search-and-replace (old_text + new_text) or 1-based line range (start_line + end_line + new_text).",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          old_text: { type: "string", description: "Exact existing text snippet to find and replace (include surrounding lines if needed for uniqueness)" },
          new_text: { type: "string", description: "Replacement text (use '' to delete matched text or lines)" },
          replace_all: { type: "boolean", description: "If true, replace all occurrences of old_text instead of requiring a unique match" },
          start_line: { type: "integer", minimum: 1, description: "1-based start line number for line-range edit" },
          end_line: { type: "integer", minimum: 0, description: "1-based inclusive end line number; set end_line = start_line - 1 to insert before start_line" }
        },
        required: ["new_text"]
      }
    },
    old_text: { type: "string", description: "Single-edit shortcut when edits array is omitted" },
    new_text: { type: "string", description: "Replacement text for single-edit shortcut" },
    replace_all: { type: "boolean", description: "For single-edit shortcut: replace all occurrences of old_text" },
    expected_sha: { type: "string", description: "Optional blob SHA from a prior read; aborts if remote file changed" },
    dry_run: { type: "boolean", description: "If true, compute and return diff preview without committing to GitHub" }
  },
  required: ["owner", "repo", "path", "message"]
};

const GITHUB_READ_LINES_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string", description: "Repository owner (username or organization)" },
    repo: { type: "string", description: "Repository name" },
    path: { type: "string", description: "File path in the repository" },
    branch: { type: "string", description: "Branch, tag, or commit SHA (defaults to default branch)" },
    start_line: { type: "integer", minimum: 1, description: "1-based start line number (default: 1)" },
    end_line: { type: "integer", minimum: 1, description: "1-based inclusive end line number (default: start_line + 199, max 500 lines per call)" }
  },
  required: ["owner", "repo", "path"]
};

export function buildBuiltInGitHubTools() {
  return [
    {
      name: "github_edit_file",
      description: "Partially edit an existing file in a GitHub repository without rewriting the full file. Fetches the latest file content and SHA, applies targeted search-and-replace or line-range edits, validates uniqueness, and commits the update with a unified diff preview.",
      inputSchema: GITHUB_EDIT_FILE_SCHEMA
    },
    {
      name: "github_read_file_lines",
      description: "Read a 1-based line range of a file in a GitHub repository with line numbers and blob SHA. Useful for inspecting large files or verifying exact lines before calling github_edit_file.",
      inputSchema: GITHUB_READ_LINES_SCHEMA
    }
  ];
}

export function isGitHubMcpServer({ name = "", url = "", tools = [] } = {}) {
  const rawNames = new Set((Array.isArray(tools) ? tools : []).map((t) => String(t?.rawName || t?.name || "").toLowerCase()));
  const hasRead = rawNames.has("get_file_contents") || rawNames.has("get_file");
  const hasWrite = rawNames.has("create_or_update_file") || rawNames.has("push_files");
  if (hasRead && hasWrite) return true;
  const lowerName = String(name || "").toLowerCase();
  const lowerUrl = String(url || "").toLowerCase();
  return lowerName.includes("github") || lowerUrl.includes("github.com") || lowerUrl.includes("githubcopilot.com");
}

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function isPureCrlf(text) {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
}

function normalizePath(filePath) {
  return String(filePath || "").trim().replace(/^\/+|\/+$/g, "");
}

function encodeGitHubPath(filePath) {
  return normalizePath(filePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function extractBearerToken(headers) {
  const auth = String(headers?.Authorization || headers?.authorization || "").trim();
  if (!auth) return "";
  return auth.replace(/^(?:Bearer|token)\s+/i, "").trim();
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findClosestLineMatches(contentLines, queryLines) {
  const needleLines = queryLines.map((line) => line.trim()).filter(Boolean);
  if (needleLines.length === 0) return "";
  const firstNeedle = needleLines[0];
  const candidates = [];
  for (let i = 0; i < contentLines.length; i += 1) {
    const trimmed = contentLines[i].trim();
    if (!trimmed) continue;
    if (trimmed === firstNeedle || (firstNeedle.length >= 6 && trimmed.includes(firstNeedle)) || (trimmed.length >= 6 && firstNeedle.includes(trimmed))) {
      candidates.push(i);
      if (candidates.length >= 3) break;
    }
  }
  if (candidates.length === 0) return "";
  return candidates.map((startIdx) => {
    const from = Math.max(0, startIdx - 1);
    const to = Math.min(contentLines.length, startIdx + Math.max(queryLines.length, 3) + 1);
    const snippet = contentLines.slice(from, to).map((line, offset) => `L${from + offset + 1}: ${line}`).join("\n");
    return `第 ${from + 1}-${to} 行附近:\n${snippet}`;
  }).join("\n---\n");
}

function applyTrimEndLineMatch(content, oldText, newText, replaceAll, editIndex) {
  const oldHasTrail = oldText.endsWith("\n");
  const newHasTrail = newText.endsWith("\n");
  if (newText !== "" && oldHasTrail !== newHasTrail) return null;

  const oldLines = (oldHasTrail ? oldText.slice(0, -1) : oldText).split("\n");
  if (oldLines.length === 0) return null;

  const contentLines = content.split("\n");
  const limit = oldHasTrail ? contentLines.length - oldLines.length : contentLines.length - oldLines.length + 1;
  const matchIndices = [];

  for (let i = 0; i < limit; i += 1) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (contentLines[i + j].trimEnd() !== oldLines[j].trimEnd()) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matchIndices.push(i);
      i += oldLines.length - 1;
    }
  }

  if (matchIndices.length === 0) return null;
  if (matchIndices.length > 1 && !replaceAll) {
    const locations = matchIndices.slice(0, 10).map((idx) => `第 ${idx + 1} 行`).join("、");
    throw new Error(`edits[${editIndex}] 在忽略行尾空白后匹配到 ${matchIndices.length} 处（${locations}），请提供更多上下文或设置 replace_all: true。`);
  }

  const replacementLines = newText === ""
    ? []
    : (newHasTrail ? newText.slice(0, -1) : newText).split("\n");

  const nextLines = [...contentLines];
  for (let k = matchIndices.length - 1; k >= 0; k -= 1) {
    nextLines.splice(matchIndices[k], oldLines.length, ...replacementLines);
  }
  return nextLines.join("\n");
}

function applySearchReplaceEdit(content, edit, editIndex) {
  const oldText = normalizeNewlines(edit.old_text);
  const newText = normalizeNewlines(edit.new_text);
  const replaceAll = edit.replace_all === true;

  if (!oldText) {
    throw new Error(`edits[${editIndex}].old_text 不能为空。`);
  }

  const matches = [];
  let searchFrom = 0;
  while (searchFrom <= content.length) {
    const idx = content.indexOf(oldText, searchFrom);
    if (idx === -1) break;
    matches.push(idx);
    searchFrom = idx + oldText.length;
  }

  if (matches.length === 1) {
    return content.slice(0, matches[0]) + newText + content.slice(matches[0] + oldText.length);
  }

  if (matches.length > 1) {
    if (replaceAll) return content.split(oldText).join(newText);
    const lineList = matches.slice(0, 10).map((idx) => `第 ${lineNumberAt(content, idx)} 行`).join("、");
    throw new Error(`edits[${editIndex}] 匹配到 ${matches.length} 处相同片段（${lineList}），请补充更多前后上下文以确保唯一性，或设置 replace_all: true。`);
  }

  const fallbackResult = applyTrimEndLineMatch(content, oldText, newText, replaceAll, editIndex);
  if (fallbackResult !== null) return fallbackResult;

  const contentLines = content.split("\n");
  const queryLines = (oldText.endsWith("\n") ? oldText.slice(0, -1) : oldText).split("\n");
  const hints = findClosestLineMatches(contentLines, queryLines);
  throw new Error(`edits[${editIndex}] 未能在文件中找到匹配片段。${hints ? `\n最接近的内容供参考：\n${hints}` : ""}`);
}

function applyLineRangeEdits(content, edits) {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content === "" ? [] : (hadTrailingNewline ? content.slice(0, -1).split("\n") : content.split("\n"));

  const normalized = edits.map((edit, idx) => {
    const start = Number(edit.start_line);
    const end = edit.end_line === undefined || edit.end_line === null ? start : Number(edit.end_line);
    if (!Number.isInteger(start) || start < 1 || start > lines.length + 1) {
      throw new Error(`edits[${idx}].start_line (${edit.start_line}) 超出范围（文件共 ${lines.length} 行）。`);
    }
    if (!Number.isInteger(end) || end < start - 1 || end > lines.length) {
      throw new Error(`edits[${idx}].end_line (${edit.end_line}) 无效或超出范围（文件共 ${lines.length} 行）。`);
    }
    if (typeof edit.new_text !== "string") {
      throw new Error(`edits[${idx}].new_text 必须为字符串。`);
    }
    if (typeof edit.old_text === "string" && end >= start) {
      const sliceText = lines.slice(start - 1, end).join("\n");
      const expected = normalizeNewlines(edit.old_text).replace(/\n$/, "");
      if (sliceText !== expected) {
        throw new Error(`edits[${idx}] 第 ${start}-${end} 行的当前内容与传入的 old_text 不一致：\n实际内容：\n${sliceText}`);
      }
    }
    return { idx, start, end, newText: normalizeNewlines(edit.new_text) };
  });

  const sorted = [...normalized].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end || (prev.end < prev.start && curr.start === prev.start)) {
      throw new Error(`行号编辑区间存在重叠：edits[${prev.idx}] (${prev.start}-${prev.end}) 与 edits[${curr.idx}] (${curr.start}-${curr.end})。`);
    }
  }

  let lastInsertedEndsWithNewline = false;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const item = sorted[i];
    const deleteCount = item.end >= item.start ? item.end - item.start + 1 : 0;
    const insertLines = item.newText === ""
      ? []
      : (item.newText.endsWith("\n") ? item.newText.slice(0, -1) : item.newText).split("\n");
    if (item.newText.endsWith("\n")) lastInsertedEndsWithNewline = true;
    lines.splice(item.start - 1, deleteCount, ...insertLines);
  }

  if (lines.length === 0) return "";
  return lines.join("\n") + (hadTrailingNewline || lastInsertedEndsWithNewline ? "\n" : "");
}

function applySingleLineRangeEdit(content, edit, editIndex) {
  return applyLineRangeEdits(content, [edit]).replace(/\n$/, (match) => (content.endsWith("\n") || String(edit.new_text).endsWith("\n") ? match : ""));
}

function applyEditsToContent(originalText, args) {
  let rawEdits;
  if (Array.isArray(args.edits) && args.edits.length > 0) {
    rawEdits = args.edits;
  } else if (typeof args.old_text === "string" || args.start_line !== undefined) {
    rawEdits = [{
      old_text: args.old_text,
      new_text: args.new_text,
      replace_all: args.replace_all,
      start_line: args.start_line,
      end_line: args.end_line
    }];
  } else {
    throw new Error("必须提供 edits 数组，或提供 old_text + new_text / start_line + new_text。");
  }

  for (let i = 0; i < rawEdits.length; i += 1) {
    const item = rawEdits[i];
    if (!item || typeof item !== "object" || typeof item.new_text !== "string") {
      throw new Error(`edits[${i}] 必须为对象且包含字符串类型的 new_text。`);
    }
    if (typeof item.old_text !== "string" && item.start_line === undefined) {
      throw new Error(`edits[${i}] 必须提供 old_text 或 start_line。`);
    }
  }

  const pureCrlf = isPureCrlf(originalText);
  const baseNormalized = normalizeNewlines(originalText);
  const allLineBased = rawEdits.every((item) => typeof item.old_text !== "string" && item.start_line !== undefined);

  let working = baseNormalized;
  if (allLineBased) {
    working = applyLineRangeEdits(working, rawEdits);
  } else {
    for (let i = 0; i < rawEdits.length; i += 1) {
      const item = rawEdits[i];
      if (typeof item.old_text === "string" && item.start_line === undefined) {
        working = applySearchReplaceEdit(working, item, i);
      } else {
        working = applySingleLineRangeEdit(working, item, i);
      }
    }
  }

  const finalText = pureCrlf ? working.replace(/\n/g, "\r\n") : working;
  return {
    originalNormalized: baseNormalized,
    updatedNormalized: working,
    finalText,
    editCount: rawEdits.length
  };
}

function generateUnifiedDiff(oldNorm, newNorm, filePath) {
  if (oldNorm === newNorm) return "";
  const oldLines = oldNorm === "" ? [] : (oldNorm.endsWith("\n") ? oldNorm.slice(0, -1).split("\n") : oldNorm.split("\n"));
  const newLines = newNorm === "" ? [] : (newNorm.endsWith("\n") ? newNorm.slice(0, -1).split("\n") : newNorm.split("\n"));

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (suffix < minLen - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
    suffix += 1;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const ops = [];

  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: " ", line: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  if (midOld.length * midNew.length <= 200000) {
    const m = midOld.length;
    const n = midNew.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i][j] = midOld[i] === midNew[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        ops.push({ type: " ", line: midOld[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "-", line: midOld[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i += 1;
      } else {
        ops.push({ type: "+", line: midNew[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        j += 1;
      }
    }
    while (i < m) {
      ops.push({ type: "-", line: midOld[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
      i += 1;
    }
    while (j < n) {
      ops.push({ type: "+", line: midNew[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
      j += 1;
    }
  } else {
    for (let i = 0; i < midOld.length; i += 1) {
      ops.push({ type: "-", line: midOld[i], oldLine: prefix + i + 1, newLine: prefix + 1 });
    }
    for (let j = 0; j < midNew.length; j += 1) {
      ops.push({ type: "+", line: midNew[j], oldLine: prefix + 1, newLine: prefix + j + 1 });
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const oldIdx = oldLines.length - suffix + i;
    const newIdx = newLines.length - suffix + i;
    ops.push({ type: " ", line: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
  }

  const contextLines = 3;
  const changedIndices = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].type !== " ") changedIndices.push(i);
  }
  if (changedIndices.length === 0) return "";

  const ranges = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    if (ranges.length && start <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = end;
    } else {
      ranges.push([start, end]);
    }
  }

  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const hunks = ranges.map(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    const oldStart = slice[0].oldLine;
    const newStart = slice[0].newLine;
    const oldCount = slice.filter((op) => op.type !== "+").length;
    const newCount = slice.filter((op) => op.type !== "-").length;
    const body = slice.map((op) => `${op.type}${op.line}`);
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join("\n")}`;
  });

  const fullDiff = [...header, ...hunks].join("\n");
  return fullDiff.length > 8000 ? `${fullDiff.slice(0, 8000)}\n... [diff truncated]` : fullDiff;
}

async function githubRestRequest(token, endpointPath, options = {}) {
  const response = await fetch(`${GITHUB_API_URL}${endpointPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "mcp-proxy/1.0.0",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${data?.message || text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function readFileViaRest({ owner, repo, path, branch, token }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = encodeGitHubPath(path);
  const refQuery = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const data = await githubRestRequest(token, `/repos/${encodedOwner}/${encodedRepo}/contents/${encodedPath}${refQuery}`);

  if (Array.isArray(data)) {
    throw new Error(`路径 "${path}" 是目录，不是文件。`);
  }
  if (data?.type !== "file") {
    throw new Error(`不支持的 GitHub 内容类型：${data?.type || "unknown"}`);
  }

  let buffer;
  if (typeof data.content === "string" && data.encoding === "base64") {
    buffer = Buffer.from(data.content.replace(/\s+/g, ""), "base64");
  } else if (data.sha) {
    const blob = await githubRestRequest(token, `/repos/${encodedOwner}/${encodedRepo}/git/blobs/${encodeURIComponent(data.sha)}`);
    if (typeof blob?.content !== "string") throw new Error("无法读取文件内容。");
    buffer = Buffer.from(blob.content.replace(/\s+/g, ""), "base64");
  } else {
    throw new Error("GitHub API 未返回文件内容。");
  }

  if (buffer.includes(0)) {
    throw new Error("目标文件疑似二进制文件，不支持文本局部修改。");
  }

  return {
    content: buffer.toString("utf8"),
    sha: data.sha,
    branch: branch || "",
    source: "rest"
  };
}

async function writeFileViaRest({ owner, repo, path, branch, message, content, sha, token }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = encodeGitHubPath(path);
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha
  };
  if (branch) body.branch = branch;
  const data = await githubRestRequest(token, `/repos/${encodedOwner}/${encodedRepo}/contents/${encodedPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    commitSha: data?.commit?.sha || "",
    newSha: data?.content?.sha || "",
    htmlUrl: data?.content?.html_url || data?.commit?.html_url || ""
  };
}

function findUpstreamTool(serverTools, candidates) {
  const list = Array.isArray(serverTools) ? serverTools : [];
  for (const name of candidates) {
    const found = list.find((tool) => !tool.isBuiltIn && String(tool.rawName || "").toLowerCase() === name);
    if (found) return found;
  }
  return null;
}

function extractMcpText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.map((b) => (typeof b?.text === "string" ? b.text : b?.resource?.text || "")).filter(Boolean).join("\n");
}

function parseUpstreamGetFileResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  if (result?.isError) {
    throw new Error(extractMcpText(result) || "上游读取文件失败");
  }

  let sha = "";
  let fileText = null;

  for (const block of blocks) {
    if (block?.type === "resource" && typeof block.resource?.text === "string") {
      fileText = block.resource.text;
    }
    if (typeof block?.text === "string") {
      const shaMatch = block.text.match(/\(SHA:\s*([0-9a-f]{40})\)/i) || block.text.match(/"sha"\s*:\s*"([0-9a-f]{40})"/i);
      if (shaMatch && !sha) sha = shaMatch[1];

      const trimmed = block.text.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (!sha && typeof parsed.sha === "string") sha = parsed.sha;
          if (fileText === null && typeof parsed.content === "string") {
            fileText = parsed.encoding === "base64"
              ? Buffer.from(parsed.content.replace(/\s+/g, ""), "base64").toString("utf8")
              : parsed.content;
          }
        } catch {}
      } else if (fileText === null && !/^successfully downloaded text file/i.test(trimmed)) {
        fileText = block.text;
      }
    }
  }

  if (fileText === null || !sha) {
    throw new Error("无法从上游 MCP 响应中解析文件内容或 SHA。");
  }
  if (Buffer.from(fileText, "utf8").includes(0)) {
    throw new Error("目标文件疑似二进制文件，不支持文本局部修改。");
  }
  return { content: fileText, sha };
}

async function resolveDefaultBranchViaMcp({ owner, repo, serverTools, invokeUpstream }) {
  const getRepoTool = findUpstreamTool(serverTools, ["get_repository", "get_repo"]);
  if (getRepoTool) {
    try {
      const res = await invokeUpstream(getRepoTool.rawName, { owner, repo });
      const text = extractMcpText(res);
      const parsed = JSON.parse(text);
      if (typeof parsed?.default_branch === "string" && parsed.default_branch) return parsed.default_branch;
    } catch {}
  }
  const searchReposTool = findUpstreamTool(serverTools, ["search_repositories"]);
  if (searchReposTool) {
    try {
      const res = await invokeUpstream(searchReposTool.rawName, { query: `${owner}/${repo}` });
      const parsed = JSON.parse(extractMcpText(res));
      const match = (parsed?.items || []).find((item) => String(item?.full_name || "").toLowerCase() === `${owner}/${repo}`.toLowerCase());
      if (typeof match?.default_branch === "string" && match.default_branch) return match.default_branch;
    } catch {}
  }
  return "main";
}

async function readFileViaMcp({ owner, repo, path, branch, serverTools, invokeUpstream }) {
  const readTool = findUpstreamTool(serverTools, ["get_file_contents", "get_file"]);
  if (!readTool || typeof invokeUpstream !== "function") {
    throw new Error("未配置可用的 GitHub Token，且上游服务不提供 get_file_contents 工具。");
  }
  const props = readTool.inputSchema?.properties || {};
  const args = { owner, repo, path: normalizePath(path) };
  if (branch) {
    if ("ref" in props) args.ref = branch;
    else if ("branch" in props) args.branch = branch;
    else args.ref = branch;
  }
  const result = await invokeUpstream(readTool.rawName, args);
  const parsed = parseUpstreamGetFileResult(result);
  return { ...parsed, branch: branch || "", source: "mcp" };
}

async function writeFileViaMcp({ owner, repo, path, branch, message, content, sha, serverTools, invokeUpstream }) {
  const writeTool = findUpstreamTool(serverTools, ["create_or_update_file"]);
  if (!writeTool || typeof invokeUpstream !== "function") {
    throw new Error("上游服务不提供 create_or_update_file 工具。");
  }
  const required = Array.isArray(writeTool.inputSchema?.required) ? writeTool.inputSchema.required : [];
  let targetBranch = branch;
  if (!targetBranch && required.includes("branch")) {
    targetBranch = await resolveDefaultBranchViaMcp({ owner, repo, serverTools, invokeUpstream });
  }
  const args = {
    owner,
    repo,
    path: normalizePath(path),
    content,
    message,
    sha
  };
  if (targetBranch) args.branch = targetBranch;
  const result = await invokeUpstream(writeTool.rawName, args);
  if (result?.isError) {
    throw new Error(extractMcpText(result) || "上游 create_or_update_file 返回错误");
  }
  const text = extractMcpText(result);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return {
    commitSha: parsed?.commit?.sha || "",
    newSha: parsed?.content?.sha || "",
    htmlUrl: parsed?.content?.html_url || parsed?.commit?.html_url || "",
    rawMessage: parsed ? "" : text.slice(0, 500)
  };
}

async function readTargetFile({ owner, repo, path, branch, headers, serverTools, invokeUpstream }) {
  const token = extractBearerToken(headers) || GITHUB_TOKEN;
  const hasMcpRead = Boolean(findUpstreamTool(serverTools, ["get_file_contents", "get_file"]) && typeof invokeUpstream === "function");

  if (token) {
    try {
      return await readFileViaRest({ owner, repo, path, branch, token });
    } catch (error) {
      if (hasMcpRead && [401, 403, 404].includes(error?.status)) {
        return await readFileViaMcp({ owner, repo, path, branch, serverTools, invokeUpstream });
      }
      throw error;
    }
  }

  return await readFileViaMcp({ owner, repo, path, branch, serverTools, invokeUpstream });
}

async function handleReadFileLines({ args, headers, serverTools, invokeUpstream }) {
  const owner = String(args?.owner || "").trim();
  const repo = String(args?.repo || "").trim();
  const filePath = normalizePath(args?.path);
  const branch = String(args?.branch || "").trim();

  if (!owner || !repo || !filePath) {
    throw new Error("参数 owner、repo、path 不能为空。");
  }

  const file = await readTargetFile({ owner, repo, path: filePath, branch, headers, serverTools, invokeUpstream });
  const normalized = normalizeNewlines(file.content);
  const lines = normalized === "" ? [] : (normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n"));
  const totalLines = lines.length;

  const startLine = Math.max(1, Number.isInteger(Number(args?.start_line)) ? Number(args.start_line) : 1);
  const requestedEnd = Number.isInteger(Number(args?.end_line)) ? Number(args.end_line) : startLine + 199;
  const endLine = Math.min(totalLines, Math.max(startLine, Math.min(requestedEnd, startLine + 499)));

  const slice = startLine <= totalLines
    ? lines.slice(startLine - 1, endLine).map((line, index) => `L${startLine + index}: ${line}`).join("\n")
    : "";

  const header = [
    `File: ${owner}/${repo}/${filePath}`,
    `Branch: ${branch || "(default)"}`,
    `SHA: ${file.sha}`,
    `Lines: ${totalLines === 0 ? "0 (empty file)" : `${startLine}-${endLine} of ${totalLines}`}`
  ].join("\n");

  return {
    content: [{ type: "text", text: slice ? `${header}\n\n${slice}` : header }]
  };
}

async function handleEditFile({ args, headers, serverTools, invokeUpstream }) {
  const owner = String(args?.owner || "").trim();
  const repo = String(args?.repo || "").trim();
  const filePath = normalizePath(args?.path);
  const branch = String(args?.branch || "").trim();
  const dryRun = args?.dry_run === true;
  const message = String(args?.message || "").trim() || (dryRun ? "(dry-run)" : "");
  const expectedSha = String(args?.expected_sha || "").trim();

  if (!owner || !repo || !filePath || !message) {
    throw new Error("参数 owner、repo、path、message 不能为空。");
  }

  const file = await readTargetFile({ owner, repo, path: filePath, branch, headers, serverTools, invokeUpstream });
  if (expectedSha && file.sha !== expectedSha) {
    throw new Error(`文件 SHA 冲突：期望 ${expectedSha}，当前远端最新为 ${file.sha}。请重新读取文件后再编辑。`);
  }

  const edited = applyEditsToContent(file.content, args || {});
  if (edited.finalText === file.content) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          changed: false,
          path: filePath,
          sha: file.sha,
          message: "编辑后文件内容与原文件完全一致，未创建新提交。"
        }, null, 2)
      }]
    };
  }

  const diff = generateUnifiedDiff(edited.originalNormalized, edited.updatedNormalized, filePath);
  if (dryRun) {
    return {
      content: [{
        type: "text",
        text: `Dry run 成功（未提交到 GitHub）\nPath: ${owner}/${repo}/${filePath}\nBase SHA: ${file.sha}\nEdits applied: ${edited.editCount}\n\n${diff}`
      }]
    };
  }

  const token = extractBearerToken(headers) || GITHUB_TOKEN;
  const writeResult = file.source === "rest" && token
    ? await writeFileViaRest({ owner, repo, path: filePath, branch, message, content: edited.finalText, sha: file.sha, token })
    : await writeFileViaMcp({ owner, repo, path: filePath, branch, message, content: edited.finalText, sha: file.sha, serverTools, invokeUpstream });

  const summaryLines = [
    `局部修改已提交到 GitHub：${owner}/${repo}/${filePath}`,
    `Branch: ${branch || "(default)"}`,
    `Previous SHA: ${file.sha}`,
    writeResult.newSha ? `New SHA: ${writeResult.newSha}` : "",
    writeResult.commitSha ? `Commit SHA: ${writeResult.commitSha}` : "",
    writeResult.htmlUrl ? `URL: ${writeResult.htmlUrl}` : "",
    `Applied edits: ${edited.editCount}`,
    "",
    diff
  ].filter((line) => line !== "");

  return {
    content: [{ type: "text", text: summaryLines.join("\n") }]
  };
}

export async function executeBuiltInGitHubTool({ rawName, args, headers = {}, serverTools = [], invokeUpstream = null }) {
  try {
    if (rawName === "github_edit_file") {
      return await handleEditFile({ args, headers, serverTools, invokeUpstream });
    }
    if (rawName === "github_read_file_lines") {
      return await handleReadFileLines({ args, headers, serverTools, invokeUpstream });
    }
    return {
      content: [{ type: "text", text: `未知的内置 GitHub 工具：${rawName}` }],
      isError: true
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: detail }],
      isError: true
    };
  }
}
