/** Version 1 unified classifier contract shared by plugin consumers. */
export {
  classify,
  classifierConfig,
  classifierStatus,
  classifySync,
  configureClassifier,
  bindClassifierRuntime,
  probeClassifierRuntime,
  unbindClassifierRuntime,
  classifyDomain,
  listClassifyDomains,
  registerClassifyDomain,
  resetClassifierForTest,
} from "../../classify/engine.ts";
export type {
  ClassifierConfig,
  ClassifierRuntimeBinding,
  ClassifierRuntimeReadiness,
  ClassifierDomainStatus,
  ClassifierStatus,
} from "../../classify/engine.ts";

export {
  fileValueDomain,
  registerBuiltinClassifyDomains,
  retryErrorDomain,
} from "../../classify/domains.ts";
export type {
  FileValueInput,
  FileValueLabel,
  RetryErrorInput,
} from "../../classify/domains.ts";

export {
  createJevClient,
  createNativeJevClient,
  JEV_API_KEY_ENVS,
  JEV_DEFAULT_MODELS,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_ENDPOINT_URLS,
  parseJevResponse,
  resolveJevEndpoint,
} from "../../classify/client.ts";
export type {
  JevClient,
  ClassifierRuntime,
  JevClientOptions,
  NativeJevClientOptions,
  JevEndpoint,
} from "../../classify/client.ts";

export type {
  ClassifierDomainMode,
  ClassifierLayer,
  ClassifyDomain,
  ClassifyResult,
  ClassifyShadowRecord,
  JevAnswer,
  JevAnswers,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevNoulAnswer,
  JevNoulQuestion,
  JevQuestion,
  JevQuestions,
  JevRequest,
  JevResponse,
  JevScoreAnswer,
  JevScoreQuestion,
  RuleVerdict,
} from "../../classify/types.ts";
