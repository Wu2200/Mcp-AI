# MCP-AI

MCP-AI 可将已挂载的 GitHub MCP 与本项目提供的 GitHub 文件局部编辑工具聚合成一个原生 MCP 服务。客户端通过 MCP 协议直接发现并调用工具，不经过 OpenAI 或其他模型 API。

## 原生 MCP 接入

服务启动后，Streamable HTTP MCP 端点为 `/mcp`（聚合所有服务）或 `/mcp/:serverName`（限定单服务）。**默认直接采用 100% 官方原生工具名与描述，无需任何特殊开关或参数！**

将部署地址配置到支持 Streamable HTTP 的 MCP 客户端（如 Cursor, Claude Desktop, Windsurf, OpenMCP 等）即可开箱即用：

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

- **默认 100% 原生命名**：工具名默认直接使用官方原生名称（如 `get_file_contents`、`create_or_update_file` 等），绝无 `github_` 等前缀干扰；
- **纯净无噪描述**：工具描述自动剔除类似 `[github]` 的标签干扰，不影响下游大模型的标准指令遵循；
- **全多模态透传**：完整保留上游返回的图片（`type: "image"`）、嵌入资源（`type: "resource"`）与多段结构，绝无强行压扁成文本的损耗；
- **虚拟局部编辑增强**：原生提供 `edit_file`（代码片段比对替换，自动拉取、容错自愈与提交），告别大模型全量重写几十 KB 代码的截断与损坏问题；
- **双向无缝路由**：无论客户端发起原生名调用还是带前缀名调用，底层均实现 O(1) 精准双向直连匹配。

如果需要限定单服务，只需在路径中指定服务名（如 `/mcp/github`）。

`PROXY_API_KEY` 用于 `/mcp` 鉴权；客户端需支持为远程 MCP 配置 `Authorization: Bearer ...` 请求头。未设置该变量时端点不要求 API Key，公开部署时建议设置。

此 MCP 接入不依赖 `UPSTREAM_1` 等模型渠道配置。原有 OpenAI 兼容代理、Gemini 兼容接口和控制面板功能保持不变。

## 环境变量

- `UPSTREAM_1`: 第一组上游模型渠道配置，格式为 `接口地址|密钥` 或 `渠道名称|接口地址|密钥`。
- `UPSTREAM_2`: 第二组上游模型渠道配置，格式同上，可继续添加 `UPSTREAM_3`、`UPSTREAM_4` 等任意多组。
- `PROXY_API_KEY`: 代理接口及原生 MCP 端点的调用鉴权密钥。
- `PANEL_PASSWORD`: 控制面板登录管理密码。
- `DATABASE_URL`: 可选的 PostgreSQL 持久化连接地址。
