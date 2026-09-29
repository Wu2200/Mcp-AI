# MCP Agent Proxy

专为 Chatbox、NextChat 等客户端设计的通用 MCP 代理服务。

## 环境变量
- `UPSTREAM_1`: 第一组上游渠道配置，格式为 `接口地址|密钥` 或 `渠道名称|接口地址|密钥`。
- `UPSTREAM_2`: 第二组上游渠道配置，格式同上，可继续添加 `UPSTREAM_3`、`UPSTREAM_4` 等任意多组。
- `PROXY_API_KEY`: 本代理服务的调用鉴权密钥。
- `PANEL_PASSWORD`: 控制面板登录管理密码。
