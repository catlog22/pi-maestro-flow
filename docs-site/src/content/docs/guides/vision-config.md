---
title: "Vision 多模态委托"
icon: "🖼️"
---

主模型为**纯文本模型**时，图片分析自动委托给多模态模型；切回原生多模态模型后自动改走本地能力。

---

## 工作原理

- 纯文本模型 + 委托启用 → 自动激活 `describe_image` 工具，并在系统提示中注入使用引导；
- 原生多模态模型 → 工具自动隐藏，直接看图；
- 委托失败按候选模型链回退，结果带缓存（默认 50 条，按图片+提示哈希）；
- 工具内置约束：**成功委托前不得声称看过图**。

## 使用步骤

```javascript
// 1. 查看状态
/vision show

// 2.（可选）指定首选模型
/vision model maestro-qwen/qwen3.8-max

// 3. 让模型分析图片（本地路径 / URL / data-url）
describe_image({ image_path: "截图.png", prompt: "分析重点" })
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `/vision show\|status` | 查看状态 |
| `/vision on\|off` | 启用 / 停用 |
| `/vision model <ref\|auto>` | 首选模型（provider/model） |
| `/vision fallback <a,b\|clear>` | 回退模型链（逗号分隔，按序回退） |
| `/vision cache on\|off\|clear` | 结果缓存 |
| `/vision prompt <text\|clear>` | 自定义分析提示 |
| `/vision retries <0-10>` | 每模型最大重试 |
| `/vision timeout <ms>` | 单次请求超时（1000-300000） |

## 配置文件

持久化于 `~/.pi/agent/vision-delegation.json`（首次修改设置时自动创建）：

```json
{
  "enabled": true,
  "cache": { "enabled": true, "maxEntries": 50 },
  "fallbackModels": [],
  "maxRetries": 0,
  "retryBackoffMs": 500,
  "timeoutMs": 60000,
  "maxImageBytes": 20971520
}
```

### 配置项

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 委托总开关 |
| `cache.enabled` | `true` | 结果缓存 |
| `cache.maxEntries` | `50` | 缓存条目上限（按图片+提示哈希） |
| `fallbackModels` | `[]` | 回退模型链（`provider/model`，按序回退） |
| `maxRetries` | `0` | 每模型最大重试。默认 0：重试会整图+整提示重新发送，慢模型可能卡死多轮——给一次尝试更充裕的截止时间，超时直接故障转移 |
| `retryBackoffMs` | `500` | 重试退避间隔 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageBytes` | `20971520`（20MB） | 图片大小上限，支持 png/jpeg/gif/webp |

## 图片路由

附加图片的自动分析有路由逻辑（`maestro-image-routing`）：`native`（原生多模态）→ `vision`（委托）→ `vision+native`（双路径）→ `unread`（未读）。每轮自动分析的附加图片数上限 5 张（`MAX_ATTACHED_IMAGES_PER_TURN`），防止成本线性爆炸。

## 下一步

- [API Provider 与模型故障转移](/guides/api-provider-config) — Vision 模型关联与熔断
- [模型路由与思考深度](/guides/model-routing) — 模型选择
- [环境变量速查](/guides/env-vars) — 相关环境变量
