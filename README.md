# MCP Agent Proxy

专为 Chatbox、NextChat 等客户端设计的通用 MCP (Model Context Protocol) 代理服务。

## 环境变量
- `UPSTREAM_BASE_URL`: 上游兼容 OpenAI 接口的大模型服务地址（如你的 CLIProxyAPI）。
- `UPSTREAM_API_KEY`: 上游大模型服务的 API Key。
- `PROXY_API_KEY` (可选): 本代理服务的调用鉴权密钥。
