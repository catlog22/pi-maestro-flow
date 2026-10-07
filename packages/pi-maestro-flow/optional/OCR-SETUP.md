# OpenCodeReview（ocr CLI）安装（AI 可执行）

本文档面向 AI agent，安装 Alibaba OpenCodeReview 的 `ocr` CLI，供 `open-code-review` 工具与 reviewer agent 使用。

## PURPOSE

安装 `ocr` CLI 并验证可用。

成功标准：
1. `ocr version` 输出版本号（需 ≥ 1.9.0，delegate JSON 输出与 `--output` 依赖该版本线）
2. 在任一 git 仓库中 `ocr delegate preview --format json` 返回含 `schema_version` 与 `reviewable_files` 的 JSON

## PREREQUISITES

- Node.js ≥ 18 与 npm。`ocr` 经 npm 全局分发（`@alibaba-group/open-code-review`），按 os/cpu 自动安装匹配平台的二进制（win32-x64 / linux-x64 / darwin-x64 / darwin-arm64）。
- 网络可访问 npm registry。
- **不需要**配置 OpenCodeReview 侧 LLM provider：pi 调用 `open-code-review` 时通过运行时 model registry 解析 api-manager 当前模型的网关 URL、凭据与 headers，再经 `OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL` / `OCR_LLM_PROTOCOL` / `OCR_LLM_EXTRA_HEADERS` 环境变量注入，换模型即时生效；模型钉选见 `/api-manager open-code-review`。

## TASK

### 1. 检测现有安装

```bash
ocr version
```

- 输出版本号且 ≥ 1.9.0 → 直接跳到 VERIFY。
- 命令不存在或版本过旧 → 继续步骤 2。
- Windows 上 npm 全局安装后若 `ocr` 不可解析，确认 npm global bin 目录（`npm prefix -g`）在 PATH 中并重开终端。

### 2. 全局安装（需用户确认，见 INTERACTIVE INPUTS）

```bash
npm install -g @alibaba-group/open-code-review@1.12.9
```

锁定精确版本；如需更新请先看 release notes 再显式指定新版本号。

### 3. 明确不做的事

- 不写 `~/.opencodereview/config.json`，不运行 `ocr config provider`——模型注入走每次调用的环境变量，持久化 OpenCodeReview provider 反而会与 api-manager 钉选语义冲突。
- 不把 OCR 加为插件 npm 依赖——本项设计为「检测 + 指引」。

## INTERACTIVE INPUTS

- 询问用户是否执行 `npm install -g @alibaba-group/open-code-review@1.12.9`（写入 npm global 目录）。用户拒绝时提示其自行安装后重跑 VERIFY，不要换用未经确认的包管理器或安装路径。

## VERIFY

1. `ocr version` → 输出 `open-code-review v<version>`。
2. 在任一 git 仓库内运行 `ocr delegate preview --format json` → 返回含 `schema_version` 与 `reviewable_files` 数组的 JSON（无 LLM 需求）。
3. 在 pi 会话中调用 `open-code-review` 工具 `action=health`：`version` 必须成功；`llm` 连通性依赖当前 api-manager 模型及运行时网关认证，失败只影响 `review` action，`preview`/`rules` 委派模式仍可用。

## 运行边界（v0.32.0）

`open-code-review` 通过 PATH 选中的安装执行 `ocr`（Windows 优先解析该安装的 native launcher，不另找其他全局版本）。Runner 有硬 timeout、合并 stdout/stderr **10 MiB** 上限、abort 与进程树回收，错误保留有界 stderr 尾部；回收未确认视为错误，不冒充成功。Preview 在过滤前可能构建完整 diff，大仓库可调整工具 `overallTimeoutMinutes`，但不能把超时当作评审通过。这是 OpenCodeReview 代码评审 CLI，和 browser/computer-use 的图像 OCR 无关。

## ROLLBACK

```bash
npm uninstall -g @alibaba-group/open-code-review
```
