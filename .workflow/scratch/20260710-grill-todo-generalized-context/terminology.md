# Terminology

| Term | Definition | Code Reference | Status |
|------|------------|----------------|--------|
| Todo Task | 被 todo 工具跟踪、排序并推进状态的工作步骤。 | `packages/pi-maestro-flow/src/tools/todo.ts:24` | open |
| context | Todo Task 的可选纯文本执行上下文，不承担 file 或 skill 引用解析。 | `packages/pi-maestro-flow/src/extension/schemas.ts:261` | locked |
| skill | Todo Task 的独立可空对象 `{ name, args? }`；由 Pi 原生 loader 解析，Ralph 仅作为行为参考。 | `packages/pi-maestro-flow/src/tools/todo.ts:479` | locked |
| Context Source | [SUPERSEDED] 原统一未解析来源模型；新方向不再把 text/file/skill 混入同一字段。 | `packages/pi-maestro-flow/src/tools/todo.ts:18` | superseded |
| Ref Syntax | [SUPERSEDED] 原 `skill:`、`file:`、`text:` 混合语法；是否保留给独立 skill 配置尚未锁定。 | `packages/pi-maestro-flow/src/tools/todo.ts:379` | open |
| Inject Item | [SUPERSEDED] 当前内部 `type + source + tag?` 统一结构；新模型将分别组装 inline context 与 skill load result。 | `packages/pi-maestro-flow/src/tools/todo.ts:18` | open |
| Resolved Block | `next` 时由 Pi 原生 skill loader 加载得到并注入 prompt 的文本内容；inline context 无需解析。 | `packages/pi-maestro-flow/src/tools/todo.ts:456` | open |
| required reading | skill 声明且 Pi 原生 loader 必须成功读取并内联的文件；行为参考 Ralph，但不形成运行时依赖。 | `D:/maestro2/src/ralph/skill-resolver.ts:152` | locked |
| skill loader | Pi 插件原生的独立模块，负责发现、解析并加载 skill；todo 仅消费其结果。 | `packages/pi-maestro-flow/src/tools/todo.ts:479` | locked |
| skill-config | Pi 原生的 per-skill 默认参数配置：项目 `.pi/skill-config.json` 覆盖全局 `~/.pi/agent/skill-config.json`。 | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:340` | locked |
| Goal Context | 由独立 goal 工具维护、在 `todo next` 时自动注入的活动目标文本；不属于通用 Context Source。 | `packages/pi-maestro-flow/src/tools/todo.ts:348` | locked |
| Task Summary | 已完成步骤提供给后续步骤的短文本摘要。 | `packages/pi-maestro-flow/src/tools/todo.ts:362` | open |
