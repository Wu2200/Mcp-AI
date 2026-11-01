# MCP-AI

MCP-AI 可将已挂载的 GitHub MCP 与本项目提供的 GitHub 文件局部编辑工具聚合成一个原生 MCP 服务。客户端通过 MCP 协议直接发现并调用工具，不经过 OpenAI 或其他模型 API。

## 原生 MCP 接入

服务启动后，Streamable HTTP MCP 端点为 `/mcp` 或 `/mcp/:serverName`。将部署地址配置到支持 Streamable HTTP 的 MCP 客户端（如 Cursor, Claude Desktop, Windsurf, OpenMCP 等）即可。

### 1. 极致原生：单服务纯净反代（推荐）

直接反代特定上游服务（如 GitHub MCP），所有工具名 **100% 保持上游官方原生名称**（如 `get_file_contents`、`create_or_update_file`），去除一切前缀干扰，无缝适配任何第三方 Prompt 与 Agent 规则：

```json
{
  "mcpServers": {
    "github": {
      "url": "https://你的服务地址/mcp/github",
      "headers": {
        "Authorization": "Bearer 你的PROXY_API_KEY"
      }
    }
  }
}
```

- **零前缀污染**：工具名保留官方原生命名（不带 `github_` 等前缀），描述去除 `[github]` 标签；
- **全多模态透传**：完整保留上游返回的图片（`image`）、嵌入文件资源（`resource`）与多段结构，绝无扁平化压文本损失；
- **虚拟局部编辑增强**：原生提供 `edit_file`（代码片段比对替换，自动拉取、容错自愈与提交），无需全量重写几十 KB 文件；
- **双向无缝路由**：无论客户端发起原生名调用还是带前缀调用，均自动精准命中上游对应工具。

### 2. 全局多服务聚合反代

若希望一个端点同时暴露已连接的所有活跃 MCP 服务，可直接使用 `/mcp`：

```json
{
  "mcpServers": {
    "mcp-ai-hub": {
      "url": "https://你的服务地址/mcp",
      "headers": {
        "Authorization": "Bearer 你的PROXY_API_KEY"
      }
    }
  }
}
```
*(注：若需要在多服务聚合模式下同样优先采用原生工具名，可添加参数 `https://你的服务地址/mcp?native=true`)*

`PROXY_API_KEY` 用于 `/mcp` 鉴权；客户端需支持为远程 MCP 配置 `Authorization: Bearer ...` 请求头。未设置该变量时端点不要求 API Key，公开部署时建议设置。

此 MCP 接入不依赖 `UPSTREAM_1` 等模型渠道配置。原有 OpenAI 兼容代理、Gemini 兼容接口和控制面板功能保持不变。

## 环境变量

- `UPSTREAM_1`: 第一组上游模型渠道配置，格式为 `接口地址|密钥` 或 `渠道名称|接口地址|密钥`。
- `UPSTREAM_2`: 第二组上游模型渠道配置，格式同上，可继续添加 `UPSTREAM_3`、`UPSTREAM_4` 等任意多组。
- `PROXY_API_KEY`: 代理接口及原生 MCP 端点的调用鉴权密钥。
- `PANEL_PASSWORD`: 控制面板登录管理密码。
- `DATABASE_URL`: 可选的 PostgreSQL 持久化连接地址。
