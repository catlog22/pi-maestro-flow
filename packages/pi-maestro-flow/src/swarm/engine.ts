import {
  DEFAULT_SWARM_DIMENSIONS,
  type SwarmAgentSnapshot,
  type SwarmAntOutput,
  type SwarmAssignment,
  type SwarmBestSolution,
  type SwarmConfig,
  type SwarmConvergenceState,
  type SwarmEdge,
  type SwarmMetricPoint,
  type SwarmNode,
  type SwarmDimensionPlan,
} from "./types.ts";

export interface SwarmGraphState {
  nodes: SwarmNode[];
  edges: SwarmEdge[];
}

export function createSwarmGraph(
  config: SwarmConfig,
  dimensions: readonly SwarmDimensionPlan[] = DEFAULT_SWARM_DIMENSIONS,
): SwarmGraphState {
  const nodes = dimensions.map((node) => ({
    ...node,
    pheromone: config.tauInitial,
    visits: 0,
    bestScore: 0,
  }));
  const edges: SwarmEdge[] = [];
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      const source = nodes[left]!.id;
      const target = nodes[right]!.id;
      edges.push({
        id: edgeId(source, target),
        source,
        target,
        pheromone: config.tauInitial,
        probability: 0,
        visits: 0,
        bestScore: 0,
      });
    }
  }
  refreshProbabilities(edges, nodes, config);
  return { nodes, edges };
}

export function selectAssignments(
  graph: SwarmGraphState,
  config: SwarmConfig,
  runId: string,
  iteration: number,
): SwarmAssignment[] {
  const rng = seededRandom(`${runId}:${iteration}`);
  const assignments: SwarmAssignment[] = [];
  const nodeIds = graph.nodes.map((node) => node.id);
  for (let index = 0; index < config.nAnts; index++) {
    const start = nodeIds[(index + iteration - 1) % nodeIds.length]!;
    const path = [start];
    while (path.length < Math.min(config.maxPathLength, nodeIds.length)) {
      const candidates = nodeIds.filter((node) => !path.includes(node));
      if (candidates.length === 0) break;
      const current = path[path.length - 1]!;
      const next = weightedChoice(candidates, (candidate) => {
        const edge = graph.edges.find((item) => item.id === edgeId(current, candidate));
        const novelty = 1 / (1 + (edge?.visits ?? 0));
        return Math.pow(edge?.pheromone ?? config.tauInitial, config.alpha)
          * Math.pow(1 + novelty, config.beta);
      }, rng);
      path.push(next);
    }
    const edgePreferences = Object.fromEntries(graph.edges.map((edge) => [
      edge.id,
      round4(clamp01(edge.pheromone / Math.max(config.tauMax, config.tauInitial))),
    ]));
    assignments.push({
      antId: `ANT-${iteration}-${index + 1}`,
      iteration,
      startNode: start,
      edgePreferences,
      maxPathLength: Math.min(config.maxPathLength, nodeIds.length),
      path,
    });
  }
  return assignments;
}

export function scoreAntOutput(output: SwarmAntOutput | undefined, assignment: SwarmAssignment, succeeded: boolean): number {
  if (!succeeded || !output) return 0;
  const evidence = clamp01(output.evidence.length / Math.max(2, output.path.length));
  const findings = clamp01(output.findings.length / Math.max(2, output.path.length));
  const candidate = clamp01((output.candidate.summary.length + output.candidate.details.length) / 900);
  const decisions = output.path.length <= 1
    ? 1
    : clamp01(output.pathDecisions.filter((decision) => decision.rationale.trim().length > 0).length / (output.path.length - 1));
  const selfCalibration = clamp01(output.selfScore) * clamp01(output.confidence);
  const startsCorrectly = output.path[0] === assignment.startNode ? 1 : 0;
  return round4(
    evidence * 0.25
    + findings * 0.2
    + candidate * 0.2
    + decisions * 0.15
    + selfCalibration * 0.15
    + startsCorrectly * 0.05,
  );
}

