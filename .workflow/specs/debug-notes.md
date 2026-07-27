---
title: "Debug Notes"
readMode: optional
priority: medium
category: debug
keywords:
  - debug
  - issue
  - workaround
  - root-cause
  - gotcha
---

# Debug Notes

## Entries



<spec-entry category="debug" keywords="plan,manifest,approval,transaction-lock,recovery,concurrency" date="2026-07-11" sid="S-20260711-5vq1" title="Pi Plan Mode — 持久化恢复必须验证 invariant 与锁所有权" description="Plan 持久化恢复和跨进程锁的 fail-closed 工程规则" source="planex:plan-mode-lifecycle">

### Pi Plan Mode — 持久化恢复必须验证 invariant 与锁所有权

PlanStore 在清理 approval archive 前必须严格验证 manifest 的 revision、status、checksum、approvals path 和 archive filename invariant；任何结构性损坏必须进入 archive-based rebuild，禁止把合法历史当 orphan 删除。跨进程事务锁必须具有 owner token、heartbeat 和 owner-checked release；仅依赖目录 mtime 的 stale takeover 会在长事务中破坏锁所有权并删除 in-flight archive。应使用可注入时钟与阈值覆盖 damaged manifest、stale takeover、旧 owner release 和 clock rollback。

</spec-entry>

<spec-entry category="debug" keywords="teammate turn_end agent_end lifecyclepending" date="2026-07-23" sid="S-20260723-ie6b" title="Teammate 结果发布与生命周期确认必须解耦" description="避免 teammate 已产出结果却因等待 agent_end 阻塞并行聚合" source="master@a67f2b52">

### Teammate 结果发布与生命周期确认必须解耦

严格 final turn_end 只发布可消费结果并标记 lifecyclePending，不得 kill 或转 sleeping；agent_end、close、error 才负责清除 resultReadyAt、触发 onTurnComplete 并落定可唤醒生命周期。并行与 DAG 依赖以结果发布为释放边界。

</spec-entry>

<spec-entry category="debug" keywords="teammate background wait watch prompt" date="2026-07-23" sid="S-20260723-1qsb" title="Teammate 异步等待提示约束" description="避免异步 teammate 完成后持续轮询和界面回弹" source="master@945d3f37" confidence="contested" conflict-marker="CMK-20260726-i5ys" conflict-note="末句『result-ready 已可返回结果，不应只为等待 agent_end 继续阻塞』与本轮 REL-8 修复（spec S-20260726-1qz4：result-ready 是边沿通知）存在张力，两侧均可辩护。1qsb 侧：结果可消费即应释放，DAG 依赖以结果发布为边界（另见 debug-notes-002）。1qz4 侧：若 result-ready 按电平读取，该 agent 之后每次 teammate-wait 都立即返回，模型永远观测不到 completed/failed 真实终态。本轮取边沿语义：首次投递后落回终态等待——这恰好使 1qsb 所反对的『为 agent_end 阻塞』在第二次及以后的 wait 上重新可能（而 1qsb 本身已规定只调一次）。留待 knowledge audit 裁定末句是否应收窄为『首次 wait 不应为 agent_end 阻塞』。" conflict-date="2026-07-26">

### Teammate 异步等待提示约束

teammate background acknowledgement 必须引导调用方结束当前 turn 并等待自动 teammate-complete 通知。若当前 turn 必须消费结果，只调用一次带有限 timeout 的 teammate-wait。teammate-watch 和 teammate-list 仅用于一次性检查，不得作为完成轮询机制；result-ready 已可返回结果，不应只为等待 agent_end 继续阻塞。

</spec-entry>

<spec-entry category="debug" keywords="compaction mid-turn file-operations race" date="2026-07-23" sid="S-20260723-rflx" title="Mid-turn 压缩必须与 Pi 原生压缩仲裁" description="避免 mid-turn manual API 与 Pi 原生 auto-compaction 竞态" source="learn:20260723-001-learn">

