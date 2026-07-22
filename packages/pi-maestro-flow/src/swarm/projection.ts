import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type TeamSwarmDisplayStatus = "active" | "paused" | "converging" | "completed" | "failed" | "unknown";

export interface TeamSwarmMetric {
  iteration: number;
  bestScore?: number;
  meanScore?: number;
  entropy?: number;
  tauMax?: number;
  tauMean?: number;
}

export interface TeamSwarmEdge {
  source: string;
  target: string;
  pheromone: number;
}

export interface TeamSwarmBest {
  antId: string;
  iteration: number;
  score: number;
  path: string[];
  summary?: string;
  evidence: string[];
}

export interface TeamSwarmProjection {
  source: "team-swarm-json";
  teamDir: string;
  runDir: string;
  outputsDir: string;
  sessionId: string;
  objective: string;
  status: TeamSwarmDisplayStatus;
  iteration: number;
  maxIterations: number;
  antsPerIteration: number;
  activeWorkers: string[];
  completedIterations: number[];
  nodes: string[];
  edges: TeamSwarmEdge[];
  metrics: TeamSwarmMetric[];
  best?: TeamSwarmBest;
  reportPath?: string;
  bestSolutionPath?: string;
  updatedAt: string;
}

export function loadLatestTeamSwarmProjection(baseCwd: string): TeamSwarmProjection | undefined {
  const candidates = findTeamDirs(resolve(baseCwd, ".workflow", "sessions"));
  for (const teamDir of candidates) {
    const projection = loadTeamSwarmProjection(teamDir);
    if (projection) return projection;
  }
  return undefined;
}

export function loadTeamSwarmProjection(teamDir: string): TeamSwarmProjection | undefined {
  const sessionPath = join(teamDir, "team-session.json");
  if (!existsSync(sessionPath)) return undefined;
  const session = readObject(sessionPath);
  if (!session || stringValue(session.skill) !== "team-swarm") return undefined;

  const runDir = dirname(dirname(teamDir));
  const outputsDir = join(runDir, "outputs");
  const config = readObject(join(teamDir, "swarm-config.json")) ?? {};
  const taskSpace = readObject(join(teamDir, "task-space.json")) ?? {};
  const pheromone = readObject(join(teamDir, "pheromone", "current.json")) ?? {};
  const bestObject = readObject(join(teamDir, "best.json"));
  const reportPath = firstExisting(join(outputsDir, "swarm-report.json"), join(teamDir, "artifacts", "swarm-report.json"));
  const report = reportPath ? readObject(reportPath) : undefined;
  const bestSolutionPath = firstExisting(join(outputsDir, "best-solution.md"), join(teamDir, "artifacts", "best-solution.md"));
  const iteration = integerValue(pheromone.iteration) ?? integerValue(session.iteration) ?? 0;
  const maxIterations = integerValue(session.max_iterations)
    ?? integerAt(config, "convergence", "max_iterations")
    ?? integerAt(config, "swarm", "max_iterations")
    ?? 0;

  return {
    source: "team-swarm-json",
    teamDir,
    runDir,
    outputsDir,
    sessionId: stringValue(session.session_id) ?? basename(runDir),
    objective: stringValue(session.task_description) ?? stringAt(config, "ant_prompt", "objective") ?? "team-swarm",
    status: normalizeStatus(session.status, report),
    iteration,
    maxIterations,
    antsPerIteration: integerValue(session.n_ants_per_iter) ?? integerAt(config, "swarm", "n_ants") ?? 0,
    activeWorkers: stringArray(session.active_workers),
    completedIterations: numberArray(session.completed_iterations),
    nodes: stringArray(taskSpace.nodes),
    edges: readEdges(pheromone.tau),
    metrics: readMetrics(teamDir),
    best: normalizeBest(bestObject ?? recordValue(report?.best)),
    ...(reportPath ? { reportPath } : {}),
    ...(bestSolutionPath ? { bestSolutionPath } : {}),
    updatedAt: new Date(statSync(sessionPath).mtimeMs).toISOString(),
  };
}

function findTeamDirs(sessionsRoot: string): string[] {
  if (!existsSync(sessionsRoot)) return [];
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const session of safeDirectories(sessionsRoot)) {
    const runsRoot = join(sessionsRoot, session, "runs");
    for (const run of safeDirectories(runsRoot)) {
      const teamDir = join(runsRoot, run, "work", "team");
      const state = join(teamDir, "team-session.json");
      if (!existsSync(state)) continue;
      try { candidates.push({ path: teamDir, mtime: statSync(state).mtimeMs }); } catch { /* ignore partial runs */ }
    }
  }
  return candidates.sort((left, right) => right.mtime - left.mtime).map((item) => item.path);
}

