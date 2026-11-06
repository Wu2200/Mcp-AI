# MCP-AI

MCP-AI 是一个远程 MCP 服务反向代理与聚合器。它连接并管理多个远程 MCP 服务，再通过单一 MCP 端点将上游工具列表和工具调用转发给 MCP 客户端。项目不调用 AI 模型，不需要配置 OpenAI、Gemini 或其他自定义 AI 上游接口。

## 部署与配置

部署后打开服务根地址进入控制台，在「挂载远程 MCP 服务」中填写服务名称和 MCP 服务地址；若上游 MCP 服务需要认证，再填写其认证令牌。服务连接成功后会同步可用工具，并可在控制台启用、停用或管理工具。

可配置以下环境变量：

- `PROXY_API_KEY`：可选的 MCP 代理访问密钥。配置后，客户端请求需携带 `Authorization: Bearer <密钥>`。
- `PANEL_PASSWORD`：可选的控制台登录密码。
- `DATABASE_URL`：可选的 PostgreSQL 持久化连接地址，用于保存 MCP 服务配置和控制台设置。

无需设置 `UPSTREAM_1`、`UPSTREAM_2` 或任何 AI 提供商的 API 地址、密钥和模型。

## MCP 客户端接入

Streamable HTTP MCP 接入端点为 `/mcp`，可聚合所有已挂载服务；`/mcp/:serverName` 可限定单个服务。服务名称可使用控制台中配置的名称。

```json
{
  "mcpServers": {
    "mcp-ai": {
      "url": "https://你的服务地址/mcp",
      "headers": {
        "Authorization": "Bearer 你的PROXY_API_KEY"
      }
    }
  }
}
```

如果未设置 `PROXY_API_KEY`，删除客户端配置中的 `headers` 即可。公开部署时建议设置该密钥。

代理默认保留上游 MCP 工具的原生名称、描述、参数结构及调用结果内容，并提供 GitHub 文件局部编辑工具增强。健康检查端点为 `/health`。
