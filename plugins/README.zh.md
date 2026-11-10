# plugins/ — 本 fork 自带的 DSH 插件

这里放的是**不属于 upstream pnpm workspace** 的本地插件（根 `pnpm-workspace.yaml` 只收
`packages/*`，所以这个目录不进构建与 CI），用来承载本 fork 自己的 Harness 侧改动。
从 upstream 同步时它是纯新增，不会冲突。

## dsh-session-delete

给桌面端会话记录补上**真正的「删除会话」**：官方面板只有「归档」（只隐藏，日志仍在磁盘）。

- 侧栏会话行 `⋮` 菜单 → 红色「🗑 删除会话」，排在「归档会话」之后；
- 会话正在跑一轮 → 显示「删除会话（正在运行）」并禁用；
  该对话正在主视图打开 → 显示「删除会话（对话已打开）」并禁用；
- 确认后永久删除：会话日志目录、工作区成员关系、宿主内存条目，以及
  `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` 这条投影缓存残影；
- 失败时把宿主给的原因弹出来（例如「会话正在运行，请先停止再删除」）。

实现：Host 半边在 `webServer` 上注册 `POST /api-ext/session.delete`（仅本机回环调用、拒绝跨站
`Origin`，且只在 `sessions/<project>/<sessionId>` 这一层动手）；Client 半边用官方菜单贡献 API
`ctx.contextMenus.register({ target: 'session' })` 与 `contextMenu.icon` 槽，所以外观、关闭行为、
键盘可达性都和内置项一致。

安装、验证与边界见 [`dsh-session-delete/README.zh.md`](dsh-session-delete/README.zh.md)。

## 手机 DSH Go 经中继的「永久删除」

手机 DSH Go 走 **DSH Remote（中继）** 时，「永久删除」显示「此主机不支持安全永久删除」。
判定发生在手机端，且中继通道没有删除入口：

- `dsh_client` 的 `SessionDeletionApi.supportsSessionDeletion()`
  （`packages/dsh_client/lib/src/session_deletion_api.dart`）第一句是
  `if (transport is! DshHttpCarrier) return false;`；中继用的 `RemoteTunnelCarrier`
  不是 `DshHttpCarrier`，于是在发出任何请求之前就返回 false；
- 中继的 RPC 两端各有一张**硬编码白名单**（App 侧
  `packages/dsh_remote/lib/src/carrier/tunnel_carrier.dart` 的 `harnessRemoteAllowlist`；
  主机侧 `ds-harness-remote` 的 `HARNESS_REMOTE_ALLOWLIST`），其中没有删除端点，
  客户端 `call()` 会在本地直接拒绝。

**已打通（2026-11-10）**，三处配合：

1. 本插件把删除能力公布为进程级钩子 `globalThis.__dshSessionDeletion`（转发到上面的
   本机回环路由，两个调用方共用同一条删除路径）；
2. 中继插件 `ds-harness-remote` 的白名单放行 `session/deletion` / `session/delete`，并在
   调用 Gateway 之前用这个钩子作答（补丁分支：`Kovisun/ds-harness-remote`，
   `feat(bridge): carry permanent session deletion to a local Host plugin`）；
3. 手机端 `dsh_client` 新增可选能力 `SessionDeletionCarrier`，由 `dsh_remote` 的
   `RemoteTunnelCarrier` 实现（补丁：`Kovisun/dsh-Go`，
   `feat(remote): permanent session deletion over the relay`）。

没有第 2 项的主机会继续回答 `supported: false`，即退回「不支持、可用归档」，不会报错。
