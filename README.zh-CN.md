# dsh-hindsight-bridge

把 Hindsight 接入 DeepSeek Harness 的独立 Cordis 插件：每轮自动召回，正常回复后自动保存。无需模型主动调用 MCP，也不修改 DSH 源码。

## 环境要求

- DeepSeek Harness `0.2.0-rc.2`，Node `^22.19.0 || >=24`。
- 可访问的 Hindsight `0.10` API。API Key 必须是 Dataplane Key，不是管理面板 Access Key。
- 在真正使用的 DSH profile 中安装；不要同时启用两个自动记忆插件。

开发依据当前官方源码，运行测试使用明确固定版本的官方 npm 包。部分 DSH 子包的 `latest` 标签很旧，不能把不带版本安装当成最新版。

## 安装

下载附件中的 npm 安装包后，在包所在目录执行：

```sh
dsh plugin --profile web add ./dsh-hindsight-bridge-1.0.0.tgz
```

本包尚未发布到 npm，不能只用包名安装。Desktop 使用其内置 DSH CLI 和 `desktop` profile。安装后由用户择时重启对应 DSH 应用；插件不会自动重启线上服务，也不会改动记忆服务。

设置中提供 Hindsight 配置页。主要填写 API 地址、Bank ID，选择自动召回和自动保存。密钥输入框使用密码模式，不回显服务器中的旧密钥；留空表示不更改旧密钥。

密钥更推荐通过宿主进程环境变量提供：`apiKeyEnv: HINDSIGHT_API_KEY`。必须让运行 DSH 的进程继承该变量。也可在插件页输入 API Key，DSH 会持久化到本地配置；secret 标记只做脱敏，不是加密保存。

profile 的 `cordis.patch.yml` 配置示例：

```yaml
- id: hindsight-memory
  config:
    apiUrl: https://memory.example.com
    apiKeyEnv: HINDSIGHT_API_KEY
    bankId: deepseek-harness
    autoRecall: true
    autoRetain: true
```

API 地址填写 HTTPS 根地址，不加 `/v1` 或 `/mcp/...`，不要填写管理 UI 地址。

## 是否共享 Hermes 的记忆

- `deepseek-harness`：DSH 独立记忆库，默认选择。
- `hermes-default`：与 Hermes 共享已有记忆。DSH 可以读取并追加该库；只在确实愿意跨客户端共享聊天信息时选择。

如旧库主要是原始事实而没有整理后的观察，可将 `recallTypes` 设置为 `[observation, world, experience]`。默认只召回 observation。

## 读写规则与安全

1. 每轮的首次模型请求前，按真实用户问题召回一次；记忆作为带来源标签的 user-role 上下文写入会话日志。工具循环不反复召回，不改系统提示词与已有消息。
2. 只保存已提交的真人消息和成功回复的最终正文。不默认保存推理、工具参数、插件注入、历史重放、压缩替换、失败或中断轮次。
3. 每轮使用独立、稳定文档 ID，避免 Hindsight 默认 replace 覆盖前一轮。
4. 写入在后台执行。服务器返回 operation ID 时继续检查其状态；只有完成后才记录 completed，接收请求不等于完成保存。
5. session/flush 和卸载会有界等待后台写入。队列满、网络故障、强制退出可能丢失未完成工作；本版不是持久离线队列，不会盲目重试 POST。
6. 拒绝 HTTP 重定向；仅 HTTPS 或本机 loopback HTTP。认证不会随重定向发往其他站点；接口错误不打印密钥或私密正文。
7. 默认启用常见密钥、Bearer、密码和私钥格式脱敏，但不能保证识别任意自然语言中的敏感内容。
8. 默认排除子会话。需要保存子 Agent 内容时才明确开启 `includeSubagents`。

设置保存走当前 DSH ConfigForms 的原子修改和版本校验。保存失败或被拒绝时保留草稿；发生版本冲突时可显式放弃草稿并加载当前配置，不会静默覆盖其他修改。设置动态变化应用于下一次记忆操作，不改已经提交给服务器的操作目标。

## 验证

```sh
npm ci
npm test
npm run check
dsh --profile web --dump-config
```

自动化测试使用真实本地 HTTP 服务、官方 Cordis Loader 和 DSH AgentLoop；模型适配器及 Hindsight 响应是明确标识的本地测试夹具，不是线上结果。线上验收首先只读检查接口和召回，再用真实用户对话检查 retain/consolidation 完成记录；不要把虚构偏好写进生产记忆库。

## 卸载

```sh
dsh plugin --profile web remove dsh-hindsight-bridge
```

卸载不删除 Hindsight 已存记忆。不要同时保留旧自动记忆插件与新插件，否则会产生重复请求。
