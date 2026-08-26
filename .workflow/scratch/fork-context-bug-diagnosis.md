# Fork Context Bug Diagnosis (Session 01a036f0)

## 失败现象
会话 `01a036f0` 两次 teammate 委派 `context: "fork"` 失败:
- 第一个 teammate `65f468a7`:被主动终止(AbortError),5 turn 19s,668k cacheRead→670 output
- 第二个 teammate `2b61126e`:turn-ended 后 7.7 分钟工具循环不收敛,会话中断

## 根因(机制级)
`context: "fork"` 让 child 继承父会话完整历史作为初始上下文。本次父会话 fork 前:
- 总 token 224k(未达 auto-compaction 阈值,父会话 **0 个 compaction 条目**)
- 5201 条历史,含 Plan 研究 explorer transcript、大量文件读取(与删除 evaluator 任务无关)

## Fork 实现链路(已验证)
1. `packages/pi-maestro-teammate/src/extension/index.ts:4082` `createForkSnapshot()`
2. `packages/pi-maestro-teammate/src/runs/fork-snapshot.ts:141` 
   `retainedEntries = activeChain.chain.slice(0, spawningIndex)` ← 完整祖先链
3. `fork-snapshot.ts:147` `serialized` 直接写出 header+完整祖先链到 temp 文件
4. `execution-infra.ts:2084` `args.push("--fork", forkSessionFile)` 传给 child
5. child 以此 snapshot 为 session 文件启动,`buildSessionContext` 投影到 LLM

## Compaction 截断设计(两层分离)
- **Snapshot 文件**:保留完整祖先链(session 树完整性,测试 fork-snapshot.test.ts:120)
- **Provider context**:`buildSessionContext`(Pi 核心 session-manager.js:191-235)
  - 有 compaction 条目时:从 latest compaction 截断,older entries omitted
  - **无 compaction 条目时:返回完整 path,不截断** ← bug 放大点

## Bug 本质
**不是投影 bug,是 fork 时机 bug**:父会话从未触发 auto-compaction(224k < contextWindow - 16384),fork 把未压缩完整历史喂给 child。fork 链路无"fork 前先 compact"保护。

## 关键证据
- 父会话 fork 前 `type=compaction` 条目数:0
- 父会话 fork 前 assistant usage:total=224005, input=706, cacheRead=222720
- child session 文件 5214 行,前 5201 条与父会话逐字一致(parentSession 指向父)
- `selectProtocolMessages` 的 compaction 截断逻辑(fork-snapshot.ts:290-340)只用于 validateToolProtocol,未用于 serialized 写出

## 相关代码
- `packages/pi-maestro-teammate/src/runs/fork-snapshot.ts`(snapshot 生成)
- `packages/pi-maestro-teammate/src/extension/index.ts:4067-4094`(dispatch fork 调用)
- `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1617`(isTeammateForkStartup)
- `packages/pi-maestro-flow/src/compaction/teammate-compaction-relay.ts`(fork 启动识别)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:191-235`(buildSessionContext)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:160-163`(shouldCompact)
