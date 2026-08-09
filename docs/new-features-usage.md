# 新特性使用说明 — Vision 委托 · 终端标题 · Mailbox · observe watch

> 覆盖 v0.13.0 之后新增的用户可感知能力。步骤从简，开箱即用。
> 版本范围见 [docs/UPDATES.md](UPDATES.md)。

## 1. Vision 多模态委托（describe_image）

主模型为**纯文本模型**时，图片分析自动委托给多模态模型；切回原生多模态模型后自动改走本地能力。

### 工作原理

- 纯文本模型 + 委托启用 → 自动激活 `describe_image` 工具，并在系统提示中注入使用引导；
- 原生多模态模型 → 工具自动隐藏，直接看图；
- 委托失败按候选模型链回退，结果带缓存（默认 50 条，按图片+提示哈希）。

### 使用步骤

1. 查看状态：`/vision show`
2. （可选）指定首选模型：`/vision model maestro-qwen/qwen3.8-max`
3. 让模型分析图片：`describe_image({ image_path: "截图.png" | URL | data-url, prompt: "分析重点" })`
4. 采信结论前先确认委托已成功（工具内置该约束，成功前不得声称看过图）。

### 常用命令

```
/vision show|status          查看状态
/vision on|off               启用 / 停用
/vision model <ref|auto>     首选模型（provider/model）
/vision fallback <a,b|clear> 回退模型链（逗号分隔，按序回退）
/vision cache on|off|clear   结果缓存
/vision prompt <text|clear>  自定义分析提示
/vision retries <0-10>       每模型最大重试
/vision timeout <ms>         单次请求超时（1000-300000）
```

配置持久化于 `~/.pi/agent/vision-delegation.json`（首次运行自动创建；`maxImageBytes` 默认 20MB，支持 png/jpeg/gif/webp）。

## 2. 终端标题（pi-cockpit）

Claude Code 风格 Tab 标题：`frame + pi - <会话> - <工作状态>`，默认开启。运行中显示 `⠂/⠐` 转轮，空闲显示 `✳`，失败 `✗`，退出时自动清空。

### 使用步骤

1. 确认启用：`~/.pi/agent/cockpit.json` 中 `"title": { "enabled": true }`（默认）；
2. （可选）打开标签：`showModel` / `showThinking` / `showGit` / `showMaestro` / `showCwd`；
3. （可选）LLM 生成标题：

   ```json
   { "title": { "generationModel": "maestro-qwen/qwen3.8-max" } }
   ```

   首个完整回合后由该模型生成 2–4 词标题（10s 超时，`thinking` 关闭控成本）；失败自动回退本地规则提取。

4. 长度上限：`maxLength`（默认 80，范围 20–200）。

标题优先级：`/session name` > LLM 生成 > 规则提取 > 短会话 ID。

## 3. Mailbox 消息队列（pi-maestro-teammate）

持久化、工作区级隔离的消息队列；冷恢复时以 mailbox 为权威源同步，防消息丢失/重复。

- 状态机：staging → ready → claimed → accepted（原子写入 + 幂等回执）；
- Windows 下重命名自动重试，孤儿状态记录由 GC 回收；
- 外部消费者通过 `pi-maestro-teammate/v1/mailbox` 子路径接入（含能力协商）。

普通用户无需配置；属内部集成能力。

## 4. observe watch 与 until=completed

`observe` 三种动作：`status`（快照）、`wait`（屏障等待）、`watch`（持续轮询并记录完整进展直到 deadline）。

```js
// 阻塞等待后台任务到"完全结束"（终态）
observe({ action: "wait", targets: [{ kind: "bash_bg", id: "bg-1" }], until: "completed" })

// 持续观察直到超时，记录每次进展
observe({ action: "watch", targets: [{ kind: "teammate", id: "reviewer" }], timeoutMs: 30000 })
```

- `until`：`"result-ready"`（默认，出结果即返回）或 `"completed"`（终态生命周期）；
- `wait` 的每个 target 必须提供 `name` 或 `waitMs` 之一（schema 强制）。

