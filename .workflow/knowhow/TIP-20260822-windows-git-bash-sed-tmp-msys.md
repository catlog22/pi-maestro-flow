---
title: Windows Git Bash 环境高频工具失败模式（sed多表达式、/tmp混淆、MSYS参数转换、控制台乱码）
type: tip
created: 2026-08-22T09:30:43.776Z
---

# Windows Git Bash 环境高频工具失败模式（pi agent 实测）

来源：2026-08-15~08-22 工作空间 84 个会话的错误签名聚合（约 30+ 次同类失败）。

## 坑 1：sed 多表达式/多行脚本在 MSYS sed 下报 `unknown command`

现象：`sed -e expression #1, char 1: unknown command: ','` 一周出现 ~8 次。
原因：LLM 常把多条命令或换行写进单个 `-e`，MSYS sed 对某些分隔/换行组合直接拒绝。
规避：
- 单次只传一个简单表达式；复杂提取改用 `rg -n` + `read` 工具，或 `node -e`。
- 行区间截取优先用内置 read 工具的 offset/limit，不要用 sed。

## 坑 2：/tmp 路径混淆（MSYS /tmp ≠ C:\tmp ≠ %TEMP%）

现象：`cp: cannot stat '/tmp/xxx'`、node 报 `\\tmp\\xxx ENOENT`、同一文件两个工具各写一份。
原因：bash 里 `/tmp` 映射到 `C:\Users\<user>\AppData\Local\Temp`；node/python 的相对/绝对路径解析不走 MSYS 映射。
规避：
- 跨工具传递临时文件时统一放在工作目录下（如 `.workflow/tmp/`），不用 `/tmp`。
- 必须转换时用 `cygpath -w <path>`。

## 坑 3：MSYS 路径转换污染 Windows 原生 CLI 参数

现象：`tasklist /FI` 被转成 `C:/Program Files/Git/FI`；PowerShell 内联 JSON/正则报 ParserError。
规避：
- 调 tasklist/taskkill 等用双斜杠 `//FI` 或前置 `MSYS2_ARG_CONV_EXCL="*"`。
- 复杂 PowerShell 逻辑写成 .ps1 文件再执行，不做 `-Command '...'` 长内联。

## 坑 4：PowerShell/控制台中文输出乱码（GBK 控制台）

现象：错误信息变成 `???Ч??ѡ??`，无法 grep 关键词。
规避：
- 解析前先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；或改用英文 locale 工具（rg/node）获取结构化输出。

## 通用原则

Windows 上做文本处理：**能用 rg/read/edit 内置工具就不要起 shell 管道**；必须 shell 时保持单命令单一职责，避免多段管道拼接近 2000 字符的复合命令。