export function mergeVerifiedScores(
  agents: SwarmAgentSnapshot[],
  verified: ReadonlyMap<string, number>,
  hallucinationPenalty = 0.5,
): SwarmAgentSnapshot[] {
  return agents.map((agent) => {
    const nativeScore = clamp01(agent.nativeScore ?? 0);
    const judgeScore = verified.get(agent.antId);
    const hallucinationFlag = agent.output
      ? Math.abs(clamp01(agent.output.selfScore) - (judgeScore ?? nativeScore)) > 0.4
      : false;
    const penalty = judgeScore != null && hallucinationFlag ? clamp01(hallucinationPenalty) : 1;
    const score = judgeScore == null ? nativeScore : round4(clamp01(judgeScore) * penalty);
    return {
      ...agent,
      ...(judgeScore == null ? {} : { verifiedScore: clamp01(judgeScore) }),
      score,
      scoreSource: judgeScore == null ? "native" : "verified",
      hallucinationFlag,
      ...(penalty < 1 ? { hallucinationPenalty: penalty } : {}),
    };
  });
}

export function updatePheromones(
  graph: SwarmGraphState,
  agents: SwarmAgentSnapshot[],
  config: SwarmConfig,
  historicalBest?: SwarmBestSolution,
): void {
  for (const edge of graph.edges) edge.pheromone = clamp(edge.pheromone * (1 - config.evaporation), config.tauMin, config.tauMax);
  for (const node of graph.nodes) node.pheromone = clamp(node.pheromone * (1 - config.evaporation), config.tauMin, config.tauMax);

  const ranked = agents.filter((agent) => (agent.score ?? 0) > 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const agent of ranked) {
    const score = agent.score ?? 0;
    for (const nodeId of agent.path) {
      const node = graph.nodes.find((item) => item.id === nodeId);
      if (!node) continue;
      node.visits++;
      node.bestScore = Math.max(node.bestScore, score);
      node.pheromone = clamp(node.pheromone + config.deposit * score * 0.5, config.tauMin, config.tauMax);
    }
    for (let index = 0; index < agent.path.length - 1; index++) {
      const edge = graph.edges.find((item) => item.id === edgeId(agent.path[index]!, agent.path[index + 1]!));
      if (!edge) continue;
      edge.visits++;
      edge.bestScore = Math.max(edge.bestScore, score);
      edge.pheromone = clamp(edge.pheromone + config.deposit * score, config.tauMin, config.tauMax);
    }
  }

  const currentElite = ranked[0];
  const elite = historicalBest && historicalBest.score > (currentElite?.score ?? 0)
    ? { path: historicalBest.path, score: historicalBest.score }
    : currentElite;
  if (elite) {
    for (let index = 0; index < elite.path.length - 1; index++) {
      const edge = graph.edges.find((item) => item.id === edgeId(elite.path[index]!, elite.path[index + 1]!));
      if (edge) edge.pheromone = clamp(
        edge.pheromone + config.deposit * (elite.score ?? 0) * config.eliteWeight,
        config.tauMin,
        config.tauMax,
      );
    }
  }
  refreshProbabilities(graph.edges, graph.nodes, config);
}

export function calculateMetrics(
  iteration: number,
  graph: SwarmGraphState,
  agents: SwarmAgentSnapshot[],
  previous: SwarmMetricPoint | undefined,
  durationMs: number,
): SwarmMetricPoint {
  const successful = agents.filter((agent) => agent.status === "completed" && (agent.score ?? 0) > 0);
  const scores = successful.map((agent) => agent.score ?? 0);
  const bestScore = scores.length ? Math.max(...scores) : 0;
  const meanScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  const variance = scores.length
    ? scores.reduce((sum, score) => sum + Math.pow(score - meanScore, 2), 0) / scores.length
    : 1;
  const consensus = clamp01(1 - Math.sqrt(variance));
  const entropy = normalizedEntropy(graph.edges.map((edge) => edge.pheromone));
  const visitedEdges = new Set(successful.flatMap((agent) => pathEdges(agent.path)));
  const diversity = clamp01(visitedEdges.size / Math.max(1, graph.edges.length));
  const convergence = clamp01(bestScore * 0.45 + consensus * 0.25 + (1 - entropy) * 0.2 + (1 - diversity) * 0.1);
  return {
    iteration,
    bestScore: round4(bestScore),
    meanScore: round4(meanScore),
    scoreDelta: round4(bestScore - (previous?.bestScore ?? 0)),
    entropy: round4(entropy),
    diversity: round4(diversity),
    consensus: round4(consensus),
    convergence: round4(convergence),
    successRate: round4(successful.length / Math.max(1, agents.length)),
    totalTokens: agents.reduce((sum, agent) => sum + agent.tokens, 0),
    durationMs,
  };
}

