---
title: Pi monorepo 可验证发布与 registry smoke 流程
description: 从全量串行门禁、optional peer 裸装、源码锁定到 registry smoke 和 tag 的可复用发布流程
type: recipe
category: review
explicitId: rcp-20260804-verified-monorepo-release
created: 2026-08-04T16:19:18.883Z
keywords:
  - npm
  - publish
  - release
  - peerDependencies
  - packed-consumer
  - registry-smoke
  - source-pin
---

## 发布顺序

1. 搜索并加载发布、workspace 依赖和外部精确 pin knowhow。核对 npm/gh 认证、last tag、目标版本未占用、workspace 精确依赖和外部核心版本。
2. 先形成干净、可复现的 release commit，再发布；tag 必须晚于 registry 安装/运行 smoke。
3. 固定顺序发布并逐包在线验证：Teammate -> Cockpit -> Flow。主包发布前，registry 必须已存在其精确 companion 版本。

## 必过门禁

- 根 `test:release` 必须串行覆盖所有本次改动子系统，不能只跑历史小集合。
- Flow 的 prepack/postpack 共用 `.pi/skills`；所有会 pack Flow 的测试必须串行，否则会出现 `ENOENT`/`ENOTEMPTY` 竞争。
- 每包 `npm publish --dry-run`，记录文件数、packed/unpacked size、shasum；实际 registry shasum 必须一致。
- Pi 核心包 `pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox` 使用 optional peer `"*"`，dev 版本对齐验证宿主，tarball 不 bundle 私有副本。

## 边界测试

optional peer 不能只在 workspace 中测试。Pi managed install 使用 peer suppression；任何 runtime value import 都可能在裸装时崩溃。为声称 standalone，必须用 `--legacy-peer-deps` 安装真实 tarball，断言 optional producer 不存在，再由 Pi 启动 extension。共享全局协议 key 可在消费者本地用相同 `Symbol.for(...)`，只保留 type import。

若 npm registry 与上游源码在相同版本下内容漂移，不能继续 pin semver。改用含完整 commit SHA 的 HTTPS source tarball，锁定 URL+integrity，并在 packed consumer 中断言安装未被 optional failure 静默省略，执行一个无需凭据的真实命令。记录 postinstall 前置条件和降级行为。

## v0.14.2 验证记录

commit `380c715b`；Teammate `1.7.1` shasum `ae6d2ca4f071d505fa2b19dcebd2c3506e149681`，Cockpit `0.9.1` `ed65e92a99e8ac17c6898d51e5e0f11d5146186b`，Flow `0.14.2` `05e88ed93522271984708fdff5bd37d4ff6ede85`。全量 release gate、裸 Cockpit、Smart Search offline regression、两项 packed consumer 和 fresh HOME `pi install npm:pi-maestro-flow@0.14.2` RPC smoke 均通过。完成 registry smoke 后才创建并推送 `v0.14.2`。
