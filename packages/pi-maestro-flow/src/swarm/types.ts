import type { AgentProgressStatus } from "pi-maestro-teammate/v1/types";
import type { TeammateTaskType } from "pi-maestro-teammate/v1/model-routing";

export const SWARM_SCHEMA_VERSION = "2.1";
export const SWARM_PLAN_LIMITS = {
  dimensions: { min: 4, max: 8 },
  rubric: { min: 3, max: 8 },
} as const;

export type SwarmRunStatus =
  | "preparing"
  | "running"
  | "converged"
  | "synthesizing"
  | "completed"
  | "cancelled"
  | "failed";

export interface SwarmConfig {
  nAnts: number;
  maxIterations: number;
  maxPathLength: number;
  concurrency: number;
  alpha: number;
  beta: number;
  evaporation: number;
  deposit: number;
  eliteWeight: number;
  tauInitial: number;
  tauMin: number;
  tauMax: number;
  targetScore: number;
  entropyFloor: number;
  stagnationPatience: number;
  minDelta: number;
}

export interface SwarmNode {
  id: string;
  label: string;
  description: string;
  pheromone: number;
  visits: number;
  bestScore: number;
}

export interface SwarmEdge {
  id: string;
  source: string;
  target: string;
  pheromone: number;
  probability: number;
  visits: number;
  bestScore: number;
}

export interface SwarmAssignment {
  antId: string;
  iteration: number;
  startNode: string;
  edgePreferences: Record<string, number>;
  maxPathLength: number;
  /** Pheromone-guided suggestion. Ants may deviate when evidence supports it. */
  path: string[];
}

export interface SwarmDimensionPlan {
  id: string;
  label: string;
  description: string;
}

export interface SwarmAntPlan {
  taskType: TeammateTaskType;
  mission: string;
  prompt: string;
  evidenceRequirements: string[];
  constraints: string[];
  outputExpectation: string;
}

export interface SwarmScoringDimensionPlan {
  id: string;
  label: string;
  weight: number;
  description: string;
}

export interface SwarmScoringPlan {
  rubric: SwarmScoringDimensionPlan[];
  instructions: string[];
}

export interface SwarmSynthesisPlan {
  requirements: string[];
}

export interface SwarmRolePlan {
  id: string;
  stage: "judge" | "analyst";
  agent: string;
  taskType: TeammateTaskType;
  mission: string;
  prompt: string;
}

export interface SwarmExecutionPlan {
  rationale: string;
  dimensions: SwarmDimensionPlan[];
  roles: SwarmRolePlan[];
  ant: SwarmAntPlan;
  scoring: SwarmScoringPlan;
  synthesis: SwarmSynthesisPlan;
}

export interface SwarmEvidence {
  ref: string;
  claim: string;
}

export interface SwarmCandidate {
  summary: string;
  details: string;
  actions: string[];
  risks: string[];
}

export interface SwarmPathDecision {
  from: string;
  to: string;
  rationale: string;
  guidedBy: "pheromone" | "heuristic" | "evidence";
  pheromoneWeight?: number;
  deviatedFromSuggestion: boolean;
}

export interface SwarmAntOutput {
  path: string[];
  pathDecisions: SwarmPathDecision[];
  findings: string[];
  evidence: SwarmEvidence[];
  candidate: SwarmCandidate;
  selfScore: number;
  confidence: number;
}

export interface SwarmAgentSnapshot {
  antId: string;
  iteration: number;
  path: string[];
  role?: string;
  stage?: "explore" | "score" | "synthesize";
  status: AgentProgressStatus;
  correlationId?: string;
  tokens: number;
  toolCount: number;
  durationMs: number;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  completionSignal?: "structured_output" | "agent_end" | "process_exit";
  lastMessage?: string;
  recentTools?: Array<{ name: string; status: string }>;
  nativeScore?: number;
  verifiedScore?: number;
  score?: number;
  scoreSource?: "verified" | "native";
  hallucinationFlag?: boolean;
  hallucinationPenalty?: number;
  output?: SwarmAntOutput;
  error?: string;
}

export type SwarmPreparationStepId = "contract" | "roles" | "prompt" | "graph";
export type SwarmPreparationStepStatus = "pending" | "running" | "completed" | "failed";

