# Muse Code 1.3.0 接入验收

Muse 网关与 Claude、Antigravity 位于同一仓库。新增 Contributor、官方会话用量采集、输入完整性检查和共享 HTML 看板页签。

## 上下文结论

不使用 API 宣传的1,048,576作为本机CLI安全值。CLI目录报告context_limit=1,007,997、output_limit=128,000，但实际运行记录中的压缩预算是512,000，soft/hard阈值为384,000/460,800。

合成输入分散放置6个随机校验值，值不在指令中重复，关闭工具及观察器，核对回答、首轮实际模型输入的字节计数及压缩事件：

| 模型 | 输入字节 | 语言 | 校验值 | 首轮原文计数 | 服务端报告输入tokens |
|---|---:|---|---|---:|---:|
| Standard | 299,849 | ASCII | 6/6 | 299,853 | 100,254 |
| Standard | 1,399,853 | ASCII | 6/6 | 1,399,857 | 400,256 |
| Standard | 2,499,851 | ASCII | 1/6 | 0（原文已被压缩替换） | 19,604 |
| Contributor | 1,399,853 | ASCII | 6/6 | 1,399,857 | 400,113 |
| Contributor | 899,843 | 中文 | 6/6 | 899,847 | 290,645 |
| Contributor | 2,799,851 | ASCII | 1/6 | 0（原文已被压缩替换） | 19,461 |
| Contributor | 4,499,849 | ASCII | 1/6 | 0（原文已被压缩替换） | 19,432 |

过长用例仍exit0，因此成功退出不能证明全文送达。网关设1,400,000 UTF-8字节上限，OpenClaw安全context设384,000，并逐请求检查首轮原文完整性；预先压缩/裁剪的请求返回413，不交付残缺输入的答案。这是有余量的接入预算，不宣称384,000是模型硬上限。用量计数包含计费调整，也不是精确上下文占用值。

## Token计数与计价

标准stdout JSONL不含完整计数，但官方会话账本的model_completed包含输入、输出、缓存及推理。按source_run_record_id+run_id去重，只计model_completed，不再把goal_usage_attribution的别名再加一遍；主调用与后台观察器分别列示并合计。

缓存是输入子集，推理是输出子集。价格按API刊例：Standard输入/缓存/输出=$1.25/$0.15/$4.25；Contributor=$0.10/$0.002/$0.20，每百万tokens。计算(输入-缓存)×输入价+缓存×缓存价+输出×输出价，无长上下文附加费。估价不是订阅实付。

仅保留计数和技术ID，临时会话原文在提取后删除。未报告调用不填零；旧版关闭会话落盘的历史请求无法补全。Contributor允许Meta用内容训练，保持独立可选，不改默认模型。CLI目录列出max，本次Contributor max短请求成功；这与API Models页面“max仅Standard”的描述存在差异，接入记录以实测CLI能力为准。

## 验收

- 13项网关/用量回归通过：缓存/推理不双计、主/后台归属、镜像日志去重、逐模型价格、输入被压缩后拒绝、HTTP/SSE、队列、取消和权限边界。
- 两模型真实HTTP请求返回非零计数：Standard合计26,284，Contributor合计23,592（本轮小样本，非固定开销）。
- HTML使用真实服务+浏览器验收：3个页签、按请求去重、刊例估价、未知用量覆盖、模型筛选、重置、跟随、下载、清空及后续SSE恢复均通过，页面无JS错误。
- 本轮只测合成数据，不将私人会话用于Contributor验收。

证据保存在本机workspace/temp/muse-usage-context-20260922；原始会话和合成输入不提交仓库。

来源：
- https://dev.meta.ai/docs/models.md
- https://dev.meta.ai/docs/pricing-rate-limits.md
- https://dev.meta.ai/docs/prompt-caching.md
- https://dev.meta.ai/docs/token-counting.md
