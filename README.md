# MCP-AI

MCP-AI 是远程 MCP 服务反向代理与聚合器。它连接并管理多个远程 MCP 服务，并通过统一的 MCP 端点向客户端转发原生工具列表和工具调用。不调用 AI 模型，不需要配置 AI 上游接口，也不向模型注入提示词。

## 部署配置

打开部署后的服务根地址，在控制台添加远程 MCP 服务。只需填写服务名称和 MCP 地址；上游要求认证时，再填写该服务的认证令牌。

环境变量：

- `PROXY_API_KEY`：可选的 MCP 代理访问密钥；设置后客户端需携带 `Authorization: Bearer <密钥>`。
- `PANEL_PASSWORD`：可选的管理面板密码。
- `DATABASE_URL`：可选的 PostgreSQL 配置持久化连接地址。

无需配置 OpenAI、Gemini、模型名称或 `UPSTREAM_*` 环境变量。

## MCP 客户端

统一聚合端点：`https://你的服务地址/mcp`。也可使用 `https://你的服务地址/mcp/服务名称` 仅连接单个已挂载服务。

```json
{
  "mcpServers": {
    "mcp-proxy": {
      "url": "https://你的服务地址/mcp",
      "headers": {
        "Authorization": "Bearer 你的PROXY_API_KEY"
      }
    }
  }
}
```

未设置 `PROXY_API_KEY` 时，不需要配置客户端 `headers`。健康检查地址为 `/health`。
