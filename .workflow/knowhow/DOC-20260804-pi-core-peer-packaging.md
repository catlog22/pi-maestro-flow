---
title: Pi 插件核心包 peer 依赖与子进程解析边界
description: Pi 核心包的 peer/dev 分层、typebox 单例、子进程解析和 packed consumer 验证规则
type: document
category: arch
explicitId: doc-20260804-pi-core-peer-packaging
created: 2026-08-04T15:08:36.388Z
keywords:
  - pi-package
  - peerDependencies
  - typebox
  - SDK
  - packed-consumer
  - child-process
---

## 官方规则

Pi package 只要导入核心包，就必须在 `peerDependencies` 以 `"*"` 声明且不得 bundle：`@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`。可配 `peerDependenciesMeta.optional=true`，避免 npm 独立补装；本地类型检查、测试与声明生成用固定 `devDependencies` 对齐目标 Pi 版本。普通第三方运行时库才进入 `dependencies`。来源：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#dependencies

## 项目落地

Flow/Teammate 保留四个 `@earendil-works/*` optional peer；`typebox` 从 `dependencies` 移到 optional peer。开发基线 Pi `0.83.0` 对应 `typebox@1.3.7`，根 workspace、Flow、Teammate 统一该版本，lock 中旧的 1.1.x 物理副本删除。运行时必须消费宿主核心包，禁止为消除解析错误把 SDK 放回普通依赖。

## 解析边界

Pi loader 内的扩展和由 Teammate 启动的 Pi CLI 子进程可使用宿主 peer。普通 `node` sidecar 不具备宿主注入；若其加载链命中 SDK value import，会在启动时 `MODULE_NOT_FOUND`。应移除 sidecar 路径上的 value import，或从已知 Pi package root 显式注入解析，同时捕获 stderr。案例：https://github.com/nicobailon/pi-subagents/issues/334

禁止假设 `packages/<pkg>/node_modules/<sdk>` 存在，也禁止用嵌套安装或软链接维持测试。需要 SDK 包根时，从 `import.meta.resolve("@earendil-works/pi-coding-agent")` 的公共 ESM 入口反推；不要用未导出的深层裸说明符。

## 验证门禁

1. `npm ls` 证明 SDK/typebox 版本与宿主基线一致且可 hoist。
2. Flow/Teammate typecheck 与 Teammate declaration build/check 全绿。
3. `npm pack --dry-run --workspace=<pkg>` 的 `bundled` 为空，文件表无核心 SDK/typebox。
4. packed consumer 在 fresh temp 安装真实 tarball、Pi SDK 和 companions，并实际启动 Pi。
5. pack 测试必须串行：Flow prepack/postpack 共用 `packages/pi-maestro-flow/.pi/skills`，并行会产生 `ENOTEMPTY` 竞争。

2026-08-04 验证：Flow/Teammate typecheck、declarations、两个 dry-run pack、`test:packed`、`test:packed-todo` 均通过；无需 package-local SDK 链接。