## 5. self-evolve 自进化（候选信号与受控沉淀）

**是什么**：运行轨迹 → 受治理知识候选的自动化层。启用后监听每轮结束（`agent_end`）与会话压缩（`session_compact`），把可复用经验提炼为候选信号、证据文件和可执行 stage 模板。默认 `dry-run` 只评审不写知识；显式切换 `auto-deposit` 后，也只会在用户主动运行 review 时自动 stage 过门候选，**永不自动 promote**。

**默认禁用**，三种启用方式任一即可：

1. 会话内命令：`/self-evolve on`（写 `.pi/self-evolve.json`）
2. 环境变量：`PI_SELF_EVOLVE=1 pi`（`PI_SELF_EVOLVE=0` 显式关闭，覆盖配置文件）
3. 项目配置：`.pi/self-evolve.json` → `{ "enabled": true }`

**命令速查**：

```
/self-evolve [panel]                    # 打开面板（默认）
/self-evolve status                     # 完整状态（含有效状态与 env 覆盖）
/self-evolve on|off                     # 启用 / 禁用
/self-evolve config [k=v ...|reset]     # 查看 / 修改配置（mode、模型、评审门阈值）
/self-evolve signals [N]                # 最近 N 条候选信号（默认 10）
/self-evolve signals delete <id>|clear|export [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project p]
/self-evolve review [N]                 # 评审最近 N 条；auto-deposit 下过门候选自动 stage
/self-evolve reviews [N]                # 查历史评审记录
/self-evolve deposits [N]               # 查自动沉淀成功/失败审计
```

**输出位置**（全局，不污染项目 git；`SELF_EVOLVE_OUTPUT_DIR` 可覆盖根）：

```
~/.maestro/self-evolve/suggestions/<date>.jsonl   # 候选信号
~/.maestro/self-evolve/reviews/<date>.jsonl       # 评审记录（含评审门统计）
~/.maestro/self-evolve/deposits/<date>.jsonl      # auto-deposit 成功/失败审计
~/.maestro/self-evolve/evidence/<se-id>.md        # 信号证据文件（suggestion 直接引用）
~/.maestro/self-evolve/archive/                   # 旧日文件归档（不删除）
~/.maestro/self-evolve/exports/                   # signals export 导出（signals-<ts>.jsonl）
```

**模式切换**：`/self-evolve config mode=dry-run` 仅评审；`/self-evolve config mode=auto-deposit` 在评审门后调用 `maestro knowledge stage`，候选进入 pending 池。真正晋升仍走 `maestro knowledge review/promote`，必须由用户确认治理处置；自动沉淀不等于自动发布知识。

完整命令、配置、数据目录、health sidecar、canary 与 skill proposal 流程见 [Self-Evolve 自进化指南](../docs-site/src/content/docs/guides/self-evolve.md)。

**相关脚本**：

```
node scripts/self-evolve-health.mjs                            # 健康闭环：health.json + health-<project>.json（revalidation 队列）
node scripts/self-evolve-health.mjs mark|unmark <item-id>      # 队列项已处理标记（health-handled.json）
node scripts/self-evolve-approval.mjs record|query|reconcile   # 晋升审计回执（record/query/reconcile）
node scripts/self-evolve-phase5.mjs canary|proposal|apply|revert  # 在线验证 / skill 演化
```

详见 [self-evolve SKILL](../.pi/skills/self-evolve/SKILL.md) 与 [扩展 README](../packages/pi-maestro-flow/src/self-evolve/README.md)。

## 6. 其他增强

| 能力 | 说明 |
|---|---|
| run-control 所有权 | run 绑定发起它的 Pi session；其他会话只读，防误操作 |
| effort 展示 | 思考强度在界面正确呈现 |
| api-provider ops | `/api-manager` 中 provider 启用/停用、兼容性/请求头编辑 |
| bridge 故障转移 | terminated/timeout 正确分类，回合失败可续跑 |
| 内存边界 | GUI 事件回放限字节、MCP 连接身份租约，防长会话膨胀 |
