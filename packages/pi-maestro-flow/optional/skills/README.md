# Optional Skills（选装技能）

本目录存放**默认不安装**的可选技能。它们保留在仓库中（随版本控制），但不会：

- 出现在默认 `.claude/skills/` 中（默认安装面保持精简）
- 被镜像到 `.codex/skills/`、`.agents/skills/`、`.agy/skills/`、docs-site
- 进入 maestro-help 的默认索引（catalog 中标有 `"optional": true`）

## 当前内容

`scholar-*`（10 个）— 学术研究技能族，覆盖从构思到发表的全流程：

| 技能 | 定位 |
|------|------|
| `scholar-ideation` | 研究构思与文献综述 |
| `scholar-experiment` | 实验结果分析 |
| `scholar-writing` | 端到端论文写作 |
| `scholar-review` | 论文自审与审稿回复 |
| `scholar-rebuttal-pro` | 增强审稿回复（多视角） |
| `scholar-citation-verify` | 引用验证（4 层验证） |
| `scholar-anti-ai-writing` | 去除 AI 写作痕迹 |
| `scholar-latex-organizer` | LaTeX 模板整理 |
| `scholar-publish` | 录用后会议准备 |
| `scholar-thesis-docx` | 学位论文 Word 排版 |

## 安装（启用）方式

`maestro install toggle` 会扫描本目录，将技能以 `available` 状态列出；启用时复制到目标 `.claude/skills/`：

```bash
# 安装指定技能（默认安装到全局 ~/.claude/skills/）
maestro install toggle --enable scholar-writing,scholar-review

# 安装到指定项目
maestro install toggle --path <project-path> --enable scholar-ideation

# 查看所有技能状态（available 即本目录中的选装技能）
maestro install toggle --list
```

## 卸载（停用）方式

```bash
maestro install toggle --disable scholar-writing
```

## 恢复默认（移除选装技能）

删除 `optional/skills/scholar-*` 目录，并同步删除已安装副本与 catalog 条目（`maestro-help/index/catalog.json` 中 `optional: true` 的条目）。

## 维护约定

- 源码以 `.claude/skills/` 同构的目录结构存放（每个技能一个目录，含 `SKILL.md`）。
- 选装技能**不参与** `scripts/build-codex-skills.mjs` / `build-agents-standard.mjs` / `convert-claude-to-agy.mjs` 的镜像构建（它们只读 `.claude/skills/`）。
- 新增选装技能：`git mv .claude/skills/<name> optional/skills/<name>`，并在 catalog 中标记 `"optional": true`、`source` 指向 `../../../../optional/skills/<name>/SKILL.md`。