### Mid-turn 压缩必须与 Pi 原生压缩仲裁

保留基于已完成 file-operation/tool-result checkpoint 的 mid-turn 检测，但不得在 context hook 内与 Pi 原生 threshold/overflow auto-compaction 并发提交。自动 intent 应在 agent settled 后重读 branch 并由单一 owner 提交；自动完成后继续任务，用户手动 /compact 完成后保持 idle。调用前 prepareCompaction 不是互斥锁，必须防止 TOCTOU 导致 Already compacted。

</spec-entry>

<spec-entry category="debug" keywords="compaction,circuit-breaker,reliability,retry" date="2026-07-24" sid="S-20260724-c5w4" title="压缩失败需熔断器防止无限重试" source="master@d8c8ca96">

### 压缩失败需熔断器防止无限重试

mid-turn 自动压缩若持续失败（模型鉴权/summary 过大/provider 错误），不能每轮无限重试浪费 API。应加连续失败计数（MAX=3）+ 冷却退避（5 turns）+ 成功后重置。Claude Code 真实数据：1279 个 session 出现 50+ 连续失败，每天浪费约 250K API 调用。熔断逻辑抽成纯函数(recordCompactionFailure/compactionBreakerAllows)便于单测。

</spec-entry>

<spec-entry category="debug" keywords="result-ready,边沿触发,electrical-level,teammate-wait,resultreadyat,状态派生" date="2026-07-26" sid="S-20260726-1qz4" title="result-ready 是边沿通知，不是电平状态" description="resultReadyAt 是持久标志，但 result-ready 通知必须每目标只投递一次，否则模型永远等不到终态" source="run:20260726-001-odyssey-improve">

### result-ready 是边沿通知，不是电平状态

@
补充 `debug-notes` 的"Teammate 结果发布与生命周期确认必须解耦"（那条管**发布时机**），本条管**通知语义**。

`resultReadyAt` 一旦置位就一直为真。若状态派生把它当电平读（`if (resultReadyAt) return "result-ready"`），则该 agent 之后的每一次 `teammate-wait` 都立即返回 `result-ready`，模型再也**等不到真正的终态**（completed / failed）——表现为"等待立刻返回但工作没做完"，且模型会退化成连续调用 wait。

规则：
- `result-ready` MUST 边沿触发：每个 correlationId 只投递一次，用 `resultReadyNotified: Set<string>` 认领（`claimResultReadyNotice()`）。认领之后同一目标的 wait 落回正常的终态等待。
- 认领 SHOULD 由消费方（状态派生/wait）执行，而不是发布方清除 `resultReadyAt` —— `resultReadyAt` 本身仍要保留给 TUI 展示与生命周期判定。
- 同类判断：凡"某标志置位后所有等待立即返回"的派生，都要问一次它该是边沿还是电平。
@

</spec-entry>

<spec-entry category="debug" keywords="renderresult,rendercall,component,pi-tui,uncaughtexception" date="2026-07-26" sid="S-20260726-bhms" title="工具渲染器必须返回 TUI Component" description="渲染器返回非 Component 会直接崩溃 pi TUI" source="master@e34880f5">

### 工具渲染器必须返回 TUI Component

Pi 宿主 ToolExecutionComponent.updateDisplay() 把 renderCall/renderResult 的返回值直接 addChild 进 pi-tui Box，Box.render() 逐个调用 child.render(width)。宿主只 try/catch 渲染器抛出的异常，返回值类型错误不会被捕获，会逃逸成 uncaughtException 直接杀掉 pi（TypeError: child.render is not a function）。因此渲染器所有分支都必须返回带 render(width): string[] 的 Component（用 singleLine/textBlock/dynamicComponent 等 helper），禁止返回 AgentToolResult 形状的对象、字符串、数组或 Promise。src/extension/index.ts 不在任何 tsconfig 覆盖范围内（运行时靠 --experimental-transform-types 剥类型），类型系统拦不住这类错误，只能靠测试断言 typeof component.render === 'function'。

