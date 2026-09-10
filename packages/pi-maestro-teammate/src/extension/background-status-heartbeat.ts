export const BACKGROUND_STATUS_HEARTBEAT_MS = 4 * 60_000;

export interface BackgroundStatusTeammate {
  id: string;
  label: string;
  status: string;
  phase?: string;
  lastActivityAt?: number;
}

export interface BackgroundStatusBashJob {
  id: string;
  command: string;
  status: "running" | "stopping";
  startedAt: number;
}

export interface BackgroundStatusSnapshot {
  teammates: BackgroundStatusTeammate[];
  bashJobs: BackgroundStatusBashJob[];
}

export interface BackgroundStatusHeartbeatMessage {
  content: string;
  details: {
    monitoringOnly: true;
    completion: false;
    observedAt: number;
    teammateIds: string[];
    bashJobIds: string[];
  };
}

interface BackgroundStatusHeartbeatScheduler {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface BackgroundStatusHeartbeatOptions {
  capture: () => BackgroundStatusSnapshot;
  deliver: (message: BackgroundStatusHeartbeatMessage) => boolean;
  intervalMs?: number;
  now?: () => number;
  scheduler?: BackgroundStatusHeartbeatScheduler;
}

export interface BackgroundStatusHeartbeatController {
  markSessionActive: () => void;
  markSessionSettled: () => void;
  refresh: () => void;
  reset: () => void;
}

const ACTIVE_TEAMMATE_STATUSES = new Set(["pending", "running", "retrying"]);
const MAX_STATUS_ROWS = 6;

function oneLine(value: string, maxLength = 120): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function activeSnapshot(snapshot: BackgroundStatusSnapshot): BackgroundStatusSnapshot {
  return {
    teammates: snapshot.teammates.filter((agent) => ACTIVE_TEAMMATE_STATUSES.has(agent.status)),
    bashJobs: snapshot.bashJobs.filter((job) => job.status === "running" || job.status === "stopping"),
  };
}

function hasBackgroundWork(snapshot: BackgroundStatusSnapshot): boolean {
  return snapshot.teammates.length > 0 || snapshot.bashJobs.length > 0;
}

function formatAge(lastActivityAt: number | undefined, observedAt: number): string {
  if (lastActivityAt === undefined || !Number.isFinite(lastActivityAt)) return "";
  return ` · activity ${Math.max(0, Math.round((observedAt - lastActivityAt) / 1000))}s ago`;
}

export function buildBackgroundStatusHeartbeatMessage(
  input: BackgroundStatusSnapshot,
  observedAt = Date.now(),
): BackgroundStatusHeartbeatMessage {
  const snapshot = activeSnapshot(input);
  const rows = [
    ...snapshot.teammates.map((agent) =>
      `- teammate @${oneLine(agent.label, 64)}: ${oneLine(agent.status, 24)}${agent.phase ? ` / ${oneLine(agent.phase, 40)}` : ""}${formatAge(agent.lastActivityAt, observedAt)}`
    ),
    ...snapshot.bashJobs.map((job) =>
      `- bash_bg ${oneLine(job.id, 64)}: ${job.status} · ${oneLine(job.command)}`
    ),
  ];
  const visibleRows = rows.slice(0, MAX_STATUS_ROWS);
  if (rows.length > visibleRows.length) visibleRows.push(`- … ${rows.length - visibleRows.length} more active background item(s)`);

  return {
    content: [
      "[background-status-monitor] Periodic background status heartbeat — NOT a task completion notification.",
      `Active background work: ${snapshot.teammates.length} teammate(s), ${snapshot.bashJobs.length} bash_bg job(s).`,
      ...visibleRows,
      "Monitoring only: no task was completed by this heartbeat. Wait for teammate-complete or bash-bg-complete before reporting completion.",
    ].join("\n"),
    details: {
      monitoringOnly: true,
      completion: false,
      observedAt,
      teammateIds: snapshot.teammates.map((agent) => agent.id),
      bashJobIds: snapshot.bashJobs.map((job) => job.id),
    },
  };
}

export function createBackgroundStatusHeartbeat(
  options: BackgroundStatusHeartbeatOptions,
): BackgroundStatusHeartbeatController {
  const intervalMs = options.intervalMs ?? BACKGROUND_STATUS_HEARTBEAT_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Background status heartbeat interval must be positive.");
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
  };

  let settled = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (timer === undefined) return;
    scheduler.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    if (!settled || timer !== undefined) return;
    const snapshot = activeSnapshot(options.capture());
    if (!hasBackgroundWork(snapshot)) return;
    const owner = generation;
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      if (!settled || owner !== generation) return;
      const current = activeSnapshot(options.capture());
      if (!hasBackgroundWork(current)) return;
      const delivered = options.deliver(buildBackgroundStatusHeartbeatMessage(current, now()));
      if (delivered) {
        settled = false;
        return;
      }
      schedule();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    markSessionActive(): void {
      settled = false;
      cancel();
    },
    markSessionSettled(): void {
      settled = true;
      schedule();
    },
    refresh(): void {
      if (!settled) return;
      const snapshot = activeSnapshot(options.capture());
      if (!hasBackgroundWork(snapshot)) {
        cancel();
        return;
      }
      schedule();
    },
    reset(): void {
      generation += 1;
      settled = false;
      cancel();
    },
  };
}
