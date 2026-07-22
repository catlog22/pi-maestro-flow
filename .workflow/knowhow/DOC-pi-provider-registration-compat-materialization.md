---
title: Pi Provider 注册的合法克隆与 compat 物化
tags:
  - pi
  - provider-config
  - compat
  - migration
  - thinking-level
codePaths:
  - packages/pi-maestro-flow/src/providers/api-provider-config.ts
  - packages/pi-maestro-flow/test/api-provider-config.test.ts
commit: 7172f01fbe82a1ae77ddec1b858b000e25ed53b9
category: coding
createdBy: harvest
sourceRef: 20260722-maestro-effort-control-20260722-135556
---
Pi 0.74.0 的 Extension `registerProvider()` 输入必须保持合法 `ProviderConfig` 顶层形状；持久化模型配置可能省略 loader 会补齐的字段，也可能把 compat 写在 provider 层，因此不能原样透传到注册 API。

注册边界采用无 mutation 变换：

- 只克隆 `name`、`baseUrl`、`api`、`apiKey`、`headers`、`authHeader`、`models` 等合法顶层字段；
- 为磁盘中可省略的 model 字段补齐 Pi loader defaults；
- 将 provider-level compat 深合并到每个 `model.compat`，并保留 model-level override；
- canonical thinking level 保持 `xhigh`，`max` 仅作为 `thinkingLevelMap` 的 Provider wire value；
- 迁移通过既有串行化写入和 temporary rename 提交，并保持源对象、兄弟字段及其他 provider 不变。

该边界同时解决类型合法性、旧配置兼容和 refresh 后模型注册一致性。验证应覆盖 headers/authHeader、nested compat merge、legacy `max` → canonical `xhigh`、兄弟字段保留和源对象无 mutation。