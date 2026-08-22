import {
  mergeTranslationCatalogs,
  translateSettings,
  type SupportedSettingsLocale,
  type TranslationCatalogs,
  type TranslationParams,
} from "pi-maestro-settings-core/v1";

/**
 * Operator-facing strings for the pi-teammate-models CLI.
 *
 * English is the reference map; every other locale must carry exactly the same
 * key set (checked by `checkCatalogCompleteness`). The raw catalogs are merged
 * into the central TUI catalogs in src/tui/locale.ts so the extension and the
 * CLI can never drift apart, while the typed translator below keeps the CLI
 * independent of the interactive locale lifecycle (a CLI invocation has no
 * Settings event stream, so its locale comes from --locale alone).
 */
export const MODELS_CLI_CATALOGS = {
  en: {
    "models.cli.title": "Registered models",
    "models.cli.header.registration": "Registration",
    "models.cli.header.model": "Model",
    "models.cli.header.deployment": "Deployment",
    "models.cli.header.topology": "Topology",
    "models.cli.header.selection": "Selection",
    "models.cli.header.default": "Default",
    "models.cli.header.registered": "Registered",
    "models.cli.header.resolvable": "Resolvable",
    "models.cli.header.healthy": "Healthy",
    "models.cli.header.session": "Session",
    "models.cli.sessionNa": "n/a (CLI)",
    "models.cli.flagYes": "yes",
    "models.cli.flagNo": "no",
    "models.cli.empty": "No models registered.",
    "models.cli.diagnostics": "Diagnostics:",
    "models.cli.legacyDetected":
      "{path} is a legacy or backend-registry document; v2 model listing requires mode \"model-registry\".",
    "models.cli.legacyPreviewRefusal":
      "Writes to the legacy document are refused; choose [E] to explicitly write an upgraded v2 copy or [A] to abort (default).",
    "models.cli.legacyPreviewUpgraded": "Wrote upgraded v2 skeleton to {path}; complete its model registrations before use.",
    "models.cli.legacyPreviewUpgradedExists":
      "{path} already exists; refusing to overwrite it. Remove it first if you want a fresh skeleton.",
    "models.cli.legacyPreviewPrompt": "Write the explicit upgraded copy? [E]xplicitly write upgraded copy / [A]bort (default):",
    "models.cli.edit.deploymentsHeader": "Registered deployments:",
    "models.cli.edit.deploymentEntry": "  {index}. {id}  ({module})",
    "models.cli.edit.selectDeployment": "Deployment to edit (number or id):",
    "models.cli.edit.invalidSelection":
      "\"{choice}\" is not a registered deployment.",
    "models.cli.edit.fieldPrompt": "{key} — current: {current} ({kind}):",
    "models.cli.edit.unset": "unset",
    "models.cli.edit.fieldRejected": "Invalid value for {key}: {reason}",
    "models.cli.edit.credentialSecretWarning":
      "Warning: that looks like a secret VALUE. {key} stores a variable NAME only; never paste the secret itself.",
    "models.cli.edit.moduleLoadFailed":
      "Could not load configuration fields for module \"{module}\": {reason}",
    "models.cli.edit.noChanges": "No changes; nothing written.",
    "models.cli.edit.written": "Wrote {path}.",
    "models.cli.edit.backupWritten":
      "Wrote {path} (previous document saved to {backup}).",
    "models.cli.edit.abortedDeclined": "Declined to overwrite; nothing was written.",
    "models.cli.edit.partialProgress":
      "Edit aborted before completion; {path} was NOT modified.",
    "models.cli.edit.interrupted":
      "Interrupted; {path} was NOT modified.",
    "models.cli.write.externalChange":
      "Warning: {path} changed since this edit started.",
    "models.cli.write.lastWriterWins":
      "Continuing overwrites those external changes (last writer wins).",
    "models.cli.write.confirmOverwrite": "Overwrite anyway? [y/N]",
    "models.cli.write.rotationFailed":
      "Backup rotation for {path} failed; nothing was written.",
    "models.cli.add.familiesHeader": "Backend families:",
    "models.cli.add.family.pi": "  pi — local Pi subprocess (module pi-subprocess)",
    "models.cli.add.family.dsh": "  dsh — DeepSeek Harness runtime (module pi-maestro-backends/dsh)",
    "models.cli.add.family.acp": "  acp — Agent Client Protocol CLI (module pi-maestro-teammate/v1/acp-cli)",
    "models.cli.add.family.thirdParty": "  third-party — another backend module by id",
    "models.cli.add.familyPrompt": "Backend family (number or name):",
    "models.cli.add.invalidFamily": "\"{choice}\" is not a backend family.",
    "models.cli.add.modulePrompt": "Third-party backend module id:",
    "models.cli.add.transportHeader": "Transport variant:",
    "models.cli.add.transport.local": "  local — launch on this host",
    "models.cli.add.transport.ssh": "  ssh — launch on a remote host over OpenSSH",
    "models.cli.add.transportPrompt": "Transport (number or name) [local]:",
    "models.cli.add.invalidTransport": "\"{choice}\" is not a transport variant.",
    "models.cli.add.deploymentPrompt": "New deployment id (unique):",
    "models.cli.add.deploymentExists": "Deployment \"{id}\" already exists; choose another id.",
    "models.cli.add.invalidId": "An id must be non-empty without surrounding whitespace or control characters.",
    "models.cli.add.fieldPrompt": "{key} — default: {current} ({kind}):",
    "models.cli.add.requiredField": "{key} is required for this configuration; enter a value.",
    "models.cli.add.registrationIdPrompt": "Model registration id (unique):",
    "models.cli.add.registrationDeploymentPrompt": "Deployment for this registration (empty = new \"{id}\"):",
    "models.cli.add.registrationExists": "Model registration \"{id}\" already exists; choose another id.",
    "models.cli.add.modelIdPrompt": "Intrinsic model id:",
    "models.cli.add.selectorHeader": "Selector:",
    "models.cli.add.selector.adapterModel": "  adapter-model — route an intrinsic adapter/model id (prompted next)",
    "models.cli.add.selector.deploymentDefault": "  deployment-default — the deployment's default route",
    "models.cli.add.selector.fixed": "  fixed — one fixed route (backends with unsupported model selection only)",
    "models.cli.add.selectorPrompt": "Selector (number or name):",
    "models.cli.add.invalidSelector": "\"{choice}\" is not a selector kind.",
    "models.cli.add.selectorValuePrompt": "Adapter-model value:",
    "models.cli.add.selectorValueRequired": "The adapter-model selector needs a non-empty value.",
    "models.cli.add.forcedDeploymentDefault":
      "This document has no model registrations yet; this registration becomes the default model.",
    "models.cli.add.deploymentDefaultPrompt": "Make this registration the deployment default? [y/N]:",
    "models.cli.add.compilerErrors":
      "The candidate manifest failed validation; re-enter the model registration:",
    "models.cli.add.summaryHeader": "Ready to write:",
    "models.cli.add.summaryDeployment": "  new deployment {id} → module {module}",
    "models.cli.add.summaryRegistration": "  new registration {id} → model {model}, {selector}",
    "models.cli.add.summaryDefaults": "  default deployment {deployment}, defaultModel {model}",
  },
  "zh-CN": {
    "models.cli.title": "已注册模型",
    "models.cli.header.registration": "注册",
    "models.cli.header.model": "模型",
    "models.cli.header.deployment": "部署",
    "models.cli.header.topology": "拓扑",
    "models.cli.header.selection": "选择器",
    "models.cli.header.default": "默认",
    "models.cli.header.registered": "已注册",
    "models.cli.header.resolvable": "可解析",
    "models.cli.header.healthy": "健康",
    "models.cli.header.session": "会话",
    "models.cli.sessionNa": "不适用（CLI）",
    "models.cli.flagYes": "是",
    "models.cli.flagNo": "否",
    "models.cli.empty": "没有已注册的模型。",
    "models.cli.diagnostics": "诊断信息：",
    "models.cli.legacyDetected":
      "{path} 是 legacy 或 backend-registry 文档；v2 模型列表要求 mode 为 \"model-registry\"。",
    "models.cli.legacyPreviewRefusal":
      "拒绝写入旧文档；选择 [E] 显式写出升级后的 v2 副本，或 [A] 中止（默认）。",
    "models.cli.legacyPreviewUpgraded": "已把升级后的 v2 骨架写入 {path}；使用前请先补全其模型注册。",
    "models.cli.legacyPreviewUpgradedExists":
      "{path} 已存在；拒绝覆盖。如需全新骨架，请先移除该文件。",
    "models.cli.legacyPreviewPrompt": "写出显式升级副本？[E] 显式写出升级副本 / [A] 中止（默认）：",
    "models.cli.edit.deploymentsHeader": "已注册部署：",
    "models.cli.edit.deploymentEntry": "  {index}. {id}（{module}）",
    "models.cli.edit.selectDeployment": "要编辑的部署（编号或 ID）：",
    "models.cli.edit.invalidSelection": "“{choice}”不是已注册的部署。",
    "models.cli.edit.fieldPrompt": "{key} — 当前：{current}（{kind}）：",
    "models.cli.edit.unset": "未设置",
    "models.cli.edit.fieldRejected": "{key} 的值无效：{reason}",
    "models.cli.edit.credentialSecretWarning":
      "警告：这看起来像机密值本身。{key} 只存储变量名；切勿粘贴机密内容。",
    "models.cli.edit.moduleLoadFailed":
      "无法加载模块 “{module}” 的配置字段：{reason}",
    "models.cli.edit.noChanges": "没有更改；未写入任何内容。",
    "models.cli.edit.written": "已写入 {path}。",
    "models.cli.edit.backupWritten":
      "已写入 {path}（原文档已保存到 {backup}）。",
    "models.cli.edit.abortedDeclined": "已拒绝覆盖；未写入任何内容。",
    "models.cli.edit.partialProgress":
      "编辑在中途中止；{path} 未被修改。",
    "models.cli.edit.interrupted":
      "已中断；{path} 未被修改。",
    "models.cli.write.externalChange":
      "警告：{path} 在本次编辑期间被外部修改过。",
    "models.cli.write.lastWriterWins":
      "继续将覆盖这些外部修改（后写入者胜）。",
    "models.cli.write.confirmOverwrite": "仍要覆盖吗？[y/N]",
    "models.cli.write.rotationFailed":
      "{path} 的备份轮换失败；未写入任何内容。",
    "models.cli.add.familiesHeader": "后端家族：",
    "models.cli.add.family.pi": "  pi —— 本地 Pi 子进程（模块 pi-subprocess）",
    "models.cli.add.family.dsh": "  dsh —— DeepSeek Harness 运行时（模块 pi-maestro-backends/dsh）",
    "models.cli.add.family.acp": "  acp —— Agent Client Protocol CLI（模块 pi-maestro-teammate/v1/acp-cli）",
    "models.cli.add.family.thirdParty": "  third-party —— 按模块 id 指定其他后端模块",
    "models.cli.add.familyPrompt": "后端家族（编号或名称）：",
    "models.cli.add.invalidFamily": "“{choice}”不是后端家族。",
    "models.cli.add.modulePrompt": "第三方后端模块 id：",
    "models.cli.add.transportHeader": "传输变体：",
    "models.cli.add.transport.local": "  local —— 在本机启动",
    "models.cli.add.transport.ssh": "  ssh —— 通过 OpenSSH 在远端主机启动",
    "models.cli.add.transportPrompt": "传输方式（编号或名称）[local]：",
    "models.cli.add.invalidTransport": "“{choice}”不是可选的传输变体。",
    "models.cli.add.deploymentPrompt": "新部署 id（须唯一）：",
    "models.cli.add.deploymentExists": "部署 “{id}” 已存在；请换一个 id。",
    "models.cli.add.invalidId": "id 不能为空，且不得包含首尾空白或控制字符。",
    "models.cli.add.fieldPrompt": "{key} —— 默认值：{current}（{kind}）：",
    "models.cli.add.requiredField": "此配置要求填写 {key}；请输入值。",
    "models.cli.add.registrationIdPrompt": "模型注册 id（须唯一）：",
    "models.cli.add.registrationDeploymentPrompt": "此注册归属的部署（留空 = 新建 “{id}”）：",
    "models.cli.add.registrationExists": "模型注册 “{id}” 已存在；请换一个 id。",
    "models.cli.add.modelIdPrompt": "内在模型 id：",
    "models.cli.add.selectorHeader": "Selector：",
    "models.cli.add.selector.adapterModel": "  adapter-model —— 路由到某个内在 adapter/model id（下一步输入）",
    "models.cli.add.selector.deploymentDefault": "  deployment-default —— 该部署的默认路由",
    "models.cli.add.selector.fixed": "  fixed —— 单一固定路由（仅限模型选择不受支持的后端）",
    "models.cli.add.selectorPrompt": "Selector（编号或名称）：",
    "models.cli.add.invalidSelector": "“{choice}”不是可选的 selector 类型。",
    "models.cli.add.selectorValuePrompt": "adapter-model 取值：",
    "models.cli.add.selectorValueRequired": "adapter-model selector 需要非空取值。",
    "models.cli.add.forcedDeploymentDefault":
      "该文档尚无模型注册；此注册将成为默认模型。",
    "models.cli.add.deploymentDefaultPrompt": "将此注册设为部署默认？[y/N]：",
    "models.cli.add.compilerErrors":
      "候选 manifest 未通过校验；请重新输入模型注册：",
    "models.cli.add.summaryHeader": "准备写入：",
    "models.cli.add.summaryDeployment": "  新部署 {id} → 模块 {module}",
    "models.cli.add.summaryRegistration": "  新注册 {id} → 模型 {model}，{selector}",
    "models.cli.add.summaryDefaults": "  默认部署 {deployment}，defaultModel {model}",
  },
} satisfies TranslationCatalogs;

/** Keys are typed from the English reference map. */
export type ModelsCliKey = keyof (typeof MODELS_CLI_CATALOGS)["en"];

export type ModelsCliTranslator = (key: ModelsCliKey, params?: TranslationParams) => string;

const MERGED_MODELS_CLI_CATALOGS = mergeTranslationCatalogs(MODELS_CLI_CATALOGS);

export function createModelsCliTranslator(locale: SupportedSettingsLocale = "en"): ModelsCliTranslator {
  return (key, params) => translateSettings(MERGED_MODELS_CLI_CATALOGS, locale, key, params);
}

/** @returns the supported locale, or undefined when the flag value is invalid. */
export function parseModelsCliLocale(value: string): SupportedSettingsLocale | undefined {
  return value === "en" || value === "zh-CN" ? value : undefined;
}
