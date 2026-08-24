# Teammate 模型配置（AI 可执行）

本文档面向 AI agent，配置 `.pi/teammate-models.json` 的模型映射、fallback、thinking level。teammate 是 pi-maestro-flow 的执行引擎，按 taskType 路由到不同模型。

## PURPOSE

配置 `teammate-models.json` 的：
1. **mappings** — 每个 taskType 的主模型
2. **fallbackMappings** — 主模型失败时的降级链
3. **thinkingLevels** — 每个 taskType 的思考深度

成功标准：`teammate` 调度时按 taskType 选中配置的模型；主模型不可用时自动降级到 fallback。

## PREREQUISITES

- API 凭证已配置（见 INIT-SETUP.md），至少一个 provider 可用
- 可用模型清单可通过 `/scoped-models` 或 `model-availability` 工具获取

## TASK

### 1. 收集可用模型清单

先查询当前会话可用的模型（注入的 system prompt 里有 `<available_teammate_models>` 列表），作为可选项呈现给用户。不要臆造模型 id。

### 2. 交互式配置每个 taskType

向用户询问每个 taskType 的主模型与 fallback（见 INTERACTIVE INPUTS）。合法 taskType（内置 `TEAMMATE_TASK_TYPES`）：
`explore` / `analysis` / `debug` / `planning` / `development` / `review` / `testing`

（`verification` 是 Goal 质量门的 taskType，非 teammate 内置路由类型；自定义 agent 可声明更多。）

### 3. 写入配置

`.pi/teammate-models.json` 支持两种格式：

**legacy v2**（简单，仍可用，会被自动归一化为 v3）：
```json
{
  "version": 2,
  "mappings": {
    "analysis": "maestro-qwen/qwen3.8-max-preview",
    "explore": "maestro-openai/gpt-5.6-luna"
  },
  "fallbackMappings": {
    "analysis": ["maestro-openai/gpt-5.6-sol"],
    "explore": ["maestro-openai/gpt-5.6-sol"]
  },
  "thinkingLevels": {
    "explore": "low",
    "analysis": "high"
  }
}
```

**现代 v3 项目覆盖**（推荐，支持 profile 切换）：
```json
{
  "version": 3,
  "activeProfile": "default",
  "applyOverrides": true,
  "overrides": {
    "mappings": { "analysis": "maestro-qwen/qwen3.8-max-preview" },
    "fallbackMappings": { "analysis": ["maestro-openai/gpt-5.6-sol"] },
    "thinkingLevels": { "analysis": "high" }
  }
}
```

仅允许的键（`assertKnownKeys`）：`mappings` / `fallbackMappings` / `thinkingLevels` / `roleMappings` / `typeMeta`。多写未知键会报错。

- `mappings`（必填）：taskType → 主模型 id
- `fallbackMappings`（可选）：taskType → fallback 模型 id 数组
- `thinkingLevels`（必填）：taskType → `off|minimal|low|medium|high|xhigh|max`
- `roleMappings`（可选）：agent 名 → 角色规则
- `typeMeta`（可选）：taskType → 触发关键词

全局配置在 `~/.pi/agent/teammate-models.json`（含 profiles），项目配置在 `.pi/teammate-models.json`（覆盖全局）。两者路径均由 `model-routing.ts` 的 `getGlobalModelRoutingPath` / `getProjectModelRoutingPath` 解析。

写入命令（合并，不覆盖已有 mappings）：
```bash
node -e '
const fs=require("fs"),p=".pi/teammate-models.json";
const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{version:2};
cfg.mappings=Object.assign(cfg.mappings||{},JSON.parse(process.env.PI_MAPPINGS));
cfg.fallbackMappings=Object.assign(cfg.fallbackMappings||{},JSON.parse(process.env.PI_FALLBACKS));
cfg.thinkingLevels=Object.assign(cfg.thinkingLevels||{},JSON.parse(process.env.PI_THINKING));
fs.writeFileSync(p,JSON.stringify(cfg,null,2));
console.log("wrote",p);
'
```

**校验点**：`cat .pi/teammate-models.json` 含用户配置的所有 taskType。

## INTERACTIVE INPUTS

对**每个**要配置的 taskType 询问（先问用户要配哪些 taskType，再逐个配）：

1. **要配置的 taskType**（`ctx.ui.select`，multi：列出 7 个内置 taskType，用户选一个或“全部”）
2. **主模型**（`ctx.ui.select`）：从可用模型清单选，选项为 `<available_teammate_models>` 的 id
3. **fallback 模型**（`ctx.ui.input`，"fallback 模型 id（逗号分隔，可空）"）：从可用模型清单选
4. **thinking level**（`ctx.ui.select`）：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`
5. 写入 `PI_MAPPINGS` / `PI_FALLBACKS` / `PI_THINKING`（JSON 字符串）

**建议默认值**（仅在用户选"用推荐配置"时采用）：
- explore: `maestro-openai/gpt-5.6-luna`, fallback `maestro-openai/gpt-5.6-sol`, thinking `low`
- analysis: `maestro-qwen/qwen3.8-max-preview`, fallback `maestro-openai/gpt-5.6-sol`, thinking `high`
- review: `maestro-openai/gpt-5.6-luna`, fallback `maestro-qwen/qwen3.8-max`, thinking `inherit`

## VERIFY

```bash
cat .pi/teammate-models.json
# 确认 mappings 里每个 taskType 都有值，且值在 available_teammate_models 清单里
```

**预期**：配置的 taskType 都有主模型，fallback（若有）指向清单内模型。运行一次 `teammate` 调度确认路由生效。

## ROLLBACK

- 删除 `.pi/teammate-models.json`（恢复默认路由：继承主会话模型，再按 taskType 默认）
- 或删除单个 taskType 条目，保留其余
