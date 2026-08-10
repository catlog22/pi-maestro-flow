export type ExpertsMode = "normal" | "experts";

export type ExpertsTaskType =
  | "explore"
  | "analysis"
  | "debug"
  | "development"
  | "review"
  | "planning"
  | "testing"
  | "verification";

export interface TriageResult {
  taskType: ExpertsTaskType;
  agent: string;
  heavy: boolean;
  pipeline: ExpertsTaskType[];
  matchedRules: string[];
  reason: string;
}

export interface DispatchRecord {
  mode: ExpertsMode;
  taskType?: string;
  agent?: string;
  model?: string;
  forced: boolean;
  at: string;
  promptPreview?: string;
  /** Maestro chain stage when known (P4). */
  stage?: string;
}

export interface TeammateTaskLike {
  prompt?: string;
  agent?: string;
  taskType?: string;
  model?: string;
  name?: string;
  [key: string]: unknown;
}

export interface TeammateParamsLike {
  tasks?: TeammateTaskLike[];
  agent?: string;
  taskType?: string;
  model?: string;
  prompt?: string;
  /** P4: Maestro chain stage / command for stagePolicies. */
  stage?: string;
  [key: string]: unknown;
}

export type GateDecision = "allow" | "ask" | "deny";

/** P5: how Leader should rewrite a blocked heavy tool call. */
export interface RewriteSuggestion {
  action: "teammate";
  taskType: string;
  agent: string;
  stage?: string;
  prompt: string;
  blockedTool?: string;
  pathHint?: string;
  commandHint?: string;
}

export interface GateResult {
  decision: GateDecision;
  reason: string;
  stage?: string;
  /** Present on deny/ask (and allowlist allow) for Leader rewrite. */
  rewriteSuggestion?: RewriteSuggestion;
}

/** One step in a Maestro stage expert pipeline (P4). */
export interface StagePipelineStep {
  agent?: string;
  taskType: ExpertsTaskType | string;
  name?: string;
  dependsOn?: string[];
}

/** Policy for a Maestro chain stage under Experts Mode. */
export interface StagePolicy {
  pipeline: StagePipelineStep[];
  /** Paths/globs the Leader may write (documentation only unless hard-gate enforces). */
  leaderMayWrite?: string[];
  /** Human-readable forbid list for main-session heavy work. */
  forbidMain?: string[];
  /** Prefer parallel wave when multiple independent tasks (hint only). */
  parallelism?: "serial" | "wave" | "parallel";
  /** When true, stage should not reuse in-flight leader context for independence. */
  independent?: boolean;
}

export interface StageExpertsPlan {
  mode: ExpertsMode;
  stage: string;
  source: "stage-policy" | "triage-fallback" | "none";
  tasks: TeammateTaskLike[];
  leaderInstructions: string;
  policy?: StagePolicy;
}

/** P6: one expert role on the project roster (role ≠ model). */
export interface RosterEntry {
  /** Stable role id (usually matches agent name or taskType). */
  id: string;
  /** Teammate agent / role name — never a model id. */
  agent: string;
  /** Default taskType for routing when stage/triage does not override. */
  defaultTaskType: string;
  /** Optional human label. */
  label?: string;
  /** Optional capability tags (explore, review, …). */
  capabilities?: string[];
  /** Optional tool allow hints (documentation; not enforced here). */
  tools?: string[];
  /** When false, role is listed but not auto-selected. */
  enabled?: boolean;
}

/** P6: in-flight expert work unit for observability. */
export interface InFlightExpert {
  id: string;
  agent?: string;
  taskType?: string;
  name?: string;
  stage?: string;
  at: string;
  /** Optional correlation id when host provides one. */
  correlationId?: string;
}

/** P6: lightweight canvas/status snapshot for cockpit (not a full UI). */
export interface ExpertsCanvasSnapshot {
  schema: "experts-canvas/1.0";
  mode: ExpertsMode;
  updatedAt: string;
  activeStage: string | null;
  leaderWaiting: boolean;
  leaderWaitingCount: number;
  inFlight: InFlightExpert[];
  lastDispatch: DispatchRecord | null;
  roster: Array<Pick<RosterEntry, "id" | "agent" | "defaultTaskType" | "label" | "enabled">>;
  /** P7: compact pending harvest list (titles only). */
  knowledgeSuggestions?: Array<{
    id: string;
    kind: KnowledgeHarvestSuggestion["kind"];
    title: string;
    score: number;
    fingerprint: string;
  }>;
}

