---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
keywords:
  - architecture
  - module
  - layer
  - boundary
  - dependency
  - structure
---

# Architecture Constraints

## Module Structure

## Layer Boundaries

## Dependency Rules

## Technology Constraints

## Entries



<spec-entry category="arch" keywords="todo,skill-loader,defaultresourceloader,state-transition" date="2026-07-10" sid="S-20260710-kwdz" title="Pi todo 的原生 skill 控制边界" description="定义 todo、Pi 原生 skill loader 与未来 Ralph 控制迁移的模块边界" source="planex-odyssey">

### Pi todo 的原生 skill 控制边界

Pi todo MUST 将 skill 作为可空任务配置并通过独立的 Pi 原生 loader 延迟加载。Discovery MUST 复用 DefaultResourceLoader，feature code MUST NOT 复制 skill 目录扫描，也 MUST NOT 依赖 Maestro/Ralph runtime。任何 skill/config/required-reading/budget 失败 MUST 发生在任务状态切换为 in_progress 之前。

</spec-entry>

<spec-entry category="arch" keywords="teammate session handoff lease epoch nonce switchsession" date="2026-07-11" sid="S-20260711-j1kq" title="Pi teammate session 单所有者接管协议" description="Pi teammate session 接管、回交与恢复的唯一 owner 约束" source="master@fe067a5">

### Pi teammate session 单所有者接管协议

Teammate session handoff MUST maintain exactly one writer. Handoff MUST wait for accepted prompt sequence, corresponding agent_end completion, and stable idle before transfer. Every RPC user message MUST carry epoch/nonce lease metadata and child input MUST reject stale tokens. Timeout recovery MUST send the old transaction cancel before publishing the new fenced lease. switchSession invalidates old extension context; handback MUST reload the child session and validate nonce, sessionId, and canonical sessionFile before restoring child ownership.

</spec-entry>

<spec-entry category="arch" keywords="依赖漂移,源码锁定,tarball,packed-consumer,runtime" date="2026-07-15" sid="S-20260715-j486" title="同版本依赖内容漂移的源码锁定" description="registry 与源码同版本异内容时的可复现集成和真实运行验收规则" source="odyssey:20260715-004-odyssey">

### 同版本依赖内容漂移的源码锁定

当 npm registry 包与目标源码具有相同 version 但命令或行为合同不一致时，禁止继续按 semver 或该 registry version 集成。必须锁定到可复现的 HTTPS source tarball + commit SHA，通过 package-local wrapper 调用，并在 packed consumer 中启用 install scripts 后实际执行至少一个代表性命令；仅 require.resolve、npm ls 或 --ignore-scripts 安装不足以证明 runtime 可用。

</spec-entry>

<spec-entry category="arch" keywords="api-key,login,provider,base-url,reasoning,deepseek" date="2026-07-17" sid="S-20260717-nxld" title="Custom API Provider 必须使用单入口 API-key 登录" description="Custom API provider 使用 /login 单入口并隔离其他 provider" source="master@3b0379dd" supersedes="S-20260717-bvo9" status="deprecated" superseded-by="S-20260717-wl3q">

### Custom API Provider 必须使用单入口 API-key 登录

OpenAI Responses 与 Anthropic custom provider MUST 位于 /login 的 API-key 分组，并通过 provider-specific apiKeyLogin 在同一流程采集 Base URL、model ID、reasoning capability 与 API key。公开连接配置 MUST 原子写入 models.json，secret MUST 仅由 Pi credential store 写入 auth.json。MUST NOT 注册额外 /api-provider 命令，MUST NOT 使用 OAuth modifyModels 模拟配置，且更新 MUST 保留 DeepSeek 等其他 provider。

</spec-entry>

<spec-entry category="arch" keywords="api-manager models.json provider api-key base-url reasoning deepseek crud" date="2026-07-17" sid="S-20260717-wl3q" title="Custom API Provider 统一由 API Manager 管理" description="通过 /api-manager 和 models.json 管理自定义 API provider CRUD" source="user:2026-07-17" supersedes="S-20260717-nxld" status="deprecated" superseded-by="S-20260717-en4p">

### Custom API Provider 统一由 API Manager 管理

OpenAI Responses 与 Anthropic custom provider MUST 由 Maestro 的 /api-manager 管理，并以 Pi 官方 models.json 作为持久化入口。命令 MUST 支持 list/show/set/delete/logout/reset；literal API key 或环境变量占位符与 Base URL、model ID、reasoning capability 一并保存在对应 provider 内。新增、更新和删除后 MUST 刷新 ModelRegistry，删除只移除目标 provider，且所有写入 MUST 原子化并保留 DeepSeek 等其他 provider。MUST NOT 依赖 Pi host patch、OAuth modifyModels 或未公开 apiKeyLogin hook。

</spec-entry>

<spec-entry category="arch" keywords="api-manager models.json settings.json defaultthinkinglevel thinkinglevelmap reasoning deepseek" date="2026-07-17" sid="S-20260717-en4p" title="API Manager 分层管理推理能力与默认思考强度" description="区分模型推理能力与 Pi 全局默认思考强度的持久化边界" source="user:2026-07-17" supersedes="S-20260717-wl3q">

### API Manager 分层管理推理能力与默认思考强度

OpenAI Responses 与 Anthropic custom provider MUST 由 /api-manager 管理。模型是否支持 reasoning 及 thinkingLevelMap MUST 写入 models.json；Pi 全局默认思考强度 MUST 通过公开 SettingsManager.setDefaultThinkingLevel() 写入 agent settings.json 的 defaultThinkingLevel，不得向 models.json 写入非官方 default 字段。set 流程 MUST 只展示目标模型支持的档位，list/show MUST 显示当前 Pi 全局默认值，reset MUST 恢复 medium；目标 provider 正在使用时 MAY 同步当前 session。Provider CRUD 写入仍须原子化并保留 DeepSeek 等其他 provider。

</spec-entry>