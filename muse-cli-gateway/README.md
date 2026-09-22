# Muse Code CLI Gateway

沿用本仓库 Claude CLI / Antigravity CLI 的结构：OpenClaw 调用本机 OpenAI 兼容接口，网关启动官方 `muse exec`，工具操作交给现有 OpenClaw MCP proxy。

默认仅监听 `127.0.0.1:4571`，模型为 `muse-spark-1.3`。不直连 Meta 推理 API，不提取或转发订阅 token，不自动切到 API key 付费。

## 认证与隔离

- 必须先通过官方 `muse login` 完成设备登录。网关检查官方认证元数据为 `oauth / device_code / keychain`，不读取 Keychain 中的凭据。
- 每个请求建立独立的私有配置目录和空工作目录；配置目录中的 `auth.json` 只链接到官方认证元数据，实际认证仍由 Muse Code 处理。原有 `~/.config/muse/settings.json` 不变。
- 子进程清除 `META_API_KEY`、`MODEL_API_KEY` 和 transport trace 环境变量，避免按量 key 覆盖订阅登录。
- Native shell、write、web tools 关闭；MCP proxy 的服务端工具白名单来自该次 OpenClaw 请求的 `tools`。未提供工具、空工具列表或 `tool_choice: none` 不启动 MCP，避免空白名单被解释为全放行。
- 每次 HTTP 请求启动新 CLI。多轮对话由 OpenClaw 传入的完整历史续接，与现有两个网关一致；不宣称提供持久原生 Muse 会话绑定。
- 超时、断连会终止独立进程组并清理请求文件。日志只写状态、工具名、模型、耗时及长度，不记录提示词、正文、图片或工具参数。

认证检查证明使用官方设备登录路径，不代表已经核对账户账单或剩余额度。订阅额度耗尽时原样报错，不新增付费凭据。

## 接口

- `GET /health`：CLI 版本、认证元数据是否满足订阅路径、队列状态。
- `GET /v1/models`：唯一模型 `muse-spark-1.3`。
- `POST /v1/chat/completions`：文本、内联 PNG/JPEG/WebP 图片；JSON 或 SSE。

SSE 先发角色与运行/工具进度，正文在前台任务终态成功且 CLI 正常退出后交付。失败任务的中间文本不会冒充成功答案。`run.model.configured` 必须确认 `meta / muse-spark-1.3`，子任务终态不会完成主请求。

推理档位：`minimal / low / medium / high / xhigh / max`；默认 `high`，`off/none` 映射为 `minimal`，`ultra` 映射为 `max`。具体订阅是否支持最高档仍以服务端结果为准。

### 限制

- Muse Code 1.3.0 实测 JSONL 没有可用的完整 token 计数；响应不伪造 `usage`，`/health` 标明 `usageAvailable: false`。OpenClaw 的 API 标价元数据只用于估算，不能当作订阅账单。
- `max_tokens` 不会变成 CLI 的精确输出 token 上限；目前用总超时、流停滞超时和 `max-model-steps` 控制请求。
- 不接受远程图片 URL；OpenClaw 应先下载并以内联 data URI 提供图片。图片按编号与消息历史关联，通过官方 `--image` 输入。
- 本版使用稳定的 `exec --json`。MSP `serve` 在本机探针中接受 turn 后未完成输出，因此没有部署未经验证的 MSP 路径。
- Native CLI 的会话恢复、模型切换和独立子会话不由这个 HTTP 网关提供。

## 配置

常用环境变量：

- `MUSE_CLI_BIN`：默认 `~/.local/bin/muse`。
- `MUSE_CLI_GATEWAY_PORT`：默认 `4571`；监听地址固定为 loopback。
- `MUSE_CLI_GATEWAY_MAX_CONCURRENT`：默认 `2`。
- `MUSE_CLI_GATEWAY_QUEUE_TIMEOUT_MS`：默认 `120000`。
- `MUSE_CLI_GATEWAY_TIMEOUT_MS`：默认 `1800000`。
- `MUSE_CLI_GATEWAY_STALL_MS`：默认 `300000`。
- `MUSE_CLI_GATEWAY_MAX_MODEL_STEPS`：默认 `100`。
- `MUSE_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS`：默认 `600000`。
- `MUSE_CLI_GATEWAY_MAX_PROMPT_BYTES`：默认 `2000000`，按 UTF-8 字节检查。
- `MUSE_CLI_GATEWAY_STATE_DIR`：默认 `~/.openclaw/state/muse-cli-gateway`。
- `MUSE_CLI_GATEWAY_API_KEY`：可选的本地网关认证，不是 Meta 凭据。
- `MUSE_CLI_GATEWAY_MCP_PROXY`：默认本仓库的 `openclaw-mcp-proxy/server.js`。

## 安装服务

先跑测试，确认本机官方 CLI 登录可用，再仅安装此服务；不会重启 Claude、Antigravity 或 OpenClaw 网关。

```bash
node --test muse-cli-gateway/gateway.test.mjs
python3 muse-cli-gateway/install.py --render-only /tmp/muse-gateway-preview.plist
python3 muse-cli-gateway/install.py
```

日志：`~/.openclaw/logs/muse-cli-gateway.{stdout,stderr}.log`。实际 launchd label 为 `ai.openclaw.muse-cli-gateway`。

OpenClaw 注册独立 provider `muse-cli-gateway`，base URL 为 `http://127.0.0.1:4571/v1`，api 为 `openai-completions`。模型目录、modelPolicy allow 和 alias 须一起添加，但不改默认模型及回退链。示例 key 可用本地占位值；这里绝不放订阅凭据。

## 验证

离线回归覆盖 Unicode、历史边界、请求级 MCP 白名单、订阅认证检查、终态/模型校验、队列、取消、超时、SSE 失败传播及敏感字段遮盖：

```bash
node --test muse-cli-gateway/gateway.test.mjs
curl --fail http://127.0.0.1:4571/health
```

真实验收还需短答、历史续聊、图片和只读 MCP 工具调用。不能用 health 或 CLI exit 0 代替这些验收。

官方依据：

- <https://dev.meta.ai/docs/muse-code/subscriptions.md>
- <https://dev.meta.ai/docs/muse-code/auth.md>
- <https://dev.meta.ai/docs/muse-code/extending.md>
