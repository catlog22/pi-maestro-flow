# 初始化安装（AI 可执行）

本文档面向 AI agent，在 pi-maestro-flow 首次安装后完成 API 凭证、模型回退、cockpit 显示三项基础配置。每步含可复制命令、预期输出、校验点。遇到 INTERACTIVE INPUTS 章节必须用 `ctx.ui` 向用户询问，不得臆测。

## PURPOSE

完成三件事并验证全部生效：
1. **API 凭证** — 至少一个 provider 的凭证写入 `~/.pi/agent/auth.json`
2. **模型回退** — `.pi/model-failover.json` 配置 fallback 链（项目级）
3. **cockpit 显示** — `~/.pi/agent/cockpit.json` 设定主题与显示偏好

成功标准：重启或 `/reload` 后，footer 显示模型名、`/model-failover status` 显示回退路由、cockpit footer 正常渲染。

## PREREQUISITES

- pi-maestro-flow 已安装（`pi install` 完成，postinstall 跑过）
- 至少一个 API provider 账号（OpenAI / Anthropic / OpenRouter / kimi-coding OAuth / 本地兼容端点）
- `~/.pi/agent/` 目录可写（`homedir()` 解析正确）

## TASK

### 1. API 凭证（交互式）

向用户询问 provider 与 key（见 INTERACTIVE INPUTS），写入 `~/.pi/agent/auth.json`。

`auth.json` 结构——每个 provider 一个键，值为带 `type` 的对象：
```json
{
  "openrouter": { "type": "api_key", "key": "sk-or-..." },
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "kimi-coding": { "type": "oauth", "access": "eyJ...", "refresh": "..." }
}
```

- `type: "api_key"` → 凭证字段是 `key`
- `type: "oauth"` → 凭证字段是 `access`（+ 可选 `refresh`）；OAuth provider（如 kimi-coding）优先用 `/mcp auth` 或 provider 自带的授权流程，不要手填 token

写入命令（用 node 保留 JSON 结构，勿覆盖已有条目）：
```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("os").homedir()+"/.pi/agent/auth.json";
const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
cfg[process.env.PI_PROVIDER]={type:process.env.PI_AUTH_TYPE,key:process.env.PI_KEY};
fs.writeFileSync(p,JSON.stringify(cfg,null,2));
console.log("wrote",p);
'
```

**校验点**：`cat ~/.pi/agent/auth.json` 含用户选择的 provider 条目，`type` 与凭证字段匹配，凭证非空。

### 2. 模型回退（交互式）

向用户询问主模型与 fallback 模型（见 INTERACTIVE INPUTS），写入 `.pi/model-failover.json`（项目级）。

结构（注意：是 `fallbackModels` 映射，不是 `routes` 数组；无 `version` 字段）：
```json
{
  "enabled": true,
  "fallbackModels": {
    "maestro-openai/gpt-5.6-sol": ["maestro-qwen/qwen3.8-max"],
    "maestro-qwen/qwen3.8-max": ["maestro-openai/gpt-5.6-sol"]
  }
}
```

- `fallbackModels` 的 key 是主模型 id，value 是 fallback 模型 id 数组
- `enabled: true` 开启自动回退
- 可选 `defaultFallbackModels: string[]` 作为无主模型匹配时的全局默认

写入命令：
```bash
node -e '
const fs=require("fs"),p=".pi/model-failover.json";
fs.mkdirSync(".pi",{recursive:true});
const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{enabled:true,fallbackModels:{}};
cfg.enabled=true;
cfg.fallbackModels=Object.assign(cfg.fallbackModels||{},JSON.parse(process.env.PI_FALLBACKS));
fs.writeFileSync(p,JSON.stringify(cfg,null,2));
console.log("wrote",p);
'
```

`PI_FALLBACKS` 是 `{"<主模型id>":["<fallback1>","<fallback2>"]}` JSON 字符串。

**校验点**：`/model-failover status` 显示路由健康；`cat .pi/model-failover.json` 含 `enabled:true` 和用户配的 `fallbackModels`。

### 3. cockpit 配置（交互式）

向用户询问主题与 quiet 模式（见 INTERACTIVE INPUTS），写入 `~/.pi/agent/cockpit.json`（cockpit 配置在 agent 目录，非项目目录）。

结构（仅改询问的字段，保留其余默认）：
```json
{ "enabled": true, "theme": "cockpit-zen", "quietMode": true }
```

写入命令（合并，不覆盖）：
```bash
node -e '
const fs=require("fs"),p=require("os").homedir()+"/.pi/agent/cockpit.json";
const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
cfg.theme=process.env.PI_THEME||cfg.theme||"cockpit-zen";
cfg.quietMode=process.env.PI_QUIET!=="false";
cfg.enabled=true;
fs.writeFileSync(p,JSON.stringify(cfg,null,2));
console.log("wrote",p);
'
```

**校验点**：footer 渲染正常，quiet 模式按用户选择生效（`/cockpit quiet` 切换）。

## INTERACTIVE INPUTS

执行前必须用 `ctx.ui` 询问以下输入，**不得使用默认值臆测**：

1. **API provider**（`ctx.ui.select`）：
   - 选项：`openrouter` / `anthropic` / `openai` / `kimi-coding` / `其他（手动输入）`
   - 写入 `PI_PROVIDER`
   - OAuth provider（kimi-coding 等）提示用户走授权流程而非手填 token；`PI_AUTH_TYPE` 按选择设 `api_key` 或 `oauth`
2. **API key**（`ctx.ui.input`，标题"输入 API key"，placeholder `sk-...`）：
   - 写入 `PI_KEY`
   - 不回显到日志；写入后只校验非空
3. **主模型 + fallback**（`ctx.ui.input` 两次）：
   - 主模型 id（placeholder `maestro-openai/gpt-5.6-sol`）
   - fallback 模型 id（逗号分隔，placeholder `maestro-qwen/qwen3.8-max`）
   - 组装为 `PI_FALLBACKS` JSON
4. **cockpit 主题**（`ctx.ui.select`）：
   - 选项：`cockpit-zen` / `cockpit-dark` / `保持默认`
   - 写入 `PI_THEME`
5. **quiet 模式**（`ctx.ui.confirm`，"启用 quiet 模式（压缩工具调用显示）？"）：
   - 写入 `PI_QUIET`（true → "true"，false → "false"）

## VERIFY

```bash
# 1. auth.json 有 provider 条目（type + 凭证字段）
cat ~/.pi/agent/auth.json

# 2. model-failover 路由（fallbackModels 结构）
cat .pi/model-failover.json

# 3. cockpit 配置（agent 目录）
cat ~/.pi/agent/cockpit.json
```

**预期**：三文件都存在且含用户选择的值。运行 `/reload` 后 footer 显示主模型名，`/model-failover status` 显示路由健康。

## ROLLBACK

- 删除 `~/.pi/agent/auth.json` 里新增的 provider 条目（保留其他条目）
- 删除 `.pi/model-failover.json`（恢复默认无回退）
- `~/.pi/agent/cockpit.json` 恢复 `theme:"cockpit-zen"`, `quietMode:false`（或删除该文件恢复全默认）
