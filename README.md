# MCP-AI

MCP-AI 可将已挂载的 GitHub MCP 与本项目提供的 GitHub 文件局部编辑工具聚合成一个原生 MCP 服务。客户端通过 MCP 协议直接发现并调用工具，不经过 OpenAI 或其他模型 API。

## 原生 MCP 接入

服务启动后，Streamable HTTP MCP 端点为 `/mcp`。将部署地址与 `/mcp` 配置到支持 Streamable HTTP 的 MCP 客户端即可。

```json
{
  "mcpServers": {
    "mcp-ai-github": {
      "url": "https://你的服务地址/mcp",
      "headers": {
        "Authorization": "Bearer 你的PROXY_API_KEY"
      }
    }
  }
}
```

在控制面板中先连接并启动 GitHub MCP。MCP-AI 会聚合该 GitHub 服务启用的工具；当其提供 `get_file_contents` 与 `create_or_update_file` 时，还会额外提供 `github_edit_file` 局部编辑工具。GitHub 服务通过名称包含 `github`、工具名带有 `github_` 前缀或具备上述文件读写工具来识别。其他 MCP 服务不会通过此端点暴露。

`PROXY_API_KEY` 用于 `/mcp` 鉴权；客户端需支持为远程 MCP 配置 `Authorization: Bearer ...` 请求头。未设置该变量时端点不要求 API Key，公开部署时建议设置。

此 MCP 接入不依赖 `UPSTREAM_1` 等模型渠道配置。原有 OpenAI 兼容代理、Gemini 兼容接口和控制面板功能保持不变。

## 环境变量

- `UPSTREAM_1`: 第一组上游模型渠道配置，格式为 `接口地址|密钥` 或 `渠道名称|接口地址|密钥`。
- `UPSTREAM_2`: 第二组上游模型渠道配置，格式同上，可继续添加 `UPSTREAM_3`、`UPSTREAM_4` 等任意多组。
- `PROXY_API_KEY`: 代理接口及原生 MCP 端点的调用鉴权密钥。
- `PANEL_PASSWORD`: 控制面板登录管理密码。
- `DATABASE_URL`: 可选的 PostgreSQL 持久化连接地址。
