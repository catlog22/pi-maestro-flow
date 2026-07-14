---
title: "Coding Conventions"
readMode: required
priority: high
category: coding
keywords:
  - style
  - naming
  - import
  - pattern
  - convention
  - formatting
---

# Coding Conventions

## Formatting

## Naming

## Imports

## Patterns

## Entries



<spec-entry category="coding" keywords="plan,hooks,chain,tool_call" date="2026-07-08" sid="S-20260708-40gp" title="Pi Plan Mode — hook 链式调用模式" source="master@709f5b7">

### Pi Plan Mode — hook 链式调用模式

plan hooks 在 index.ts 中与 goal hooks 链式调用: tool_call 中 plan 先拦截再 goal; before_agent_start 中 plan 先注入 systemPrompt 再传给 goal; agent_end 中 plan 先捕获文本再 goal 异步处理。plan 的 tool_call 返回 block 时直接 return，不再调用 goal。

</spec-entry>

<spec-entry category="coding" keywords="plan,bash,safety,patterns" date="2026-07-08" sid="S-20260708-5489" title="Pi Plan Mode — bash 命令安全过滤" source="master@709f5b7">

### Pi Plan Mode — bash 命令安全过滤

Plan 模式下 bash 工具本身允许（PLAN_ALLOWED_TOOLS），但通过 MUTATING_BASH_PATTERNS 和 SAFE_BASH_PATTERNS 双重 pattern 过滤具体命令。先检查是否匹配 mutating pattern（阻止），再检查是否匹配 safe pattern（放行），不匹配任何 pattern 默认阻止。参考 pi-extensions/pi-plan-mode 的 isSafeCommand 模式。

</spec-entry>

<spec-entry category="coding" keywords="todo,state-version,migration,contract-test" date="2026-07-10" sid="S-20260710-wz12" title="持久化 todo contract 的版本化迁移模式" description="通过版本化 read-boundary normalization 防止持久化任务字段漂移" source="planex-odyssey">

### 持久化 todo contract 的版本化迁移模式

Todo public schema 与 runtime model MUST 共享单一 canonical contract。持久化 shape 变化时 MUST 写入 state version，并在 read boundary 将 legacy inject/injection/load/completion 归一化为新模型；update MUST 区分 omitted、empty 与 null，且 focused tests MUST 覆盖 preserve、replace、clear 和 legacy migration。

</spec-entry>

<spec-entry category="coding" keywords="plan,approval,manifest,pending,lock,heartbeat,quarantine,transaction" date="2026-07-11" sid="S-20260711-zekz" title="Pi Plan Mode — Durable approval transaction pattern" description="可复用的 Plan 持久化批准事务与 lease lock 模式" source="planex:plan-mode-lifecycle">

### Pi Plan Mode — Durable approval transaction pattern

Durable Plan approval uses four ordered boundaries: save the exact draft under revision CAS; write an approval.pending.json marker; atomically write the immutable archive; commit manifest.json last. Before manifest commit, failure may remove the pending archive. After manifest commit, cleanup is best-effort and must never roll back committed history. Recovery strictly validates the complete manifest and archive checksum/path invariant, quarantines interrupted or invalid pending transactions, and rebuilds history by revision rather than timestamp. Cross-process workspace mutation uses owner token, PID/liveness, heartbeat, token-specific stale takeover, ownership checks before mutation and owner-only release.

</spec-entry>

<spec-entry category="coding" keywords="tui input paste visiblewidth width-matrix" date="2026-07-14" sid="S-20260714-t5qv" title="TUI Paste 输入与可见宽度矩阵" description="终端输入和宽度测试的可复用实现规则" source="master@4d76db9">

### TUI Paste 输入与可见宽度矩阵

自由文本 TUI 输入 MUST 接受 printable multi-character 与 paste，不得仅处理 data.length===1。宽度验证 MUST 使用 visibleWidth 而非字符串 length，并覆盖 1..120 列的 runtime matrix。

</spec-entry>

<spec-entry category="coding" keywords="thinking-depth routing-migration cli-boundary task-normalization teammate" date="2026-07-14" sid="S-20260714-1g63" title="Teammate thinking depth 全链路参数模式" description="Teammate thinking 参数跨 schema、routing、frontmatter、normalization 和 CLI 的统一优先级与迁移规则" source="odyssey-planex:20260714-002-odyssey-planex">

### Teammate thinking depth 全链路参数模式

Teammate 的多层运行参数必须复用单一 canonical enum，并在 tool schema、task normalization、taskType routing、agent frontmatter 与 child CLI boundary 保持同一类型。thinking 优先级固定为 per-task > top-level > taskType mapping > agent frontmatter > Pi default；CLI 仅在解析到值时从单一位置追加一次 --thinking。持久化 routing shape 升级时使用新 version 并将 thinkingLevels 与 model mappings 独立保存，读取边界兼容旧 string/null mappings，测试必须覆盖无损迁移、inherit null、保存失败重试、root/proxy 与 tasks/chain 传播。

</spec-entry>

<spec-entry category="coding" keywords="generation owner-identity single-flight lifecycle late-cleanup" date="2026-07-14" sid="S-20260714-hkwb" title="Generation-owned async resource cache" description="异步资源缓存使用 generation 与 owner identity 防止 shutdown/restart 后旧回调污染新代状态" source="planex:20260714-001-odyssey-planex">

### Generation-owned async resource cache

缓存 Promise 或可复用进程、浏览器资源时，创建方必须携带 generation 或 owner identity。then、catch、close callback 写共享 map 前必须确认仍持有当前 key；shutdown 顺序固定为 fencing 旧 lifecycle、清理可见 registry、取消并等待 in-flight work、回收 late resource。相同 key 的并发创建使用 single-flight reservation，旧代完成不得删除或覆盖新代资源。

</spec-entry>

<spec-entry category="coding" keywords="workspace-edit transaction multi-provider rollback rename" date="2026-07-14" sid="S-20260714-jboa" title="Collect-validate-commit workspace transaction" description="多 provider WorkspaceEdit 先收集校验，再与文件操作一次原子提交" source="planex:20260714-001-odyssey-planex">

### Collect-validate-commit workspace transaction

当多个 Language Server 或 provider 为一次文件操作返回 WorkspaceEdit 时，必须先收集全部响应，拒绝除明确 MethodNotFound 之外的错误，统一校验 URI、range、workspace 边界和操作顺序，再把引用编辑与最终 file rename 作为一次可回滚事务提交。禁止逐 provider 边请求边写入，以免后续失败留下部分修改。

</spec-entry>