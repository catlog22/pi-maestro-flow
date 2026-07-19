# Release v0.4.11 — 2026-07-19

## 概述

v0.4.11 将 Pi 的 Session/Run 入口完整对齐到 Maestro Flow 0.5.52：支持 `session/1.2`、`command-run/1.2` 与 `run-response/1.0`，区分只读 recall 和需要 confirmation token 的 mutation，并让 Pi skill 在执行前读取下一命令的 args、requirements、已解析输入与缺失输入。本版本只发布 `pi-maestro-flow`，`pi-maestro-teammate` 继续保持 0.4.5。

## 详细变更

### Session/Run 1.2

- 将 Pi `maestro`、`maestro-ralph` 与 `maestro-next` skill 对齐到 `session/1.2` 和 `command-run/1.2`。
- `run complete` 后消费 Maestro 返回的 `run-response/1.0` 与 `next_action`，使用简要 command/skill 信息继续执行，而不是依赖冗长自由文本。
- 下一 Run 的 birth packet 透出 command args、requirements、resolved inputs 和 missing inputs，便于 LLM 在派发前识别所需上下文。
- exact live resume 使用 Unicode-safe intent identity；历史近似 Session 仅作为 `automatic=false` 的 advisory recall，不自动恢复。

### Recall 与 Plan mode 权限

- Plan mode 允许只读 `recall`、skill discovery 和状态查询。
- `recall-confirm`、`fork`、`import`、`new`、`rebind`、`resolve`、`resume` 被视为 mutating 操作，必须经过正常确认边界。
- historical recall 的 fork/import/new 必须使用 Maestro 返回的 confirmation token，防止过期、重复消费或跨 Session 误用。

### 执行契约与文档

- 更新 `AGENTS.md` 的 execution contract，明确 machine payload 是权威接口，display 文本只用于人类阅读。
- Pi canonical skill 源继续位于 `.pi/skills`，打包时由 `prepare-package-skills.mjs` 复制到 npm package。
- Maestro runtime 依赖从 `0.5.51` 精确升级到 `0.5.52`，确保 Pi 与 CLI schema/response 同步。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.10 | 0.4.11 |
| `pi-maestro-teammate` | 0.4.5 | 0.4.5 |
| `maestro-flow` 运行依赖 | 0.5.51 | 0.5.52 |

## 验证

- Plan mode lifecycle tests：61 项通过。
- Session/Run tests：46 项通过。
- Permission tests：31 项通过。
- Package resource tests：6 项通过。
- TypeScript `check:types` 通过。
- npm publish dry-run 验证 package resources、canonical Pi skills 与 `maestro-flow@0.5.52` 依赖。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.11
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.11
```

## 升级说明

升级后执行 `/reload` 或重启 Pi。消费 Session/Run 返回值的自定义逻辑应优先读取 `run-response/1.0` machine payload；历史相似 Session 不再自动 resume，需要按 recall 建议显式确认 fork/import/new。

**Full Changelog**: https://github.com/catlog22/pi-maestro-flow/compare/v0.4.10...v0.4.11
