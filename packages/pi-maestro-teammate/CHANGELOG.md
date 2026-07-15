# Changelog

## 0.4.4 (2026-07-15)

Teammate 工具审计修复（详见 `docs/teammate-tool-fix-plan.md`）。

### 修复

- **reply_to 死锁检测死代码移除**：原检测条件在 schema 枚举约束下永不生效，且命中路径声称 fallback 却不派发 agent。整段移除（`detectReplyCycle` 及调用点）。
- **`{name}` 未知引用不再静默降级**：与现有任务名编辑距离相近的引用视为拼写错误，派发前报错；其余未知引用按字面文本传递并返回 `[warn]` 警告。原 `runGraph` 中不可达的 unknown-name throw 被真正的派发前校验取代。
- **normalize 逻辑统一**：根路径 `execute` 与子进程代理路径 `handleProxyRequest` 的任务归一化收敛为共享的 `normalizeTeammateParams()`，消除两份实现的漂移（含错误消息不一致）。
- **代理路径 teammate-send 寻址对齐**：与根路径一致，支持名称 / correlation ID / 唯一前缀（原来只认名称）。

### 行为变化（Breaking）

- **多任务模式 `context: "fork"` 现在真正生效**：此前被静默丢弃（全部 fresh）。现在顶层 `context` 作为所有任务的默认值、per-task 可覆盖——fork N 个任务会复制 N 份父会话，注意 token 成本。
- **空任务派发前报错**：单任务模式 `task`/`prompt` 均缺失、或多任务中某任务两者均缺失时，返回错误而非空跑。
- **`tasks` 优先于已废弃的 `chain`**：两者同给时此前 chain 生效，现在 tasks 生效并对 chain 发出弃用警告。任何 chain 使用都会收到弃用警告；chain 将在后续 minor 版本移除。
- **`protocol_version` 从对外 schema 移除**：运行时仍兼容旧调用方传入（TypeBox 默认允许未知属性），`resolveReplyTo` 逻辑不变。

### 新增

- **`dependsOn` 显式依赖**（TaskSpec）：与 `{name}` 引用推导取并集构成依赖边，适合只需顺序、无需注入输出的场景；未知任务名严格报错。`inferGraphMode`、进度树、`runGraph` 统一经 `taskDependencyNames()` 计算依赖。
- **TaskSpec 级 `context` 覆盖**：单个任务可独立选择 `fresh`/`fork`。
- **teammate-send `message` 对 `abort` 可选**；`mode` 默认值（`follow_up`）与寻址规则写入 schema 描述。
- 多任务顶层 `agent`/`task` 被忽略、`promptArgs` 缺 `prompt` 等情况现在返回 `[warn]` 警告。

### 测试

- 新增 `test/normalize.test.ts`（18 个用例）：模式选择、fail-fast、默认值下沉、chain 弃用优先级、拼写检测/字面量区分、dependsOn、context 透传。
- `graph-status-and-structured-output.test.ts` 的 normalize 守护测试改为断言共享实现（防止重复被重新引入）。
