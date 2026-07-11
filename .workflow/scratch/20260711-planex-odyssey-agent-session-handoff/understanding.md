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

Pending.

## 4. Verification

Pending.

## 5. Fix Log

Pending.

## 6. Generalization

Pending.

## 7. Discoveries

Pending.

## 8. Learnings

Pending.
