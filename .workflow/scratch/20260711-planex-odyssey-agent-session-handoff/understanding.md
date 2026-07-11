# Agent Session Handoff Planex

## 1. Requirement & Criteria

实现单 owner teammate Agent session 接管原型：子 Agent 自然完成当前 prompt loop 后 parked，主 Pi 使用真实 session switch 接管；切回时子 runtime reload 后恢复 ownership。

验收标准：session identity 持久化、完整 loop barrier、真实 switchSession、epoch/nonce fencing、idle prompt 唤醒、崩溃恢复、完整回归与外部验证。

## 2. Plan

1. 建立 ownership lease 状态机与 fencing。
2. 子进程发布 session identity，父进程保存 IPC control。
3. 实现完整 loop 后 park、idle prompt 唤醒和异常 recovery。
4. 使用 command context 的 switchSession 实现主内容替换与 handback reload。
5. 补齐回归测试、外部验证和审查。

## 3. Execution

- 新增 immutable session lease 状态机、epoch/nonce token envelope 与 stale writer 校验。
- child 通过 IPC 发布 session identity，并在输入边界校验 lease token。
- handoff 使用 requiredPromptSeq + isIdle barrier，超时发送 nonce-scoped cancel。
- root 使用全局 registry 跨 switchSession 保留 child handles。
- `/teammate-session` 真实调用 switchSession；Alt+R 路由到该 command。
- handback 使用 reload command，并校验 nonce、sessionId 和 sessionFile。
- focused tests 当前 12/12 通过。

## 4. Verification

| Criterion | Result | Evidence |
|---|---|---|
| AC1 | passed | session identity IPC + canonical path gate |
| AC2 | passed | prompt completion sequence + stable idle + parked input fence |
| AC3 | passed | native switchSession helper test and final Codex gate |
| AC4 | passed | epoch/nonce envelope + reload identity validation |
| AC5 | passed | idle uses prompt in root, overlay and proxy paths |
| AC6 | passed | cancel/recover transaction and ordering test |
| AC7 | passed | 14/14 tests, diff check, no P0/P1 blocker |

## 5. Fix Log

### Iteration 1

- 将 lease token envelope 接入 child input 与所有 root/proxy send 边界。
- 增加 requiredPromptSeq、agent_end completion 与稳定 idle barrier，消除 prompt 尚未消费时提前 parked。
- handoff timeout 发送 nonce-scoped cancel，ack 按 nonce + fenced epoch 恢复。
- handback returned 校验 nonce、sessionId、sessionFile。
- owner/fence 变化同步发布 child expected lease。
- child lifecycle event 绑定实际 child correlationId；sessionFile 必须 realpath 位于 canonical sessionDir。
- 修复 owner gate/promptSeq 误入 watchTool 的回归。

### Iteration 2

- 修复 proxyCall 在发送 IPC 后才登记 pending request 的竞态。
- handback timeout 现在进入 nonce-scoped cancel/recover，而非永久 fenced。
- 生产路径复用 canChildWrite、handoffBarrierReached、isSessionPathContained gate。
- 增加真实 switchSession helper 的可执行 mock test，以及 canonical session containment test。
- focused tests 提升至 14/14。

### Iteration 3

- 修复 handback timeout 中 cancel 与 lease_update 的 nonce 覆盖顺序。
- 抽取 buildFenceRecoveryMessages，并以测试锁定 cancel 必须先于 token update。
- focused tests 保持 14/14。

## 6. Generalization

提取 P1：跨进程 session ownership transfer 必须采用单 writer lease、prompt completion barrier、epoch/nonce fencing、ordered cancel recovery 与 reload handback。

4 角度扫描均已尝试：syntax、semantic 完成；structural、historical 因 worker timeout 降级，但本地主流程与两轮 Codex gate 已覆盖关键结构。

## 7. Discoveries

- Bug：handoff request 未发送成功却 fence root；已改为 cancelPark 恢复 active。
- Risk：switchSession failure 永久 fenced；已按当前 owner 恢复并同步 lease。
- Risk：handback reload send 返回值被忽略；已接入 cancel/recovery。
- Safe：内部 reload 命令是唯一允许不携带 child-owner token 的控制路径，且仅在 expected owner=none 时放行。

Remaining actionable：0。

## 8. Learnings

- 已写入 arch spec：Pi teammate session 单所有者接管协议。
- 关键规则：cancel 必须使用旧 transaction nonce，并在新 fenced token 发布前发送。
- 最终状态：AC1-AC7 全部通过，14/14 focused tests，外部 Codex gate 无 P0/P1。
