import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-4o";
const MCP_SERVERS = (process.env.MCP_SERVERS || "").split(",").filter(Boolean);

function getToolAction(toolName) {
  const name = (toolName || "").toLowerCase();
  if (name.includes("delete") || name.includes("remove")) {
    return "删除";
  }
  if (name.includes("update") || name.includes("merge") || name.includes("resolve") || name.includes("patch") || name.includes("edit")) {
    return "更新/修改";
  }
  if (name.includes("create") || name.includes("add") || name.includes("push") || name.includes("fork")) {
    return "创建";
  }
  if (name.includes("get") || name.includes("list") || name.includes("search") || name.includes("read") || name.includes("docs")) {
    return "查询";
  }
  if (name.includes("execute") || name.includes("run")) {
    return "执行";
  }
  return "处理";
}

function getServiceDisplayName(toolName) {
  const name = (toolName || "").toLowerCase();
  if (name.includes("github")) {
    return "GitHub";
  }
  if (name.includes("cloudflare")) {
    return "Cloudflare";
  }
  return "外部";
}

async function fetchMcpTools() {
  const tools = [];
  for (const serverUrl of MCP_SERVERS) {
    try {
      const response = await fetch(serverUrl.trim(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 1,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.result && Array.isArray(data.result.tools)) {
          for (const tool of data.result.tools) {
            tools.push({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description || "",
                parameters: tool.inputSchema || { type: "object", properties: {} },
              },
              serverUrl: serverUrl.trim(),
            });
          }
        }
      }
    } catch (err) {}
  }
  return tools;
}

async function callMcpTool(serverUrl, toolName, args) {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
      id: 2,
    }),
  });
  if (!response.ok) {
    throw new Error(`MCP 调用失败: ${response.status}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "MCP 执行出错");
  }
  return data.result;
}

function sendReasoningChunk(res, text, model) {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          reasoning_content: text,
        },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sendContentChunk(res, text, model) {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        delta: {
          content: text,
        },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sendDoneChunk(res) {
  res.write("data: [DONE]\n\n");
}

async function handleChatCompletions(req, res, body) {
  let requestData;
  try {
    requestData = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    return;
  }

  const isStream = Boolean(requestData.stream);
  const model = requestData.model || DEFAULT_MODEL;
  const messages = requestData.messages || [];

  const mcpTools = await fetchMcpTools();
  const toolsPayload = mcpTools.map((t) => ({
    type: t.type,
    function: t.function,
  }));

  if (isStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }

  let currentMessages = [...messages];
  let isLooping = true;
  let maxRounds = 10;

  while (isLooping && maxRounds > 0) {
    maxRounds--;

    const upstreamPayload = {
      ...requestData,
      model,
      messages: currentMessages,
      stream: false,
    };

    if (toolsPayload.length > 0) {
      upstreamPayload.tools = toolsPayload;
      upstreamPayload.tool_choice = "auto";
    }

    const authHeader = req.headers["authorization"] || (OPENAI_API_KEY ? `Bearer ${OPENAI_API_KEY}` : "");

    const upstreamRes = await fetch(`${OPENAI_API_BASE.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(upstreamPayload),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      if (isStream) {
        sendContentChunk(res, `\n\n上游请求错误: ${errText}`, model);
        sendDoneChunk(res);
        res.end();
      } else {
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
        res.end(errText);
      }
      return;
    }

    const upstreamData = await upstreamRes.json();
    const choice = upstreamData.choices && upstreamData.choices[0];
    if (!choice) {
      break;
    }

    const assistantMsg = choice.message || {};
    currentMessages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls;
    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const fnName = tc.function.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments || "{}");
        } catch (e) {
          fnArgs = {};
        }

        const matchedTool = mcpTools.find((t) => t.function.name === fnName);
        const serviceName = getServiceDisplayName(fnName);
        const actionName = getToolAction(fnName);

        if (isStream) {
          sendReasoningChunk(res, `> 正在调用 ${serviceName} ${actionName}工具\n`, model);
        }

        let toolResultStr = "";
        let isError = false;
        try {
          if (!matchedTool) {
            throw new Error(`未找到工具: ${fnName}`);
          }
          const result = await callMcpTool(matchedTool.serverUrl, fnName, fnArgs);
          toolResultStr = typeof result === "string" ? result : JSON.stringify(result);
        } catch (callErr) {
          isError = true;
          toolResultStr = `工具调用失败: ${callErr.message}`;
        }

        if (isStream) {
          if (isError) {
            sendReasoningChunk(res, `> ${serviceName} ${actionName}失败\n\n`, model);
          } else {
            sendReasoningChunk(res, `> ${serviceName} ${actionName}完成\n\n`, model);
          }
        }

        currentMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResultStr,
        });
      }
    } else {
      isLooping = false;
      if (isStream) {
        if (assistantMsg.content) {
          sendContentChunk(res, assistantMsg.content, model);
        }
        sendDoneChunk(res);
        res.end();
        return;
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(upstreamData));
        return;
      }
    }
  }

  if (isStream && !res.writableEnded) {
    sendDoneChunk(res);
    res.end();
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: DEFAULT_MODEL, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "custom" },
        ],
      })
    );
    return;
  }

  if ((reqUrl.pathname === "/v1/chat/completions" || reqUrl.pathname === "/chat/completions") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      handleChatCompletions(req, res, body);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not Found" } }));
});

server.listen(PORT, () => {});