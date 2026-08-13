# Phase 2: Search & Present

查询 catalog.json 并格式化呈现结果。覆盖 Mode 1/2/3/6/7。

## Objective

- 根据 Phase 1 输出的 mode 和 query 搜索 catalog
- 读取 source 文件获取详情（Mode 2）
- 检测项目状态提供智能推荐（Mode 3）
- 格式化呈现搜索结果

## Execution

### Mode 1: Command Search

```
1. Read catalog.json
2. Search commands[] + cli_commands[]:
   - Filter by: name contains query (case-insensitive)
   - OR: description contains query
   - OR: category matches query
3. Sort by relevance (exact name match > starts with > contains)
4. Present top 5 results:
```

**输出格式**:

```markdown
找到 {N} 个匹配命令：

**/{command-name}** — {description}
  分类: {category} | 详细: {source file exists? → "查看详情 →" : "catalog only"}

**/{command-name-2}** — {description}
  ...
```

### Mode 2: Command Documentation

```
1. Locate command in catalog.json commands[] by name
2. Read the source file (e.g., "../../commands/maestro-ralph.md"; steps resolve to "~/.maestro/workflows/<step>.md")
3. Extract key sections:
   - <purpose> content
   - argument-hint
   - usage examples from <context>
4. If a guide file references this command, read relevant section
5. Present structured documentation:
```

**输出格式**:

```markdown
## /{command-name}

**用途**: {description}

**参数**: {argument-hint}

**用法**:
{extracted examples or usage patterns}

**分类**: {category}

**相关 Guide**: {guide file name if applicable}
```

**Guide 映射**:

| 命令 | Guide 文档 | 状态 |
|------|-----------|------|
| analyze/plan/execute (steps) | `guide/command-usage-guide.md` (主干管线) | planned |
| maestro-init + roadmap/blueprint (steps) | `guide/quick-start-guide.md` | planned |
| maestro-ralph | `guide/maestro-ralph-guide.md` | planned |
| maestro (协调器) | `guide/maestro-coordinator-guide.md` | planned |
| /maestro-issue · /maestro-knowledge · /maestro-knowhow | `guide/command-usage-guide.md` (管理) | planned |
| review/test/auto-test/debug (steps) | `guide/command-usage-guide.md` (质量) | planned |
| delegate | `guide/delegate-async-guide.md` | planned |
| overlay/amend | `guide/overlay-guide.md` | planned |

> **注意**: Guide 文档目前尚未创建（标记为 planned），命令详情回退到 catalog 描述和 source 文件。

### Mode 3: Smart Recommendations

```
1. Detect project state from Phase 1
2. Match state to workflow template from catalog.workflows
3. Present recommendations with WHY:
```

**状态 → 推荐映射**:

| 当前状态 | 推荐命令 | 原因 |
|---------|---------|------|
| 无 .workflow/ 且有源码 | `/maestro-init` | 项目未初始化，需要先创建工作区 |
| 无 .workflow/ 且无源码 | step `brainstorm` | 先发散探索再规划 |
| 已初始化，无 roadmap 无 session | step `analyze` | 宏观分析，产出 scope_verdict |
| 宏观 analyze 完成，scope_verdict=large | step `roadmap --from analyze:ANL-xxx` | 大范围需求，需要 session DAG 分解 |
| 宏观 analyze 完成，scope_verdict=medium/small | step `plan --from analyze:ANL-xxx` | 跳过 roadmap，直接规划 |
| 有 roadmap，dep-ready session 未启动 | step `analyze --session {slug}` | Session 级深入探索 |
| session analyze 完成 | step `plan --session {slug}` | Session 级规划 |
| plan 完成 | step `execute --session {slug}` | 规划完成，开始执行 |
| execute 完成 | step `review --session {slug}` | 执行完成，进入质量管线 |
| review PASS | step `auto-test --session {slug}` | 补足测试覆盖 |
| tests 全绿 + active session | `/maestro-session-seal` | 封印 session：知识提取 + DAG 推进 |
| 所有 session sealed | step `roadmap` | DAG 完结，规划下一批 sessions |

### Mode 6: Skill & Agent Browsing

**Skills**:
```
1. Read catalog.json skills[]
2. If category specified: filter by category
3. Group by category: meta / team / knowledge
4. Present:
```

```markdown
## Skills ({total} 个)

### Meta (5)
- **workflow-skill-designer** — 设计 orchestrator+phases 工作流 skill
- **skill-iter-tune** — 迭代 execute-evaluate-improve 调优
- **skill-generator** — 创建新 skill（sequential/autonomous 模式）
- **skill-simplify** — SKILL.md 简化与功能完整性验证
- **skill-tuning** — 通用 skill 诊断和优化

### Team (8)
- **team-arch-opt** — 架构优化
- **team-coordinate** — 通用团队协调，动态生成 role-specs
- **team-issue** — Issue 解决
- **team-lifecycle-v4** — 完整生命周期流水线
- **team-perf-opt** — 性能优化
- **team-review** — 多维度代码审查
- **team-swarm** — 群智能（ACO + Python 控制器）
- **team-testing** — 渐进式测试覆盖

### Scholar (10, 选装 optional)
- **scholar-writing** — 端到端学术论文写作
- **scholar-review** — 学术论文审查（自审 + 回复）
- **scholar-rebuttal-pro** — 审稿回复（证据策略）
- **scholar-ideation** — 研究构思
- **scholar-experiment** — 实验结果分析
- **scholar-citation-verify** — 四层引用验证
- **scholar-anti-ai-writing** — 去除 AI 写作痕迹
- **scholar-latex-organizer** — LaTeX 模板整理
- **scholar-publish** — 会议发表准备
- **scholar-thesis-docx** — 学位论文 Word 文档
```

**Agents**:
```
1. Read catalog.json agents[]
2. Group by category: workflow / team / planning / cli / ui
3. Present with category headers
```

### Mode 7: CLI Command Reference

```
1. Read catalog.json cli_commands[]
2. Group by category: setup / dashboard / execution / knowledge / config / team / visualization
3. Present table with command, alias, description:
```

```markdown
## CLI 终端命令 (21 个)

### 安装与更新 (setup)
| 命令 | 别名 | 用途 |
|------|------|------|
| `maestro install` | — | 安装 Maestro 资源 |
| `maestro uninstall` | — | 卸载已安装资源 |
| `maestro update` | — | 检查/安装最新版本 |
| `maestro launcher` | — | Claude Code 启动器 |

### 任务执行 (execution)
| 命令 | 别名 | 用途 |
|------|------|------|
| `teammate` | — | 委派任务给 AI 智能体 |
| `maestro coordinate` | `coord` | 图工作流协调器 |
| `maestro cli` | — | 运行 CLI 智能体工具 |
| `maestro run` | — | 执行指定工作流 |
| `maestro serve` | — | 启动工作流服务器 |
...
```

## Error Handling

| 场景 | 处理 |
|------|------|
| 搜索无结果 | 模糊匹配最近命令，建议使用 `/maestro-help` 查看全部 |
| Source 文件不存在 | 仅提供 catalog 描述，标注 "详细信息不可用" |
| Catalog 读取失败 | 回退到 Glob 扫描 .claude/commands/*.md |

## Output

格式化的搜索/文档/推荐结果，直接展示给用户。