</spec-entry>

<spec-entry category="debug" keywords="bash_bg,foreground,background,triggerturn,process-exit,stdio" date="2026-07-27" sid="S-20260727-iqhy" title="bash_bg 前后台完成与通知解耦" description="防止已完成后台命令阻塞主流程或重复唤醒" source="master@c39ecb3a" status="deprecated" superseded-by="S-20260727-mhzq">

### bash_bg 前后台完成与通知解耦

bash_bg MUST 对齐 teammate 的前后台语义：action=run 在 foreground 窗口内完成时 MUST 直接返回结果且不得发送 triggerTurn completion；action=start 或 action=run 超时转入 background 后 MUST 先返回 acknowledgement，再于完成时发送且只发送一次 bash-bg-complete。shell process exit MUST 作为结果完成边界，stdout/stderr close 仅用于有界输出排空，不得因后代进程继承管道而把已退出任务继续标为 running。

</spec-entry>

<spec-entry category="debug" keywords="bash_bg,triggerturn,deliveras,completion,logpath,expanded" date="2026-07-27" sid="S-20260727-mhzq" title="bash_bg 完成必须即时唤醒并暴露日志" description="防止完成消息在用户下次输入时集中注入，并保证日志可追溯" source="master@d003b4c4" supersedes="S-20260727-iqhy" status="deprecated" superseded-by="S-20260727-75a1">

### bash_bg 完成必须即时唤醒并暴露日志

bash_bg MUST 对齐 teammate 的 foreground/background 契约：action=run 在前台完成时直接返回且不得发送 completion；action=start 或 run 超时后台化后先返回 acknowledgement，完成时使用 triggerTurn=true 立即注入独立 turn，MUST NOT 使用 deliverAs=nextTurn 延迟到用户下次输入。shell exit 是结果完成边界，stdio close 仅做有界排空。所有 job 结果 MUST 返回 logPath 与跨平台 viewCommand；TUI 折叠态显示摘要，展开态显示已返回 tail。

</spec-entry>

<spec-entry category="debug" keywords="bash_bg,truncation,logpath,viewcommand,triggerturn,expanded" date="2026-07-27" sid="S-20260727-75a1" title="bash_bg 日志入口按实际截断显示" description="仅在输出确实截断时暴露日志入口" source="master@5e0ee802" supersedes="S-20260727-mhzq">

### bash_bg 日志入口按实际截断显示

bash_bg MUST 对齐 teammate 的 foreground/background 契约：前台完成直接返回且不发送 completion；后台完成使用 triggerTurn=true 立即注入独立 turn，MUST NOT 使用 deliverAs=nextTurn。shell exit 是完成边界，stdio close 仅做有界排空。run/status/wait 与 bash-bg-complete MUST 通过统一 tail 结果判断截断；仅当行数限制或尾部缓存确实丢弃内容时返回 logPath、viewCommand 并显示 log:/view:，未截断结果及 start/list/kill MUST 保持简洁。TUI 折叠态显示摘要，展开态显示已返回 tail。

</spec-entry>

<spec-entry category="debug" keywords="compaction critical thinking max_tokens fail-closed" date="2026-07-27" sid="S-20260727-7vnv" title="Critical no-op compaction 必须 fail closed" description="防止无可压缩历史透传后构造非法 Anthropic thinking 请求" source="master@9cab2f20">

### Critical no-op compaction 必须 fail closed

当上下文已达 critical 且 prepareCompaction 返回空时，插件 MUST NOT 仅告警后把原消息原样交回 provider。必须区分 already-compacted、missing-id、recent-window empty-summary 与 static prompt overhead；若无法生成更小上下文，应在本地停止请求并给出 context-exhausted 诊断。对启用 Anthropic budget thinking 的请求，发送前必须保证 budget_tokens >= 1024 且严格小于 max_tokens；容量不足时禁用 thinking 或本地失败，禁止用 falsy fallback 把 0 恢复为 1024。

</spec-entry>