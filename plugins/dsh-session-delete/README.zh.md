# dsh-session-delete

给 DeepSeek Harness 的会话记录补上**真正的「删除会话」**——官方面板只有「归档」，
归档只是隐藏，日志还在磁盘上。

## 你会得到什么

侧边栏每个会话行 → `⋮` 菜单 → **删除会话**（红色，在「归档会话」下方）。

- 会话正在跑一轮 → 菜单项显示「删除会话（正在运行）」并禁用；
- 该对话正在主视图打开 → 显示「删除会话（对话已打开）」并禁用（先关掉再删）；
- 点击后弹一次确认，确认后永久删除：会话日志目录、工作区成员关系、宿主内存里的会话条目。
- 删除失败时弹出宿主给的具体原因（例如「会话正在运行，请先停止再删除」）。

## 实现

| 半边 | 文件 | 做法 |
| --- | --- | --- |
| Host | `index.js` | 在 `webServer` 上注册 `POST /api-ext/session.delete`，body `{ "sessionId": "session-..." }` |
| Client | `client.js` | 用官方菜单贡献 API `ctx.contextMenus.register({ target: 'session' })` 加菜单项 |

Host 删除顺序：拒绝运行中的会话 → 卸载空闲 agent 的 fiber（先让它自己的持久化写入端有序关闭）
→ 从 live `SessionStore` 摘除条目 → 从各工作区记录 `detachSession` → 删除
`$DSH_HOME/sessions/<project>/<sessionId>` 目录。

只在 `sessions/<project>/<sessionId>` 这一层动手（`basename` 与父目录都校验），
并且只接受**本机回环**调用、拒绝跨站 `Origin`——即使 webServer 绑到 LAN 或用远端通道访问，
这条路由也不会被外机命中（代价：用远端 Web 访问时该菜单项会报权限错误，本机不受影响）。

## 安装（本地包目录）

```sh
# 用 DSH 自带运行时里的 pnpm：
PROFILE=~/.dsh/profiles/desktop
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
PNPM=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs

# 1) 声明依赖 + 让这个 bundle 进入 profile 组合
#    package.json: dependencies["dsh-session-delete"] = "file:<本目录>"
#                  dsh.profile.bundles 追加 "dsh-session-delete"
# 2) 安装
cd "$PROFILE" && "$NODE" "$PNPM" install
```

装完**重启宿主**（退出并重开 DeepSeek Harness），运行中的实例不会热加载新的 Host bundle。

## 直接用 HTTP（调试）

```sh
curl -sS -X POST http://127.0.0.1:<port>/api-ext/session.delete \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}'
# {"ok":true,"value":{"detached":true,"agentDisposed":false,"workspaces":1,"files":1}}
```

## 边界

- 不碰子会话：删父会话不会连带删它的 subagent 会话日志。
- 菜单项带自绘垃圾桶图标（注册在 `contextMenu.icon` 槽的 `session-delete.trash` 键上），与内置线性图标同一套视觉。
- 删除同时抹掉投影缓存行 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`，不留残影。
- 只作用于本机宿主（远端 peer 的会话不在此列）。
- **手机 DSH Go**：它的「永久删除」只认 HTTP 通道（`DshHttpCarrier`）。走 **DSH Remote（中继/P2P）** 时手机端在发请求之前就直接判定「此主机不支持安全永久删除」，所以只改 Mac 端无法让它变可用；详见下文。

## 手机端 DSH Go 的「永久删除」

DSH Go 的判定发生在手机端：`packages/dsh_client/lib/src/session_deletion_api.dart` →
`supportsSessionDeletion()` 里 `if (transport is! DshHttpCarrier) return false;`。
远程中继的 `RemoteTunnelCarrier` 不是 `DshHttpCarrier`，于是直接返回 false，**根本不会访问 Mac**。
因此走中继时，Mac 端加任何路由都不会生效。

两条可行路径：

1. **手机端补一条通道**（正解）：给 carrier 加一个可选能力接口（照 `RemoteTunnelCarrier implements WorkspaceUploadCarrier` 的写法），
   手机端判定改为「carrier 支持就询问」，同时在 Mac 的 `ds-harness-remote` 插件里加一个对应 RPC 转发到本插件的删除实现。
2. **改走 HTTP 直连**（SSH / 局域网）：手机端会去读 `GET /dsh-go/v1/sessions/deletion`；
   本插件没有实现这两个 DSH Go 专属路由（它们需要把删除能力暴露给非回环调用者，安全边界与桌面 UI 那条不同，需另行开启）。

今天的替代流程：在手机上「归档」，再到 Mac 的会话菜单里「删除会话」彻底删掉。

## 许可

MIT。