export function detectConvergence(metrics: SwarmMetricPoint[], config: SwarmConfig): SwarmConvergenceState {
  const current = metrics[metrics.length - 1];
  if (!current) return { converged: false, triggeredBy: [], reason: "waiting for the first iteration" };
  const triggeredBy: string[] = [];
  if (current.iteration >= config.maxIterations) triggeredBy.push("max_iterations");
  if (current.bestScore >= config.targetScore) triggeredBy.push("target_score");
  if (current.iteration >= 2 && current.entropy <= config.entropyFloor) triggeredBy.push("entropy_floor");
  if (current.iteration >= 2 && current.consensus >= 0.94 && current.bestScore >= 0.75) triggeredBy.push("consensus");
  if (metrics.length > config.stagnationPatience) {
    const window = metrics.slice(-(config.stagnationPatience + 1));
    const improvement = Math.max(...window.map((point) => point.bestScore)) - Math.min(...window.map((point) => point.bestScore));
    if (improvement < config.minDelta) triggeredBy.push("stagnation");
  }
  const convergenceSignals = triggeredBy.filter((signal) => signal !== "max_iterations");
  if (convergenceSignals.length > 0) return {
    converged: true,
    triggeredBy,
    reason: `converged by ${convergenceSignals.join(", ")}`,
  };
  if (triggeredBy.includes("max_iterations")) return {
    converged: true,
    triggeredBy,
    reason: "stopped at max iterations",
  };
  return { converged: false, triggeredBy: [], reason: "exploration remains productive" };
}

export function bestSolutionFromAgents(agents: SwarmAgentSnapshot[], previous?: SwarmBestSolution): SwarmBestSolution | undefined {
  const ranked = agents
    .filter((agent) => agent.output && (agent.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0];
  if (!best?.output) return previous;
  if (previous && previous.score >= (best.score ?? 0)) return previous;
  return {
    antId: best.antId,
    iteration: best.iteration,
    score: best.score ?? 0,
    path: best.path,
    candidate: best.output.candidate,
    evidence: best.output.evidence,
  };
}

export function edgeId(left: string, right: string): string {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

function pathEdges(path: string[]): string[] {
  const edges: string[] = [];
  for (let index = 0; index < path.length - 1; index++) edges.push(edgeId(path[index]!, path[index + 1]!));
  return edges;
}

function refreshProbabilities(edges: SwarmEdge[], nodes: SwarmNode[], config: SwarmConfig): void {
  for (const edge of edges) {
    const outgoing = edges.filter((candidate) => candidate.source === edge.source || candidate.target === edge.source);
    const total = outgoing.reduce((sum, candidate) => sum + Math.pow(candidate.pheromone, config.alpha), 0);
    edge.probability = total > 0 ? round4(Math.pow(edge.pheromone, config.alpha) / total) : 0;
  }
  for (const node of nodes) {
    node.pheromone = clamp(node.pheromone, config.tauMin, config.tauMax);
  }
}

function normalizedEntropy(values: number[]): number {
  if (values.length <= 1) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const value of values) {
    const probability = value / total;
    if (probability > 0) entropy -= probability * Math.log2(probability);
  }
  return clamp01(entropy / Math.log2(values.length));
}

function weightedChoice(candidates: string[], weight: (candidate: string) => number, rng: () => number): string {
  const weights = candidates.map((candidate) => Math.max(0, weight(candidate)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return candidates[Math.floor(rng() * candidates.length)]!;
  let threshold = rng() * total;
  for (let index = 0; index < candidates.length; index++) {
    threshold -= weights[index]!;
    if (threshold <= 0) return candidates[index]!;
  }
  return candidates[candidates.length - 1]!;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