export interface SwarmPreparationStep {
  id: SwarmPreparationStepId;
  label: string;
  status: SwarmPreparationStepStatus;
  detail: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface SwarmPreparedRole {
  id: string;
  stage: "ant" | "judge" | "analyst";
  agent: string;
  taskType: TeammateTaskType;
  mission: string;
  prompt: string;
  description: string;
  source: "builtin" | "user" | "project";
  systemPromptMode: "append" | "replace";
  rolePromptHash: string;
  rolePromptChars: number;
  promptChars: number;
  promptHash: string;
  layers: string[];
}

export interface SwarmPreparationState {
  status: "pending" | "running" | "ready" | "failed";
  steps: SwarmPreparationStep[];
  roles: SwarmPreparedRole[];
}

export type SwarmStreamKind =
  | "skill"
  | "preparation"
  | "status"
  | "assistant"
  | "tool"
  | "artifact"
  | "convergence"
  | "metric"
  | "system";

export interface SwarmStreamEntry {
  sequence: number;
  timestamp: string;
  kind: SwarmStreamKind;
  text: string;
  iteration?: number;
  agentId?: string;
  complete?: boolean;
}

export interface SwarmMetricPoint {
  iteration: number;
  bestScore: number;
  meanScore: number;
  scoreDelta: number;
  entropy: number;
  diversity: number;
  consensus: number;
  convergence: number;
  successRate: number;
  totalTokens: number;
  durationMs: number;
}

export interface SwarmIterationArtifact {
  iteration: number;
  startedAt: string;
  completedAt: string;
  assignments: SwarmAssignment[];
  agents: SwarmAgentSnapshot[];
  metrics: SwarmMetricPoint;
  bestAntId?: string;
}

export interface SwarmBestSolution {
  antId: string;
  iteration: number;
  score: number;
  path: string[];
  candidate: SwarmCandidate;
  evidence: SwarmEvidence[];
}

export interface SwarmSynthesis {
  summary: string;
  recommendation: string;
  actions: string[];
  risks: string[];
  evidence: string[];
}

export interface SwarmFeedbackEntry {
  timestamp: string;
  text: string;
  appliesFromIteration: number;
}

export interface SwarmConvergenceState {
  converged: boolean;
  triggeredBy: string[];
  reason: string;
}

export interface SwarmRunArtifact {
  schemaVersion: typeof SWARM_SCHEMA_VERSION;
  runId: string;
  objective: string;
  status: SwarmRunStatus;
  config: SwarmConfig;
  plan?: SwarmExecutionPlan;
  skill: {
    name: "swarm";
    status: "activating" | "planning" | "executing" | "completed" | "failed";
    phase: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  artifactDir: string;
  graph: {
    nodes: SwarmNode[];
    edges: SwarmEdge[];
  };
  currentIteration: number;
  metrics: SwarmMetricPoint[];
  iterations: SwarmIterationArtifact[];
  activeAgents: SwarmAgentSnapshot[];
  stageAgents: SwarmAgentSnapshot[];
  preparation: SwarmPreparationState;
  stream: SwarmStreamEntry[];
  best?: SwarmBestSolution;
  convergence: SwarmConvergenceState;
  synthesis?: SwarmSynthesis;
  feedback: SwarmFeedbackEntry[];
  resumeCount: number;
  resumedFromStatus?: SwarmRunStatus;
  error?: string;
}

export interface SwarmEvent {
  schemaVersion: typeof SWARM_SCHEMA_VERSION;
  sequence: number;
  timestamp: string;
  runId: string;
  type:
    | "skill_activated"
    | "skill_phase"
    | "plan_compiled"
    | "role_bound"
    | "prompt_compiled"
    | "run_started"
    | "run_resumed"
    | "feedback_received"
    | "preparation_step"
    | "iteration_started"
    | "agent_status"
    | "teammate_delta"
    | "tool_delta"
    | "metric_observed"
    | "hallucination_cluster"
    | "iteration_completed"
    | "convergence_decision"
    | "convergence_detected"
    | "artifact_produced"
    | "synthesis_started"
    | "run_completed"
    | "run_cancelled"
    | "run_failed";
  iteration?: number;
  antId?: string;
  data?: Record<string, unknown>;
}

export const DEFAULT_SWARM_CONFIG: SwarmConfig = {
  nAnts: 4,
  maxIterations: 4,
  maxPathLength: 4,
  concurrency: 4,
  alpha: 1,
  beta: 2,
  evaporation: 0.2,
  deposit: 1,
  eliteWeight: 1.5,
  tauInitial: 1,
  tauMin: 0.05,
  tauMax: 10,
  targetScore: 0.9,
  entropyFloor: 0.35,
  stagnationPatience: 2,
  minDelta: 0.015,
};

export const DEFAULT_SWARM_DIMENSIONS: ReadonlyArray<Pick<SwarmNode, "id" | "label" | "description">> = [
  { id: "scope", label: "Scope", description: "Clarify boundaries, constraints, and acceptance criteria" },
  { id: "architecture", label: "Architecture", description: "Trace components, dependencies, and integration seams" },
  { id: "implementation", label: "Implementation", description: "Develop concrete mechanisms and minimal changes" },
  { id: "verification", label: "Verification", description: "Find evidence, tests, and falsifiable checks" },
  { id: "risk", label: "Risk", description: "Challenge assumptions, failure modes, and regressions" },
  { id: "experience", label: "Experience", description: "Evaluate user workflow, observability, and ergonomics" },
];
