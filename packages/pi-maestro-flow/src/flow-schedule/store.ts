import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizeFlowSchedule,
  parseFlowScheduleAcceptedRecord,
  parseFlowScheduleAction,
  parseFlowScheduleCompletionRecord,
  parseFlowScheduleDispatch,
  parseFlowScheduleLockOwner,
  parseFlowScheduleOwnerMarker,
  parseFlowSchedulePublishedRecord,
  parseFlowScheduleRecord,
  parseFlowScheduleTodoBinding,
} from "./schemas.ts";
import {
  FLOW_SCHEDULE_DISPATCH_ID_PATTERN,
  FLOW_SCHEDULE_ID_PATTERN,
  FLOW_SCHEDULE_LIMITS,
  FLOW_SCHEDULE_STORE_TYPE,
  FLOW_SCHEDULE_VERSION,
  isTerminalScheduleState,
  isTerminalBindingState,
  type ExactWindowIdentity,
  type FlowScheduleAcceptedRecord,
  type FlowScheduleCompletionRecord,
  type FlowScheduleCreateInput,
  type FlowScheduleCreateStepInput,
  type FlowScheduleDispatch,
  type FlowScheduleDispatchIntentInput,
  type FlowScheduleLegacyStatus,
  type FlowScheduleLockOwner,
  type FlowScheduleOwnerMarker,
  type FlowSchedulePublishedRecord,
  type FlowScheduleRecord,
  type FlowScheduleTodoBinding,
} from "./types.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STORE_LOCK_NAME = "store.lock";
const OWNER_FILE_NAME = "owner.json";
const SCHEDULE_FILE_SUFFIX = ".json";
const INTENT_FILE_NAME = "intent.json";
const PUBLISHED_FILE_NAME = "published.json";
const ACCEPTED_FILE_NAME = "accepted.json";
const COMPLETION_FILE_NAME = "completion.json";
const BINDING_FILE_NAME = "binding.json";

export interface FlowScheduleStoreOptions {
  rootDir?: string;
  now?: () => number;
  createId?: () => string;
  lockStaleMs?: number;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  lockHeartbeatMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: (pid: number) => string | null | Promise<string | null>;
}