export interface ExpertsRules {
  version?: number;
  defaultTaskType?: string;
  defaultAgent?: string;
  defaultPipeline?: string[];
  pipelines?: Record<string, string[]>;
  taskTypes?: Record<string, {
    agent?: string;
    heavy?: boolean;
    keywords?: string[];
  }>;
  lightKeywords?: string[];
  hardGate?: {
    default?: GateDecision;
    tools?: Record<string, GateDecision>;
    /**
     * P5: extra project-relative globs the Leader may write/edit under experts.
     * Always merged with built-in orchestration defaults (report/outputs/.workflow/notes).
     */
    leaderAllowPaths?: string[];
    /** P5: bash command prefixes Leader may run without teammate. */
    bashAllowPrefixes?: string[];
  };
  /**
   * P4: Maestro stage/command → expert pipeline.
   * Keys are normalized stage names (analyze|plan|execute|review|test|debug|…).
   */
  stagePolicies?: Record<string, StagePolicy>;
  /** Optional aliases: raw command/stage → stagePolicies key. */
  stageAliases?: Record<string, string>;
  /**
   * P5.1: orchestrator discipline knobs for the turn reminder.
   */
  orchestrator?: {
    /** stronger run-loop discipline in turn reminder (default true under experts) */
    disciplineReminder?: boolean;
    /** suggest workflow agent as vice-lead for multi-step pipelines (default true) */
    viceLead?: boolean;
  };
  /**
   * P6: project experts roster (role → agent → default taskType → tools).
   * Keys are role ids; values omit id (filled from key) or include id.
   */
  roster?: Record<string, Omit<RosterEntry, "id"> & { id?: string }>;
  /**
   * P7: settle → knowledge harvest policy (suggest-only by default).
   */
  settle?: {
    autoClearWaiting?: boolean;
    /** When false, harvestKnowledgeOnSettle is a no-op. Default true. */
    knowledgeHarvest?: boolean;
    maxSuggestions?: number;
    maxBodyChars?: number;
    /**
     * P7b: when true, deposit harvest suggestions into self-evolve pending
     * suggestions jsonl (never promote; never runs knowledge stage here).
     * Default false.
     */
    autoStage?: boolean;
    /** Optional override for ~/.maestro/self-evolve (tests). */
    selfEvolveOutputRoot?: string;
  };
}

/** P7: one staged-knowhow suggestion harvested from expert settle. */
export interface KnowledgeHarvestSuggestion {
  id: string;
  target: "knowhow" | "spec";
  kind: "pitfall" | "failure-lesson" | "trade-off" | "constraint" | "knowhow";
  title: string;
  content: string;
  fingerprint: string;
  score: number;
  agentId?: string;
  taskType?: string;
  stage?: string;
  sessionId?: string;
  runId?: string;
  evidence: string[];
  at: string;
  source: "experts-settle";
}

export interface KnowledgeStageCommand {
  argv: string[];
  shell: string;
  content: string;
  suggestionId: string;
}

export interface SettleHarvestInput {
  content?: string;
  contents?: string[];
  agentId?: string;
  taskType?: string;
  stage?: string;
  sessionId?: string;
  runId?: string;
  evidenceRefs?: string[];
  titleHint?: string;
  /** Harvest even when mode is normal (tests). */
  force?: boolean;
}

export interface SettleHarvestResult {
  suggestions: KnowledgeHarvestSuggestion[];
  skipped: Array<{ reason: string; preview?: string }>;
  stageCommands: KnowledgeStageCommand[];
  /** Present when rules.settle.autoStage deposited into self-evolve pool. */
  poolDeposit?: {
    written: number;
    skipped: number;
    filePath?: string;
    ids: string[];
  };
}