function readMetrics(teamDir: string): TeamSwarmMetric[] {
  const trailsDir = join(teamDir, "trails");
  const historyDir = join(teamDir, "pheromone", "history");
  const iterations = new Set<number>();
  for (const file of safeFiles(trailsDir, ".jsonl")) {
    const iteration = Number.parseInt(file.replace(/\.jsonl$/i, ""), 10);
    if (Number.isInteger(iteration)) iterations.add(iteration);
  }
  for (const file of safeFiles(historyDir, ".json")) {
    const iteration = Number.parseInt(file.replace(/\.json$/i, ""), 10);
    if (Number.isInteger(iteration)) iterations.add(iteration);
  }
  return [...iterations].sort((a, b) => a - b).map((iteration) => {
    const scores = readJsonLines(join(trailsDir, `${iteration}.jsonl`))
      .map((item) => numberValue(item.verified_score))
      .filter((value): value is number => value !== undefined);
    const history = readObject(join(historyDir, `${iteration}.json`));
    const stats = recordValue(history?.stats);
    return {
      iteration,
      ...(scores.length ? { bestScore: Math.max(...scores), meanScore: scores.reduce((sum, value) => sum + value, 0) / scores.length } : {}),
      ...(numberValue(stats?.entropy) !== undefined ? { entropy: numberValue(stats?.entropy) } : {}),
      ...(numberValue(stats?.max) !== undefined ? { tauMax: numberValue(stats?.max) } : {}),
      ...(numberValue(stats?.mean) !== undefined ? { tauMean: numberValue(stats?.mean) } : {}),
    };
  });
}

function normalizeBest(value: Record<string, unknown> | undefined): TeamSwarmBest | undefined {
  if (!value) return undefined;
  const antId = stringValue(value.ant_id);
  const iteration = integerValue(value.iteration);
  const score = numberValue(value.score);
  if (!antId || iteration === undefined || score === undefined) return undefined;
  return {
    antId,
    iteration,
    score,
    path: stringArray(value.path),
    summary: stringValue(recordValue(value.candidate_solution)?.summary),
    evidence: stringArray(value.evidence),
  };
}

function normalizeStatus(value: unknown, report: Record<string, unknown> | undefined): TeamSwarmDisplayStatus {
  if (report) return "completed";
  const status = stringValue(value)?.toLowerCase();
  if (status === "active" || status === "paused" || status === "converging" || status === "completed" || status === "failed") return status;
  return "unknown";
}

function readEdges(value: unknown): TeamSwarmEdge[] {
  const tau = recordValue(value);
  if (!tau) return [];
  return Object.entries(tau).flatMap(([key, raw]) => {
    const separator = key.indexOf("::");
    const pheromone = numberValue(raw);
    return separator > 0 && pheromone !== undefined
      ? [{ source: key.slice(0, separator), target: key.slice(separator + 2), pheromone }]
      : [];
  });
}

function readObject(path: string): Record<string, unknown> | undefined {
  try { return recordValue(JSON.parse(readFileSync(path, "utf8"))); } catch { return undefined; }
}

function readJsonLines(path: string): Record<string, unknown>[] {
  try { return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { const value = recordValue(JSON.parse(line)); return value ? [value] : []; } catch { return []; } }); }
  catch { return []; }
}

function safeDirectories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); } catch { return []; }
}

function safeFiles(path: string, extension: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith(extension)).map((item) => item.name); } catch { return []; }
}

function firstExisting(...paths: string[]): string | undefined { return paths.find((path) => existsSync(path)); }
function recordValue(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function integerValue(value: unknown): number | undefined { const number = numberValue(value); return number !== undefined && Number.isInteger(number) ? number : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => stringValue(item) ? [stringValue(item)!] : recordValue(item) && stringValue(recordValue(item)?.name) ? [stringValue(recordValue(item)?.name)!] : []) : []; }
function numberArray(value: unknown): number[] { return Array.isArray(value) ? value.flatMap((item) => integerValue(item) === undefined ? [] : [integerValue(item)!]) : []; }
function nested(value: Record<string, unknown>, first: string, second: string): unknown { return recordValue(value[first])?.[second]; }
function integerAt(value: Record<string, unknown>, first: string, second: string): number | undefined { return integerValue(nested(value, first, second)); }
function stringAt(value: Record<string, unknown>, first: string, second: string): string | undefined { return stringValue(nested(value, first, second)); }