export interface FlowScheduleStoreLock {
  readonly token: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface FlowScheduleDispatchIntentOutcome {
  created: boolean;
  dispatch: FlowScheduleDispatch;
  schedule: FlowScheduleRecord;
}

export type FlowSchedulePrePersist = (projection: FlowScheduleRecord) => void | Promise<void>;

export interface FlowScheduleDispatchBundle {
  intent: FlowScheduleDispatch;
  published?: FlowSchedulePublishedRecord;
  accepted?: FlowScheduleAcceptedRecord;
  completion?: FlowScheduleCompletionRecord;
  binding?: FlowScheduleTodoBinding;
}

export interface FlowScheduleGcOptions {
  now?: number;
  retentionMs?: number;
  maxSchedules?: number;
}

export interface FlowScheduleGcResult {
  deletedScheduleIds: string[];
  deletedDispatchIds: string[];
}

export class FlowScheduleStoreError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${message}: ${path}` : message);
    this.name = "FlowScheduleStoreError";
  }
}

export class FlowScheduleCorruptionError extends FlowScheduleStoreError {
  constructor(path: string, detail: string) {
    super(`Flow schedule storage is corrupt (${detail})`, path);
    this.name = "FlowScheduleCorruptionError";
  }
}

export class FlowScheduleConflictError extends FlowScheduleStoreError {
  constructor(message: string, path?: string) {
    super(message, path);
    this.name = "FlowScheduleConflictError";
  }
}

export class FlowScheduleLockLostError extends FlowScheduleStoreError {
  constructor(path: string) {
    super("Flow schedule store lock ownership was lost", path);
    this.name = "FlowScheduleLockLostError";
  }
}

export function createFlowScheduleDispatchId(createId: () => string = randomUUID): string {
  const value = createId().toLowerCase();
  if (!FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(value)) {
    throw new FlowScheduleStoreError("Flow schedule ID source did not produce a UUID v4");
  }
  return value;
}

export class FlowScheduleStore {
  readonly projectRoot: string;
  readonly rootDir: string;
  readonly ownerPath: string;
  readonly schedulesDir: string;
  readonly dispatchesDir: string;
  readonly locksDir: string;
  readonly lockPath: string;
  readonly lockOwnerPath: string;
  readonly legacyPath: string;

  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly lockStaleMs: number;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockHeartbeatMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly getProcessIdentity: (pid: number) => string | null | Promise<string | null>;

  constructor(projectRoot: string, options: FlowScheduleStoreOptions = {}) {
    this.projectRoot = canonicalPath(projectRoot);
    this.rootDir = canonicalPath(options.rootDir ?? join(this.projectRoot, ".pi", "flow-schedule", "v1"));
    this.ownerPath = containedPath(this.rootDir, OWNER_FILE_NAME);
    this.schedulesDir = containedPath(this.rootDir, "schedules");
    this.dispatchesDir = containedPath(this.rootDir, "dispatches");
    this.locksDir = containedPath(this.rootDir, "locks");
    this.lockPath = containedPath(this.locksDir, STORE_LOCK_NAME);
    this.lockOwnerPath = containedPath(this.lockPath, OWNER_FILE_NAME);
    this.legacyPath = containedPath(this.projectRoot, ".pi", "flow-track");
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? randomUUID;
    this.lockStaleMs = positiveInteger(options.lockStaleMs ?? 30_000, "lockStaleMs");
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? 25, "lockRetryMs");
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 5_000, "lockTimeoutMs");
    this.lockHeartbeatMs = positiveInteger(
      options.lockHeartbeatMs ?? Math.max(10, Math.min(10_000, Math.floor(this.lockStaleMs / 3))),
      "lockHeartbeatMs",
    );
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.getProcessIdentity = options.getProcessIdentity ?? processIdentity;
  }

  async initialize(): Promise<FlowScheduleOwnerMarker> {
    await ensureRealDirectory(this.rootDir);
    await assertCanonicalDirectory(this.rootDir);
    await Promise.all([
      ensureRealDirectory(this.schedulesDir),
      ensureRealDirectory(this.dispatchesDir),
      ensureRealDirectory(this.locksDir),
    ]);

    const existing = await this.readOwnerMarkerOptional();
    if (existing) return this.assertOwnerIdentity(existing);

    const marker = parseFlowScheduleOwnerMarker({
      version: FLOW_SCHEDULE_VERSION,
      type: FLOW_SCHEDULE_STORE_TYPE,
      storeId: createFlowScheduleDispatchId(this.createId),
      projectRoot: this.projectRoot,
      storageRoot: this.rootDir,
      createdAt: this.now(),
    });
    const created = await createExclusiveJson(
      this.ownerPath,
      marker,
      FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes,
    );
    if (created) return marker;
    const winner = await this.readOwnerMarkerRequired();
    return this.assertOwnerIdentity(winner);
  }

  async readSchedule(scheduleId: string): Promise<FlowScheduleRecord | undefined> {
    assertScheduleId(scheduleId);
    if (!(await pathExists(this.rootDir))) return undefined;
    await assertCanonicalDirectory(this.rootDir);
    await this.readOwnerMarkerRequired();
    return this.readScheduleUnlocked(scheduleId);
  }

  async listSchedules(): Promise<FlowScheduleRecord[]> {
    if (!(await pathExists(this.rootDir))) return [];
    await assertCanonicalDirectory(this.rootDir);
    await this.readOwnerMarkerRequired();
    return this.listSchedulesUnlocked();
  }

  async createSchedule(
    input: FlowScheduleCreateInput,
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleRecord> {
    const schedule = normalizeFlowSchedule(input, this.now());
    return this.withStoreLock(async (lock) => {
      await lock.assertOwned();
      const schedules = await this.listSchedulesUnlocked();
      const nonterminal = schedules.filter((record) => !isTerminalScheduleState(record.state));
      if (nonterminal.length >= FLOW_SCHEDULE_LIMITS.maxNonterminalSchedules) {
        throw new FlowScheduleConflictError(
          `Flow schedule store already contains ${FLOW_SCHEDULE_LIMITS.maxNonterminalSchedules} nonterminal schedules`,
        );
      }
      const path = this.schedulePath(schedule.scheduleId);
      await beforePersist?.(structuredClone(schedule));
      await lock.assertOwned();
      if (!await createExclusiveJson(path, schedule, FLOW_SCHEDULE_LIMITS.maxScheduleRecordBytes)) {
        throw new FlowScheduleConflictError(`Flow schedule already exists: ${schedule.scheduleId}`, path);
      }
      return schedule;
    });
  }

  async updateSchedule(
    scheduleId: string,
    update: (current: FlowScheduleRecord) => FlowScheduleRecord | Promise<FlowScheduleRecord>,
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleRecord> {
    assertScheduleId(scheduleId);
    return this.withStoreLock(async (lock) => {
      const current = await this.requireScheduleUnlocked(scheduleId);
      const proposed = await update(structuredClone(current));
      const next = parseFlowScheduleRecord({
        ...proposed,
        version: FLOW_SCHEDULE_VERSION,
        scheduleId: current.scheduleId,
        createdAt: current.createdAt,
        updatedAt: this.now(),
      });
      assertScheduleEvolution(current, next);
      await beforePersist?.(structuredClone(next));
      await lock.assertOwned();
      await writeAtomicJson(this.schedulePath(scheduleId), next, FLOW_SCHEDULE_LIMITS.maxScheduleRecordBytes);
      return next;
    });
  }

  async repairScheduleProjection(projection: FlowScheduleRecord): Promise<FlowScheduleRecord> {
    const authoritative = parseFlowScheduleRecord(structuredClone(projection));
    return this.withStoreLock(async (lock) => {
      const current = await this.readScheduleUnlocked(authoritative.scheduleId);
      if (current && current.createdAt !== authoritative.createdAt) {
        throw new FlowScheduleConflictError("Flow schedule projection repair identity does not match v1");
      }
      await this.persistScheduleProjectionUnlocked(authoritative, lock);
      return authoritative;
    });
  }

  async repairDispatchProjection(projection: FlowScheduleDispatchBundle): Promise<FlowScheduleDispatchBundle> {
    const intent = parseFlowScheduleDispatch(structuredClone(projection.intent));
    if (intent.state !== "prepared") throw new FlowScheduleConflictError("Dispatch intent projection is not prepared");
    const published = projection.published && parseFlowSchedulePublishedRecord(structuredClone(projection.published));
    const accepted = projection.accepted && parseFlowScheduleAcceptedRecord(structuredClone(projection.accepted));
    const completion = projection.completion && parseFlowScheduleCompletionRecord(structuredClone(projection.completion));
    const binding = projection.binding && parseFlowScheduleTodoBinding(structuredClone(projection.binding));
    for (const record of [published, accepted, completion]) {
      if (record) assertDispatchRecordIdentity(intent, record);
    }
    if (accepted && !published) throw new FlowScheduleConflictError("Accepted projection has no publication");
    if (binding && (binding.dispatchId !== intent.dispatchId
      || binding.scheduleId !== intent.scheduleId
      || binding.stepId !== intent.stepId)) {
      throw new FlowScheduleConflictError("Binding projection identity does not match its dispatch intent");
    }
    return this.withStoreLock(async (lock) => {
      const directory = this.dispatchPath(intent.dispatchId);
      await lock.assertOwned();
      await ensureRealDirectory(directory);
      await this.createIdempotentDispatchRecord(lock, intent.dispatchId, INTENT_FILE_NAME, intent, parseFlowScheduleDispatch);
      if (published) await this.createIdempotentDispatchRecord(lock, intent.dispatchId, PUBLISHED_FILE_NAME, published, parseFlowSchedulePublishedRecord);
      if (accepted) await this.createIdempotentDispatchRecord(lock, intent.dispatchId, ACCEPTED_FILE_NAME, accepted, parseFlowScheduleAcceptedRecord);
      if (completion) await this.createIdempotentDispatchRecord(lock, intent.dispatchId, COMPLETION_FILE_NAME, completion, parseFlowScheduleCompletionRecord);
      if (binding) {
        await lock.assertOwned();
        await writeAtomicJson(
          containedPath(directory, BINDING_FILE_NAME),
          binding,
          FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes,
        );
      }
      return {
        intent,
        ...(published ? { published } : {}),
        ...(accepted ? { accepted } : {}),
        ...(completion ? { completion } : {}),
        ...(binding ? { binding } : {}),
      };
    });
  }

  async appendSteps(
    scheduleId: string,
    afterStepId: string,
    steps: FlowScheduleCreateStepInput[],
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleRecord> {
    const action = parseFlowScheduleAction({ action: "append", scheduleId, afterStepId, steps });
    if (action.action !== "append") throw new Error("Flow schedule append normalization failed");
    return this.updateSchedule(scheduleId, (current) => {
      const insertion = current.stepIds.indexOf(action.afterStepId);
      if (insertion < 0) throw new FlowScheduleConflictError(`Unknown Flow schedule step: ${action.afterStepId}`);
      const displaced = current.stepIds.slice(insertion + 1);
      const attempted = displaced.find((stepId) => {
        const step = current.steps[stepId];
        return step.state !== "pending"
          || step.attempts.length > 0
          || step.currentDispatchId !== undefined
          || step.result !== undefined;
      });
      if (attempted) {
        throw new FlowScheduleConflictError(
          `Cannot insert before attempted Flow schedule step: ${attempted}`,
        );
      }
      if (current.stepIds.length + action.steps.length > FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule) {
        throw new FlowScheduleConflictError(
          `Flow schedule cannot exceed ${FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule} steps`,
        );
      }
      for (const step of action.steps) {
        if (current.steps[step.stepId]) throw new FlowScheduleConflictError(`Duplicate Flow schedule step: ${step.stepId}`);
      }
      const nextSteps = { ...current.steps };
      for (const step of action.steps) {
        nextSteps[step.stepId] = { stepId: step.stepId, prompt: step.prompt, state: "pending", attempts: [], ...(step.todoBinding ? { todoBinding: step.todoBinding } : {}) };
      }
      const stepIds = [...current.stepIds];
      stepIds.splice(insertion + 1, 0, ...action.steps.map((step) => step.stepId));
      return { ...current, stepIds, steps: nextSteps };
    }, beforePersist);
  }

  async prepareRetry(
    scheduleId: string,
    stepId: string,
    reason: string,
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleRecord> {
    const action = parseFlowScheduleAction({ action: "retry", scheduleId, stepId, reason });
    if (action.action !== "retry") throw new Error("Flow schedule retry normalization failed");
    return this.withStoreLock(async (lock) => {
      const current = await this.requireScheduleUnlocked(action.scheduleId);
      if (current.state !== "active" && current.state !== "paused") {
        throw new FlowScheduleConflictError(`Flow schedule ${current.scheduleId} cannot retry from ${current.state}`);
      }
      const step = current.steps[action.stepId];
      if (!step) throw new FlowScheduleConflictError(`Unknown Flow schedule step: ${action.stepId}`);
      if (step.state !== "failed" && step.state !== "ambiguous") {
        throw new FlowScheduleConflictError(`Flow schedule step ${action.stepId} cannot retry from ${step.state}`);
      }
      if (current.activeStepId !== undefined || step.currentDispatchId !== undefined) {
        throw new FlowScheduleConflictError("Flow schedule retry requires no active dispatch");
      }
      const previousDispatchId = step.attempts.at(-1);
      const previousBundle = previousDispatchId
        ? await this.readDispatchBundleUnlocked(previousDispatchId)
        : undefined;
      const nextStep: FlowScheduleRecord["steps"][string] = { ...step, state: "pending" };
      delete nextStep.result;
      const next = parseFlowScheduleRecord({
        ...current,
        reason: action.reason,
        steps: { ...current.steps, [action.stepId]: nextStep },
        updatedAt: this.now(),
      });
      await beforePersist?.(structuredClone(next));
      if (previousBundle) {
        await this.terminalizeBindingAmbiguousUnlocked(
          previousBundle,
          `Retry requested: ${action.reason}`,
          lock,
        );
      }
      await this.persistScheduleProjectionUnlocked(next, lock);
      return next;
    });
  }

  async createDispatchIntent(
    input: FlowScheduleDispatchIntentInput,
    authorize?: () => boolean,
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleDispatchIntentOutcome> {
    const dispatch = parseFlowScheduleDispatch({
      version: FLOW_SCHEDULE_VERSION,
      ...input,
      state: "prepared",
      createdAt: input.createdAt ?? this.now(),
    });
    return this.withStoreLock(async (lock) => {
      const schedule = await this.requireScheduleUnlocked(dispatch.scheduleId);
      const step = schedule.steps[dispatch.stepId];
      if (!step) throw new FlowScheduleConflictError(`Unknown Flow schedule step: ${dispatch.stepId}`);
      const existing = await this.readDispatchBundleUnlocked(dispatch.dispatchId);
      if (existing) {
        if (!sameDispatchIntent(existing.intent, dispatch)) {
          throw new FlowScheduleConflictError(`Dispatch ID already belongs to another intent: ${dispatch.dispatchId}`);
        }
        if (step.attempts.includes(dispatch.dispatchId)) {
          return { created: false, dispatch: existing.intent, schedule };
        }
        const repaired = this.projectIntentToSchedule(schedule, existing.intent);
        await beforePersist?.(structuredClone(repaired));
        await this.persistScheduleProjectionUnlocked(repaired, lock);
        return { created: false, dispatch: existing.intent, schedule: repaired };
      }

      if (schedule.state !== "active") {
        throw new FlowScheduleConflictError(`Flow schedule ${schedule.scheduleId} is not active`);
      }
      if (schedule.targetSelector !== `owner:${dispatch.targetIdentity.ownerId}`) {
        throw new FlowScheduleConflictError("Dispatch target identity does not match the schedule target selector");
      }
      const nextStepId = schedule.stepIds.find((candidate) => schedule.steps[candidate].state !== "completed");
      if (nextStepId !== dispatch.stepId) {
        throw new FlowScheduleConflictError(
          `Flow schedule step ${dispatch.stepId} is not the next sequential step${nextStepId ? ` (${nextStepId})` : ""}`,
        );
      }

      if (step.state !== "pending") {
        throw new FlowScheduleConflictError(`Flow schedule step ${dispatch.stepId} is not pending`);
      }
      if (step.attempts.length >= FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep) {
        throw new FlowScheduleConflictError(
          `Flow schedule step ${dispatch.stepId} reached its ${FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep} attempt limit`,
        );
      }
      if (schedule.activeStepId !== undefined) {
        throw new FlowScheduleConflictError(`Flow schedule ${schedule.scheduleId} already has an active dispatch`);
      }

      const active = await this.listActiveDispatchesUnlocked();
      if (active.some((entry) => entry.scheduleId === dispatch.scheduleId)) {
        throw new FlowScheduleConflictError(`Flow schedule ${schedule.scheduleId} already has a durable active intent`);
      }
      if (active.some((entry) => sameTargetIdentity(entry.targetIdentity, dispatch.targetIdentity))) {
        throw new FlowScheduleConflictError("Exact target incarnation already has an active Flow schedule dispatch");
      }

      const updated = this.projectIntentToSchedule(schedule, dispatch);
      await beforePersist?.(structuredClone(updated));
      if (authorize && !authorize()) {
        throw new FlowScheduleConflictError("Flow schedule dispatch authority fence is stale");
      }
      const directory = this.dispatchPath(dispatch.dispatchId);
      await lock.assertOwned();
      await ensureRealDirectory(directory);
      if (authorize && !authorize()) {
        await rmdir(directory).catch(() => undefined);
        throw new FlowScheduleConflictError("Flow schedule dispatch authority fence is stale");
      }
      await lock.assertOwned();
      const created = await createExclusiveJson(
        containedPath(directory, INTENT_FILE_NAME),
        dispatch,
        FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes,
      );
      if (!created) {
        const raced = await this.requireDispatchBundleUnlocked(dispatch.dispatchId);
        if (!sameDispatchIntent(raced.intent, dispatch)) {
          throw new FlowScheduleConflictError(`Dispatch ID already belongs to another intent: ${dispatch.dispatchId}`);
        }
        await this.persistScheduleProjectionUnlocked(updated, lock);
        return { created: false, dispatch: raced.intent, schedule: updated };
      }

      await this.persistScheduleProjectionUnlocked(updated, lock);
      return { created: true, dispatch, schedule: updated };
    });
  }

  async readDispatch(dispatchId: string): Promise<FlowScheduleDispatchBundle | undefined> {
    assertDispatchId(dispatchId);
    if (!(await pathExists(this.rootDir))) return undefined;
    await assertCanonicalDirectory(this.rootDir);
    await this.readOwnerMarkerRequired();
    return this.readDispatchBundleUnlocked(dispatchId);
  }

  async recordPublished(record: FlowSchedulePublishedRecord): Promise<FlowSchedulePublishedRecord> {
    const normalized = parseFlowSchedulePublishedRecord(record);
    return this.withStoreLock(async (lock) => {
      const bundle = await this.requireDispatchBundleUnlocked(normalized.dispatchId);
      assertDispatchRecordIdentity(bundle.intent, normalized);
      return this.createIdempotentDispatchRecord(
        lock,
        normalized.dispatchId,
        PUBLISHED_FILE_NAME,
        normalized,
        parseFlowSchedulePublishedRecord,
      );
    });
  }

  async recordAccepted(
    record: FlowScheduleAcceptedRecord,
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleAcceptedRecord> {
    const normalized = parseFlowScheduleAcceptedRecord(record);
    return this.withStoreLock(async (lock) => {
      const bundle = await this.requireDispatchBundleUnlocked(normalized.dispatchId);
      assertDispatchRecordIdentity(bundle.intent, normalized);
      if (!bundle.published) throw new FlowScheduleConflictError("Dispatch cannot be accepted before publication");
      const schedule = bundle.completion
        ? undefined
        : await this.requireScheduleUnlocked(normalized.scheduleId);
      const projection = schedule
        ? this.projectAcceptedToSchedule(schedule, normalized)
        : undefined;
      if (projection) await beforePersist?.(structuredClone(projection));
      const stored = await this.createIdempotentDispatchRecord(
        lock,
        normalized.dispatchId,
        ACCEPTED_FILE_NAME,
        normalized,
        parseFlowScheduleAcceptedRecord,
      );
      if (projection) await this.persistScheduleProjectionUnlocked(projection, lock);
      return stored;
    });
  }

  async recordCompletion(
    record: FlowScheduleCompletionRecord,
    beforePersist?: FlowSchedulePrePersist,
  ): Promise<FlowScheduleCompletionRecord> {
    const normalized = parseFlowScheduleCompletionRecord(record);
    return this.withStoreLock(async (lock) => {
      const bundle = await this.requireDispatchBundleUnlocked(normalized.dispatchId);
      assertDispatchRecordIdentity(bundle.intent, normalized);
      if (!sameTargetIdentity(bundle.intent.targetIdentity, normalized.targetIdentity)) {
        throw new FlowScheduleConflictError("Completion target identity does not match its dispatch intent");
      }
      if (normalized.result !== undefined
        && (bundle.intent.completionCorrelation !== undefined
          || normalized.result.completionCorrelation !== undefined)
        && !sameJson(bundle.intent.completionCorrelation, normalized.result.completionCorrelation)) {
        throw new FlowScheduleConflictError("Completion correlation does not match its dispatch intent");
      }
      if (bundle.completion) {
        if (!sameJson(bundle.completion, normalized)) {
          throw new FlowScheduleConflictError(
            "Exclusive dispatch record already exists with different content",
            containedPath(this.dispatchPath(normalized.dispatchId), COMPLETION_FILE_NAME),
          );
        }
        if (normalized.state === "ignored") {
          await this.terminalizeBindingForCompletionUnlocked(bundle, normalized, lock);
          return bundle.completion;
        }
        const projected = await this.requireScheduleUnlocked(normalized.scheduleId);
        const projectedStep = projected.steps[normalized.stepId];
        if (completionAlreadyProjected(projectedStep, normalized)) return bundle.completion;
        const next = this.projectCompletionToSchedule(projected, normalized);
        await beforePersist?.(structuredClone(next));
        await this.terminalizeBindingForCompletionUnlocked(bundle, normalized, lock);
        await this.persistScheduleProjectionUnlocked(next, lock);
        return bundle.completion;
      }
      if (normalized.state === "ignored") {
        return this.createIdempotentDispatchRecord(
          lock,
          normalized.dispatchId,
          COMPLETION_FILE_NAME,
          normalized,
          parseFlowScheduleCompletionRecord,
        );
      }
      const schedule = await this.requireScheduleUnlocked(normalized.scheduleId);
      assertCurrentCompletion(schedule, normalized);
      const projection = this.projectCompletionToSchedule(schedule, normalized);
      await beforePersist?.(structuredClone(projection));
      await this.terminalizeBindingForCompletionUnlocked(bundle, normalized, lock);
      const stored = await this.createIdempotentDispatchRecord(
        lock,
        normalized.dispatchId,
        COMPLETION_FILE_NAME,
        normalized,
        parseFlowScheduleCompletionRecord,
      );
      await this.persistScheduleProjectionUnlocked(projection, lock);
      return stored;
    });
  }

  /**
   * Read the durable Todo binding for a dispatch, if any. Binding is optional;
   * absence returns undefined (dispatch has no bound Todo yet).
   */
  async readBinding(dispatchId: string): Promise<FlowScheduleTodoBinding | undefined> {
    const bundle = await this.readDispatch(dispatchId);
    return bundle?.binding;
  }

  /** List every durable Todo binding in stable creation order. */
  async listBindings(): Promise<FlowScheduleTodoBinding[]> {
    if (!(await pathExists(this.rootDir))) return [];
    await assertCanonicalDirectory(this.rootDir);
    await this.readOwnerMarkerRequired();
    const bindings: FlowScheduleTodoBinding[] = [];
    for (const dispatchId of await this.listDispatchDirectoriesUnlocked()) {
      const bundle = await this.readDispatchBundleUnlocked(dispatchId);
      if (bundle?.binding) bindings.push(bundle.binding);
    }
    return bindings.sort((left, right) => left.createdAt - right.createdAt || left.dispatchId.localeCompare(right.dispatchId));
  }

  /**
   * Record or update the durable Todo binding for a dispatch. Idempotent: the
   * same dispatchId replays the same content without error. Allows state
   * progression (pending -> bound -> completed|failed|ambiguous); terminal
   * states are immutable. Conflicting content at the same non-terminal state
   * raises FlowScheduleConflictError. The dispatch must already exist.
   */
  async recordBinding(record: FlowScheduleTodoBinding): Promise<FlowScheduleTodoBinding> {
    const normalized = parseFlowScheduleTodoBinding(record);
    return this.withStoreLock(async (lock) => {
      const bundle = await this.requireDispatchBundleUnlocked(normalized.dispatchId);
      assertDispatchRecordIdentity(bundle.intent, normalized);
      const existing = bundle.binding;
      if (existing) {
        if (sameJson(existing, normalized)) return existing;
        if (isTerminalBindingState(existing.state)) {
          throw new FlowScheduleConflictError(
            "Todo binding already in terminal state",
            containedPath(this.dispatchPath(normalized.dispatchId), BINDING_FILE_NAME),
          );
        }
        if (existing.state === normalized.state) {
          throw new FlowScheduleConflictError(
            "Todo binding already exists with different content at the same state",
            containedPath(this.dispatchPath(normalized.dispatchId), BINDING_FILE_NAME),
          );
        }
        await lock.assertOwned();
        const path = containedPath(this.dispatchPath(normalized.dispatchId), BINDING_FILE_NAME);
        await writeAtomicJson(path, normalized, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
        return normalized;
      }
      return this.createIdempotentDispatchRecord(
        lock,
        normalized.dispatchId,
        BINDING_FILE_NAME,
        normalized,
        parseFlowScheduleTodoBinding,
      );
    });
  }

  async collectGarbage(options: FlowScheduleGcOptions = {}): Promise<FlowScheduleGcResult> {
    const now = nonnegativeInteger(options.now ?? this.now(), "GC now");
    const retentionMs = nonnegativeInteger(
      options.retentionMs ?? FLOW_SCHEDULE_LIMITS.terminalRetentionMs,
      "GC retentionMs",
    );
    const maxSchedules = positiveInteger(
      options.maxSchedules ?? FLOW_SCHEDULE_LIMITS.maxGcSchedulesPerRun,
      "GC maxSchedules",
    );
    if (maxSchedules > FLOW_SCHEDULE_LIMITS.maxGcSchedulesPerRun) {
      throw new FlowScheduleStoreError(
        `GC maxSchedules cannot exceed ${FLOW_SCHEDULE_LIMITS.maxGcSchedulesPerRun}`,
      );
    }

    return this.withStoreLock(async (lock) => {
      await this.readOwnerMarkerRequired();
      await assertCanonicalDirectory(this.rootDir);
      const schedules = (await this.listSchedulesUnlocked())
        .filter((schedule) => isTerminalScheduleState(schedule.state) && schedule.updatedAt <= now - retentionMs)
        .sort((left, right) => left.updatedAt - right.updatedAt || left.scheduleId.localeCompare(right.scheduleId))
        .slice(0, maxSchedules);
      const selected = new Set(schedules.map((schedule) => schedule.scheduleId));
      const deletedDispatchIds: string[] = [];

      for (const entry of await this.listDispatchDirectoriesUnlocked()) {
        const bundle = await this.readDispatchBundleUnlocked(entry);
        if (!bundle || !selected.has(bundle.intent.scheduleId)) continue;
        if (!bundle.completion) {
          throw new FlowScheduleCorruptionError(this.dispatchPath(entry), "terminal schedule has a nonterminal dispatch");
        }
        await lock.assertOwned();
        await removeOwnedDirectory(this.dispatchesDir, this.dispatchPath(entry));
        deletedDispatchIds.push(entry);
      }
      for (const schedule of schedules) {
        await lock.assertOwned();
        await removeOwnedFile(this.schedulesDir, this.schedulePath(schedule.scheduleId));
      }
      return {
        deletedScheduleIds: schedules.map((schedule) => schedule.scheduleId),
        deletedDispatchIds: deletedDispatchIds.sort(),
      };
    });
  }

  async detectLegacyFlowTrack(): Promise<FlowScheduleLegacyStatus> {
    try {
      const details = await lstat(this.legacyPath);
      const kind = details.isSymbolicLink()
        ? "symlink"
        : details.isDirectory()
          ? "directory"
          : details.isFile()
            ? "file"
            : "other";
      return { present: true, path: this.legacyPath, kind };
    } catch (error) {
      if (isMissingFile(error)) return { present: false, path: this.legacyPath };
      throw error;
    }
  }

  async acquireStoreLock(): Promise<FlowScheduleStoreLock> {
    await this.initialize();
    const deadline = performance.now() + this.lockTimeoutMs;
    const processIdentity = await this.resolveProcessIdentity(process.pid);
    const acquiredAt = this.now();
    const owner: FlowScheduleLockOwner = parseFlowScheduleLockOwner({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-lock",
      token: createFlowScheduleDispatchId(this.createId),
      pid: process.pid,
      ...(processIdentity ? { processIdentity } : {}),
      createdAt: acquiredAt,
      heartbeatAt: acquiredAt,
    });

    for (;;) {
      try {
        await mkdir(this.lockPath, { mode: PRIVATE_DIRECTORY_MODE });
        try {
          await writeAtomicJson(this.lockOwnerPath, owner, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
        } catch (error) {
          await rmdir(this.lockPath).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.reclaimStaleLock();
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new FlowScheduleStoreError(`Timed out waiting for Flow schedule store lock`, this.lockPath);
        }
        await delay(Math.min(this.lockRetryMs, remaining));
      }
    }

    if (!(await this.lockIsOwnedBy(owner.token))) {
      throw new FlowScheduleStoreError("Failed to acquire Flow schedule store lock", this.lockPath);
    }

    let heartbeat = Promise.resolve();
    let released = false;
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(() => this.refreshLock(owner)).catch(() => undefined);
    }, this.lockHeartbeatMs);
    timer.unref?.();

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await heartbeat;
      await this.releaseLock(owner.token);
    };
    return {
      token: owner.token,
      assertOwned: async () => {
        if (!(await this.lockIsOwnedBy(owner.token))) throw new FlowScheduleLockLostError(this.lockPath);
      },
      release,
    };
  }

  async withStoreLock<T>(operation: (lock: FlowScheduleStoreLock) => Promise<T>): Promise<T> {
    const lock = await this.acquireStoreLock();
    try {
      return await operation(lock);
    } finally {
      await lock.release();
    }
  }

  private schedulePath(scheduleId: string): string {
    assertScheduleId(scheduleId);
    return containedPath(this.schedulesDir, `${scheduleId}${SCHEDULE_FILE_SUFFIX}`);
  }

  private dispatchPath(dispatchId: string): string {
    assertDispatchId(dispatchId);
    return containedPath(this.dispatchesDir, dispatchId);
  }

  private async readScheduleUnlocked(scheduleId: string): Promise<FlowScheduleRecord | undefined> {
    const path = this.schedulePath(scheduleId);
    const raw = await readJsonOptional(path, FLOW_SCHEDULE_LIMITS.maxScheduleRecordBytes);
    if (raw === undefined) return undefined;
    try {
      const record = parseFlowScheduleRecord(raw);
      if (record.scheduleId !== scheduleId) {
        throw new Error("scheduleId does not match the file name");
      }
      return record;
    } catch (error) {
      throw new FlowScheduleCorruptionError(path, errorMessage(error));
    }
  }

  private async requireScheduleUnlocked(scheduleId: string): Promise<FlowScheduleRecord> {
    const schedule = await this.readScheduleUnlocked(scheduleId);
    if (!schedule) throw new FlowScheduleStoreError(`Unknown Flow schedule: ${scheduleId}`);
    return schedule;
  }

  private async listSchedulesUnlocked(): Promise<FlowScheduleRecord[]> {
    let entries;
    try {
      entries = await readdir(this.schedulesDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const records: FlowScheduleRecord[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(SCHEDULE_FILE_SUFFIX)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new FlowScheduleCorruptionError(containedPath(this.schedulesDir, entry.name), "schedule entry is not a regular file");
      }
      const scheduleId = entry.name.slice(0, -SCHEDULE_FILE_SUFFIX.length);
      assertScheduleId(scheduleId);
      records.push(await this.requireScheduleUnlocked(scheduleId));
    }
    return records.sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  }

  private projectIntentToSchedule(
    schedule: FlowScheduleRecord,
    dispatch: FlowScheduleDispatch,
  ): FlowScheduleRecord {
    const step = schedule.steps[dispatch.stepId];
    if (!step) throw new FlowScheduleConflictError(`Unknown Flow schedule step: ${dispatch.stepId}`);
    if (step.currentDispatchId === dispatch.dispatchId
      && schedule.activeStepId === dispatch.stepId
      && step.state === "dispatching") return schedule;
    if (schedule.activeStepId !== undefined || step.state !== "pending") {
      throw new FlowScheduleConflictError("Persisted intent cannot be applied to the current schedule projection");
    }
    if (step.attempts.length >= FLOW_SCHEDULE_LIMITS.maxAttemptsPerStep) {
      throw new FlowScheduleConflictError(`Flow schedule step ${dispatch.stepId} reached its attempt limit`);
    }
    const hadAdmissionDeferral = schedule.lastAdmitReason !== undefined
      || schedule.lastAdmitAt !== undefined
      || schedule.admitAttempts !== undefined;
    const next = parseFlowScheduleRecord({
      ...schedule,
      targetIdentity: dispatch.targetIdentity,
      activeStepId: dispatch.stepId,
      steps: {
        ...schedule.steps,
        [dispatch.stepId]: {
          ...step,
          state: "dispatching",
          attempts: [...step.attempts, dispatch.dispatchId],
          currentDispatchId: dispatch.dispatchId,
        },
      },
      updatedAt: this.now(),
    });
    if (hadAdmissionDeferral) {
      delete next.lastAdmitReason;
      delete next.lastAdmitAt;
      next.admitAttempts = 0;
    }
    return parseFlowScheduleRecord(next);
  }

  private async terminalizeBindingForCompletionUnlocked(
    bundle: FlowScheduleDispatchBundle,
    completion: FlowScheduleCompletionRecord,
    lock: FlowScheduleStoreLock,
  ): Promise<void> {
    if ((completion.state === "ambiguous" || completion.state === "retired") && completion.reason) {
      await this.terminalizeBindingAmbiguousUnlocked(bundle, completion.reason, lock);
      return;
    }
    const outcome = completion.result?.todoOutcome;
    const terminalState = completion.state === "failed"
      ? "failed"
      : completion.state === "completed" && outcome?.todoStatus === "completed"
        ? "completed"
        : undefined;
    const binding = bundle.binding;
    if (!terminalState || !outcome || !binding || isTerminalBindingState(binding.state)) return;
    if (binding.todoId !== undefined && binding.todoId !== outcome.todoId) return;
    const terminal = parseFlowScheduleTodoBinding({
      ...binding,
      todoId: outcome.todoId,
      todoStatus: outcome.todoStatus,
      state: terminalState,
      ...(terminalState === "failed" ? { reason: completion.result?.summary } : {}),
      updatedAt: this.now(),
    });
    await lock.assertOwned();
    await writeAtomicJson(
      containedPath(this.dispatchPath(bundle.intent.dispatchId), BINDING_FILE_NAME),
      terminal,
      FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes,
    );
  }

  private async terminalizeBindingAmbiguousUnlocked(
    bundle: FlowScheduleDispatchBundle,
    reason: string,
    lock: FlowScheduleStoreLock,
  ): Promise<void> {
    const binding = bundle.binding;
    if (!binding || isTerminalBindingState(binding.state)) return;
    const ambiguous = parseFlowScheduleTodoBinding({
      ...binding,
      state: "ambiguous",
      reason,
      updatedAt: this.now(),
    });
    await lock.assertOwned();
    await writeAtomicJson(
      containedPath(this.dispatchPath(bundle.intent.dispatchId), BINDING_FILE_NAME),
      ambiguous,
      FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes,
    );
  }

  private projectCompletionToSchedule(
    schedule: FlowScheduleRecord,
    completion: FlowScheduleCompletionRecord,
  ): FlowScheduleRecord {
    assertCurrentCompletion(schedule, completion);
    const step = schedule.steps[completion.stepId];
    const nextStep = {
      ...step,
      state: completionStepState(completion.state),
      ...(completion.result ? { result: completion.result } : {}),
    };
    delete nextStep.currentDispatchId;
    if (completion.state === "retired") delete nextStep.result;
    const steps = { ...schedule.steps, [completion.stepId]: nextStep };
    const allCompleted = schedule.stepIds.every((stepId) => steps[stepId].state === "completed");
    return parseFlowScheduleRecord({
      ...schedule,
      steps,
      activeStepId: undefined,
      state: allCompleted ? "completed" : schedule.state,
      updatedAt: this.now(),
    });
  }

  private projectAcceptedToSchedule(
    schedule: FlowScheduleRecord,
    accepted: FlowScheduleAcceptedRecord,
  ): FlowScheduleRecord {
    const step = schedule.steps[accepted.stepId];
    if (!step
      || schedule.activeStepId !== accepted.stepId
      || step.currentDispatchId !== accepted.dispatchId) {
      throw new FlowScheduleConflictError("Accepted dispatch does not name the current Flow schedule dispatch");
    }
    if (step.state === "awaiting-result") return schedule;
    if (step.state !== "dispatching") {
      throw new FlowScheduleConflictError("Accepted dispatch cannot be projected from the current step state");
    }
    return parseFlowScheduleRecord({
      ...schedule,
      steps: { ...schedule.steps, [accepted.stepId]: { ...step, state: "awaiting-result" } },
      updatedAt: this.now(),
    });
  }

  private async persistScheduleProjectionUnlocked(
    projection: FlowScheduleRecord,
    lock: FlowScheduleStoreLock,
  ): Promise<void> {
    await lock.assertOwned();
    await writeAtomicJson(
      this.schedulePath(projection.scheduleId),
      projection,
      FLOW_SCHEDULE_LIMITS.maxScheduleRecordBytes,
    );
  }

  private async readDispatchBundleUnlocked(dispatchId: string): Promise<FlowScheduleDispatchBundle | undefined> {
    assertDispatchId(dispatchId);
    const directory = this.dispatchPath(dispatchId);
    let details;
    try {
      details = await lstat(directory);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new FlowScheduleCorruptionError(directory, "dispatch entry is not a real directory");
    }
    const intentPath = containedPath(directory, INTENT_FILE_NAME);
    const intentRaw = await readJsonOptional(intentPath, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
    if (intentRaw === undefined) {
      const names = await readdir(directory);
      if (names.every((name) => name.endsWith(".tmp"))) return undefined;
      throw new FlowScheduleCorruptionError(directory, "dispatch directory has no intent record");
    }
    try {
      const intent = parseFlowScheduleDispatch(intentRaw);
      if (intent.dispatchId !== dispatchId || intent.state !== "prepared") {
        throw new Error("intent identity or state is invalid");
      }
      const published = await this.readOptionalDispatchRecord(directory, PUBLISHED_FILE_NAME, parseFlowSchedulePublishedRecord);
      const accepted = await this.readOptionalDispatchRecord(directory, ACCEPTED_FILE_NAME, parseFlowScheduleAcceptedRecord);
      const completion = await this.readOptionalDispatchRecord(directory, COMPLETION_FILE_NAME, parseFlowScheduleCompletionRecord);
      const binding = await this.readOptionalDispatchRecord(directory, BINDING_FILE_NAME, parseFlowScheduleTodoBinding);
      for (const record of [published, accepted, completion]) {
        if (record) assertDispatchRecordIdentity(intent, record);
      }
      if (binding && (binding.scheduleId !== intent.scheduleId || binding.stepId !== intent.stepId || binding.dispatchId !== intent.dispatchId)) {
        throw new Error("binding identity does not match its dispatch intent");
      }
      if (accepted && !published) throw new Error("accepted record exists without publication");
      return { intent, ...(published ? { published } : {}), ...(accepted ? { accepted } : {}), ...(completion ? { completion } : {}), ...(binding ? { binding } : {}) };
    } catch (error) {
      if (error instanceof FlowScheduleCorruptionError) throw error;
      throw new FlowScheduleCorruptionError(directory, errorMessage(error));
    }
  }

  private async requireDispatchBundleUnlocked(dispatchId: string): Promise<FlowScheduleDispatchBundle> {
    const bundle = await this.readDispatchBundleUnlocked(dispatchId);
    if (!bundle) throw new FlowScheduleStoreError(`Unknown Flow schedule dispatch: ${dispatchId}`);
    return bundle;
  }

  private async readOptionalDispatchRecord<T>(
    directory: string,
    name: string,
    parse: (value: unknown) => T,
  ): Promise<T | undefined> {
    const path = containedPath(directory, name);
    const raw = await readJsonOptional(path, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
    if (raw === undefined) return undefined;
    try {
      return parse(raw);
    } catch (error) {
      throw new FlowScheduleCorruptionError(path, errorMessage(error));
    }
  }

  private async createIdempotentDispatchRecord<T>(
    lock: FlowScheduleStoreLock,
    dispatchId: string,
    name: string,
    record: T,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const path = containedPath(this.dispatchPath(dispatchId), name);
    await lock.assertOwned();
    if (await createExclusiveJson(path, record, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes)) return record;
    const raw = await readJsonRequired(path, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
    let existing: T;
    try {
      existing = parse(raw);
    } catch (error) {
      throw new FlowScheduleCorruptionError(path, errorMessage(error));
    }
    if (!sameJson(existing, record)) {
      throw new FlowScheduleConflictError(`Exclusive dispatch record already exists with different content`, path);
    }
    return existing;
  }

  private async listActiveDispatchesUnlocked(): Promise<FlowScheduleDispatch[]> {
    const active: FlowScheduleDispatch[] = [];
    for (const dispatchId of await this.listDispatchDirectoriesUnlocked()) {
      const bundle = await this.readDispatchBundleUnlocked(dispatchId);
      if (bundle && !bundle.completion) active.push(bundle.intent);
    }
    return active;
  }

  private async listDispatchDirectoriesUnlocked(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.dispatchesDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.name.endsWith(".tmp")) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new FlowScheduleCorruptionError(containedPath(this.dispatchesDir, entry.name), "dispatch entry is not a real directory");
      }
      assertDispatchId(entry.name);
      ids.push(entry.name);
    }
    return ids.sort();
  }

  private async readOwnerMarkerOptional(): Promise<FlowScheduleOwnerMarker | undefined> {
    const raw = await readJsonOptional(this.ownerPath, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
    if (raw === undefined) return undefined;
    try {
      return parseFlowScheduleOwnerMarker(raw);
    } catch (error) {
      throw new FlowScheduleCorruptionError(this.ownerPath, errorMessage(error));
    }
  }

  private async readOwnerMarkerRequired(): Promise<FlowScheduleOwnerMarker> {
    const marker = await this.readOwnerMarkerOptional();
    if (!marker) throw new FlowScheduleCorruptionError(this.ownerPath, "owner marker is missing");
    return this.assertOwnerIdentity(marker);
  }

  private assertOwnerIdentity(marker: FlowScheduleOwnerMarker): FlowScheduleOwnerMarker {
    if (canonicalPath(marker.projectRoot) !== this.projectRoot || canonicalPath(marker.storageRoot) !== this.rootDir) {
      throw new FlowScheduleCorruptionError(this.ownerPath, "owner marker path identity does not match this store");
    }
    return marker;
  }

  private async lockIsOwnedBy(token: string): Promise<boolean> {
    const owner = await this.readLockOwner();
    return owner?.token === token;
  }

  private async readLockOwner(): Promise<FlowScheduleLockOwner | undefined> {
    try {
      const raw = await readJsonRequired(this.lockOwnerPath, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
      return parseFlowScheduleLockOwner(raw);
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError || error instanceof FlowScheduleCorruptionError) return undefined;
      return undefined;
    }
  }

  private async refreshLock(owner: FlowScheduleLockOwner): Promise<void> {
    if (!(await this.lockIsOwnedBy(owner.token))) return;
    const next = parseFlowScheduleLockOwner({ ...owner, heartbeatAt: this.now() });
    await writeAtomicJson(this.lockOwnerPath, next, FLOW_SCHEDULE_LIMITS.maxDispatchRecordBytes);
    owner.heartbeatAt = next.heartbeatAt;
  }

  private async releaseLock(token: string): Promise<void> {
    if (!(await this.lockIsOwnedBy(token))) return;
    try {
      await unlink(this.lockOwnerPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    try {
      await rmdir(this.lockPath);
    } catch (error) {
      if (!isMissingFile(error) && !isDirectoryNotEmpty(error)) throw error;
    }
  }

  private async reclaimStaleLock(): Promise<void> {
    const observed = await this.readLockIdentity();
    if (!observed || !(await this.lockIdentityIsStale(observed))) return;
    const claimPath = containedPath(
      this.locksDir,
      `${STORE_LOCK_NAME}.reclaim-${safeToken(observed.identity)}`,
    );
    try {
      await mkdir(claimPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const details = await stat(claimPath);
        if (this.now() - details.mtimeMs > this.lockStaleMs * 2) {
          const abandoned = containedPath(this.locksDir, `${STORE_LOCK_NAME}.abandoned-${createFlowScheduleDispatchId(this.createId)}`);
          await rename(claimPath, abandoned).catch(() => undefined);
          await rm(abandoned, { recursive: true, force: true }).catch(() => undefined);
        }
      } catch { /* another contender owns cleanup */ }
      return;
    }

    try {
      const current = await this.readLockIdentity();
      if (!current || current.identity !== observed.identity || !(await this.lockIdentityIsStale(current))) return;
      const quarantine = containedPath(
        this.locksDir,
        `${STORE_LOCK_NAME}.stale-${safeToken(current.identity)}-${createFlowScheduleDispatchId(this.createId)}`,
      );
      try {
        await rename(this.lockPath, quarantine);
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
      await rm(quarantine, { recursive: true, force: true });
    } finally {
      await rm(claimPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readLockIdentity(): Promise<{
    identity: string;
    owner?: FlowScheduleLockOwner;
    mtimeMs: number;
  } | undefined> {
    try {
      const details = await stat(this.lockPath);
      const owner = await this.readLockOwner();
      return {
        identity: owner?.token ?? `missing-${Math.floor(details.mtimeMs)}`,
        ...(owner ? { owner } : {}),
        mtimeMs: details.mtimeMs,
      };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async lockIdentityIsStale(identity: {
    owner?: FlowScheduleLockOwner;
    mtimeMs: number;
  }): Promise<boolean> {
    const lastActiveAt = identity.owner?.heartbeatAt ?? identity.mtimeMs;
    if (this.now() - lastActiveAt <= this.lockStaleMs) return false;
    if (identity.owner && this.isProcessAlive(identity.owner.pid)) {
      if (!identity.owner.processIdentity) return false;
      const liveIdentity = await this.resolveProcessIdentity(identity.owner.pid);
      if (!liveIdentity || liveIdentity === identity.owner.processIdentity) return false;
    }
    return true;
  }

  private async resolveProcessIdentity(pid: number): Promise<string | undefined> {
    try {
      const identity = await this.getProcessIdentity(pid);
      return typeof identity === "string" && identity.trim() ? identity.trim() : undefined;
    } catch {
      return undefined;
    }
  }
}

function assertScheduleEvolution(current: FlowScheduleRecord, next: FlowScheduleRecord): void {
  if (next.scheduleId !== current.scheduleId || next.createdAt !== current.createdAt) {
    throw new FlowScheduleConflictError("Flow schedule stable identity cannot change");
  }
  let previousPosition = -1;
  for (const stepId of current.stepIds) {
    const position = next.stepIds.indexOf(stepId);
    if (position <= previousPosition) {
      throw new FlowScheduleConflictError("Existing Flow schedule steps cannot be deleted or reordered");
    }
    previousPosition = position;
    const before = current.steps[stepId];
    const after = next.steps[stepId];
    if (!after || after.stepId !== before.stepId || after.prompt !== before.prompt) {
      throw new FlowScheduleConflictError(`Flow schedule step identity and prompt are immutable: ${stepId}`);
    }
    if (!sameJson(after.attempts, before.attempts)) {
      throw new FlowScheduleConflictError(`Flow schedule attempts may only be changed by dispatch admission: ${stepId}`);
    }
    if (after.currentDispatchId !== before.currentDispatchId) {
      throw new FlowScheduleConflictError(`Flow schedule current dispatch may only be changed by the store protocol: ${stepId}`);
    }
    if (!sameJson(before.result, after.result)) {
      throw new FlowScheduleConflictError(`Flow schedule result may only be changed by the store protocol: ${stepId}`);
    }
    if (after.state !== before.state) {
      const cancellation = next.state === "cancelled"
        && after.state === "cancelled"
        && (before.state === "pending" || before.state === "failed" || before.state === "ambiguous");
      if (!cancellation) {
        throw new FlowScheduleConflictError(`Flow schedule step state may only be changed by the store protocol: ${stepId}`);
      }
    }
  }
  if (next.activeStepId !== current.activeStepId) {
    throw new FlowScheduleConflictError("Flow schedule active dispatch may only be changed by the store protocol");
  }
}

function assertCurrentCompletion(schedule: FlowScheduleRecord, completion: FlowScheduleCompletionRecord): void {
  const step = schedule.steps[completion.stepId];
  if (!step || schedule.activeStepId !== completion.stepId || step.currentDispatchId !== completion.dispatchId) {
    throw new FlowScheduleConflictError("Completion does not name the current Flow schedule dispatch");
  }
}

function completionAlreadyProjected(
  step: FlowScheduleRecord["steps"][string] | undefined,
  completion: FlowScheduleCompletionRecord,
): boolean {
  if (!step || step.currentDispatchId !== undefined) return false;
  if (completion.state === "completed" || completion.state === "failed") {
    return step.state === completion.state && sameJson(step.result, completion.result);
  }
  if (completion.state === "ambiguous") return step.state === "ambiguous";
  if (completion.state === "retired") return step.state === "pending";
  return false;
}

function sameDispatchIntent(left: FlowScheduleDispatch, right: FlowScheduleDispatch): boolean {
  return left.version === right.version
    && left.dispatchId === right.dispatchId
    && left.scheduleId === right.scheduleId
    && left.stepId === right.stepId
    && left.state === right.state
    && sameTargetIdentity(left.targetIdentity, right.targetIdentity)
    && sameJson(left.completionCorrelation, right.completionCorrelation);
}

function completionStepState(state: FlowScheduleCompletionRecord["state"]): FlowScheduleRecord["steps"][string]["state"] {
  switch (state) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "ambiguous": return "ambiguous";
    case "retired": return "pending";
    case "ignored": throw new Error("Ignored completion has no step transition");
  }
}

function assertDispatchRecordIdentity(
  intent: FlowScheduleDispatch,
  record: { dispatchId: string; scheduleId: string; stepId: string },
): void {
  if (intent.dispatchId !== record.dispatchId || intent.scheduleId !== record.scheduleId || intent.stepId !== record.stepId) {
    throw new FlowScheduleConflictError("Dispatch record identity does not match its intent");
  }
}

function sameTargetIdentity(left: ExactWindowIdentity, right: ExactWindowIdentity): boolean {
  return left.workspaceId === right.workspaceId
    && left.endpointId === right.endpointId
    && left.ownerId === right.ownerId
    && left.ownerNonce === right.ownerNonce
    && left.sessionId === right.sessionId;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

async function readJsonOptional(path: string, maximumBytes: number): Promise<unknown | undefined> {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new FlowScheduleCorruptionError(path, "record is not a regular file");
  }
  if (details.size > maximumBytes) {
    throw new FlowScheduleCorruptionError(path, `record exceeds ${maximumBytes} bytes`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new FlowScheduleCorruptionError(path, errorMessage(error));
  }
}

async function readJsonRequired(path: string, maximumBytes: number): Promise<unknown> {
  const value = await readJsonOptional(path, maximumBytes);
  if (value === undefined) {
    const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  return value;
}

async function writeAtomicJson(path: string, value: unknown, maximumBytes: number): Promise<void> {
  const payload = jsonPayload(value, maximumBytes, path);
  await ensureRealDirectory(dirname(path));
  await assertRegularFileOrMissing(path);
  const temporary = containedPath(dirname(path), `${pathBasename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRegularFileOrMissing(path);
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createExclusiveJson(path: string, value: unknown, maximumBytes: number): Promise<boolean> {
  const payload = jsonPayload(value, maximumBytes, path);
  const directory = dirname(path);
  await ensureRealDirectory(directory);
  const temporary = containedPath(directory, `${pathBasename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    await fsyncDirectory(directory);
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function jsonPayload(value: unknown, maximumBytes: number, path: string): Buffer {
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (payload.byteLength > maximumBytes) {
    throw new FlowScheduleStoreError(`Flow schedule record exceeds ${maximumBytes} bytes`, path);
  }
  return payload;
}

async function ensureRealDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new FlowScheduleStoreError("Flow schedule storage path must be a real directory", path);
  }
  if (process.platform !== "win32") await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const actual = canonicalPath(await realpath(path));
  if (actual !== canonicalPath(path)) {
    throw new FlowScheduleStoreError("Flow schedule storage root cannot traverse a symbolic link", path);
  }
}

async function assertRegularFileOrMissing(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new FlowScheduleStoreError("Flow schedule record path must be a regular file", path);
    }
    if (process.platform !== "win32") await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EPERM", "EINVAL", "ENOSYS", "EBADF"].includes(fileCode(error) ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeOwnedFile(root: string, path: string): Promise<void> {
  assertContained(root, path);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new FlowScheduleCorruptionError(path, "GC target is not a regular file");
  }
  await unlink(path);
  await fsyncDirectory(dirname(path));
}

async function removeOwnedDirectory(root: string, path: string): Promise<void> {
  assertContained(root, path);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new FlowScheduleCorruptionError(path, "GC target is not a real directory");
  }
  await rm(path, { recursive: true, force: false });
  await fsyncDirectory(dirname(path));
}

function containedPath(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  assertContained(root, target);
  return target;
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new FlowScheduleStoreError("Flow schedule path escapes its owned root", target);
}

function canonicalPath(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertScheduleId(value: string): void {
  if (!FLOW_SCHEDULE_ID_PATTERN.test(value)) throw new FlowScheduleStoreError(`Invalid Flow schedule ID: ${value}`);
}

function assertDispatchId(value: string): void {
  if (!FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(value)) throw new FlowScheduleStoreError(`Invalid Flow schedule dispatch ID: ${value}`);
}

function pathBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function safeToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileCode(error) === "EPERM";
  }
}

let ownProcessIdentity: Promise<string | null> | undefined;

function processIdentity(pid: number): Promise<string | null> {
  if (pid !== process.pid) return readProcessIdentity(pid);
  ownProcessIdentity ??= readProcessIdentity(pid).then((identity) => {
    if (!identity) ownProcessIdentity = undefined;
    return identity;
  });
  return ownProcessIdentity;
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 0) return null;
  if (process.platform === "linux") {
    try {
      const [rawStat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const commandEnd = rawStat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = rawStat.slice(commandEnd + 1).trim().split(/\s+/);
      return fields[19] ? `linux:${bootId.trim()}:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const windowsDir = process.env.SystemRoot ?? process.env.WINDIR;
    const powershell = windowsDir
      ? join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks }`;
    const output = await execFileText(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
    return output ? `win32:${output}` : null;
  }
  return null;
}

function execFileText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolveResult) => {
    execFile(file, args, { encoding: "utf8", timeout: 2_000, windowsHide: true }, (error, stdout) => {
      resolveResult(error ? null : stdout.trim() || null);
    });
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new FlowScheduleStoreError(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new FlowScheduleStoreError(`${name} must be a non-negative integer`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function isMissingFile(error: unknown): boolean {
  return fileCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return fileCode(error) === "EEXIST";
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return fileCode(error) === "ENOTEMPTY" || fileCode(error) === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
