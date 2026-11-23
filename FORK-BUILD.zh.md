# 自建桌面版（Kovisun fork）

官方桌面版**没有比 0.2.2-rc.1 更新的公开安装包**：`app-update.yml` 指到的 `download.deepseek.com/dsh-desk/feeds/mac-x64/nightly-mac.yml` 只到 `0.2.1-rc.4`，GitHub releases 也不含二进制。所以本 fork 自己打包发布，升级只从本仓库的 release 手动替换。

## 环境（Intel Mac / darwin-x64）

- Node **24.22.3**（必须带开发头文件 `include/node`，系统里的运行时不带 → 原生模块编译失败）
- pnpm 11.28.5（工程 `packageManager` 固定版本）
- 本机 Python 3.12（打包脚本需要 ≥3.10）
- 代理：`NODE_USE_ENV_PROXY=1`，否则脚本内 `fetch`（下载 Electron）不走 `HTTPS_PROXY`

## 命令

```bash
git clone --depth 1 --branch dsh-v0.2.3-alpha.2 https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
export PATH=/path/to/node-v24.22.3-darwin-x64/bin:$PATH
export HTTPS_PROXY=http://127.0.0.1:2080 HTTP_PROXY=http://127.0.0.1:2080 NODE_USE_ENV_PROXY=1
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm install --frozen-lockfile
pnpm run package:desktop:mac:x64:unsigned
```

产物在 `apps/desktop/.desktop-build/targets/mac-x64/unsigned-artifacts/`：

- `mac/DeepSeek Harness.app`（未签名，ad-hoc）
- `deepseek-harness-<version>-mac-x64-unsigned.dmg`

## 发布到本仓库

1. `ditto -c -k --sequesterRsrc --keepParent "DeepSeek Harness.app" deepseek-harness-<version>-mac-x64.zip`
2. 用 zip 的 `sha512`（base64）和大小写 `nightly-mac.yml`
3. 在 `Kovisun/deepseek-harness` 建 release（tag `dsh-v<version>`），上传 zip、dmg、`nightly-mac.yml`

未签名构建不写 `app-update.yml`，也就是**不会自动更新**，更不会去官方 feed 拿版本；升级＝下载本仓库新 release 后替换 `/Applications/DeepSeek Harness.app`。

## 顺带说明

- 没有自动更新是刻意的：官方 feed 比现有安装还旧，跟随它只会降级。
- 会话删除插件在 `plugins/dsh-session-delete`，装在 `~/.dsh/profiles/desktop`，不打包进 App；换 App 不影响它。
