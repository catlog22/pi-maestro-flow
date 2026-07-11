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

Pending.

## 5. Fix Log

### Iteration 1

- 将 lease token envelope 接入 child input 与所有 root/proxy send 边界。
- 增加 requiredPromptSeq、agent_end completion 与稳定 idle barrier，消除 prompt 尚未消费时提前 parked。
- handoff timeout 发送 nonce-scoped cancel，ack 按 nonce + fenced epoch 恢复。
- handback returned 校验 nonce、sessionId、sessionFile。
- owner/fence 变化同步发布 child expected lease。
- child lifecycle event 绑定实际 child correlationId；sessionFile 必须 realpath 位于 canonical sessionDir。
- 修复 owner gate/promptSeq 误入 watchTool 的回归。

## 6. Generalization

Pending.

## 7. Discoveries

Pending.

## 8. Learnings

Pending.
