import { randomUUID } from "node:crypto";
import type {
	SettingsActivationPlan,
	SettingsApplyRuntimeResultV1,
	SettingsChange,
	SettingsCommitResultV1,
	SettingsContextV1,
	SettingsPrepareResultV1,
	SettingsResourceConflict,
	SettingsSnapshot,
	SettingsValidationIssue,
	SettingsValidationResult,
} from "pi-maestro-settings-core/v1";
import type { RegisteredSettingsProvider, SettingsProviderRegistry } from "./registry.ts";

export type SettingsApplyStatus =
	| "noop"
	| "validation-failed"
	| "conflict"
	| "prepare-failed"
	| "commit-failed"
	| "committed";

export interface SettingsProviderFailure {
	providerId: string;
	stage: "read" | "validate" | "prepare" | "commit" | "abort" | "rollback" | "runtime";
	message: string;
}

export interface SettingsApplyOutcome {
	status: SettingsApplyStatus;
	transactionId?: string;
	issues: readonly SettingsValidationIssue[];
	conflicts: readonly SettingsResourceConflict[];
	failures: readonly SettingsProviderFailure[];
	activation: readonly SettingsActivationPlan[];
	runtime: Readonly<Record<string, SettingsApplyRuntimeResultV1>>;
}

interface ProviderBaseline {
	instanceId: string;
	snapshot: SettingsSnapshot;
}

interface PreparedProvider {
	registration: RegisteredSettingsProvider;
	changes: readonly SettingsChange[];
	result: SettingsPrepareResultV1;
}

interface CommittedProvider {
	prepared: PreparedProvider;
	result: SettingsCommitResultV1;
	previousBaseline: ProviderBaseline;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function draftKey(change: SettingsChange): string {
	return `${change.scope}\u0000${change.key}`;
}

export class SettingsCoordinator {
	private readonly baselines = new Map<string, ProviderBaseline>();
	private readonly drafts = new Map<string, Map<string, SettingsChange>>();

	constructor(private readonly registry: SettingsProviderRegistry) {}

	async load(context: SettingsContextV1): Promise<SettingsProviderFailure[]> {
		const failures: SettingsProviderFailure[] = [];
		this.baselines.clear();
		await Promise.all(this.registry.list().map(async (registration) => {
			try {
				const snapshot = await registration.provider.read({ context });
				if (!this.registry.isCurrent(registration.providerId, registration.instanceId)) return;
				this.baselines.set(registration.providerId, {
					instanceId: registration.instanceId,
					snapshot,
				});
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "read", message: errorMessage(error) });
			}
		}));
		return failures;
	}

	baseline(providerId: string): SettingsSnapshot | undefined {
		return this.baselines.get(providerId)?.snapshot;
	}

	setChange(providerId: string, change: SettingsChange): void {
		const providerDraft = this.drafts.get(providerId) ?? new Map<string, SettingsChange>();
		providerDraft.set(draftKey(change), change);
		this.drafts.set(providerId, providerDraft);
	}

	changes(providerId?: string): SettingsChange[] {
		if (providerId !== undefined) return [...(this.drafts.get(providerId)?.values() ?? [])];
		return [...this.drafts.values()].flatMap((draft) => [...draft.values()]);
	}

	modifiedProviderIds(): string[] {
		return [...this.drafts.entries()]
			.filter(([, changes]) => changes.size > 0)
			.map(([providerId]) => providerId)
			.sort();
	}

	discard(providerId?: string): void {
		if (providerId === undefined) this.drafts.clear();
		else this.drafts.delete(providerId);
	}

	async apply(context: SettingsContextV1): Promise<SettingsApplyOutcome> {
		const providerIds = this.modifiedProviderIds();
		if (providerIds.length === 0) return emptyOutcome("noop");

		const transactionId = randomUUID();
		const registrations: Array<{ registration: RegisteredSettingsProvider; changes: readonly SettingsChange[] }> = [];
		const failures: SettingsProviderFailure[] = [];

		for (const providerId of providerIds) {
			const registration = this.registry.get(providerId);
			const baseline = this.baselines.get(providerId);
			if (!registration || !baseline || baseline.instanceId !== registration.instanceId) {
				failures.push({ providerId, stage: "validate", message: "settings provider changed; reload before saving" });
				continue;
			}
			registrations.push({ registration, changes: this.changes(providerId) });
		}
		if (failures.length > 0) return outcome("validation-failed", transactionId, [], [], failures, [], {});

		const validations = await Promise.all(registrations.map(async ({ registration, changes }) => {
			try {
				const validation = await registration.provider.validate({
					context,
					transactionId,
					changes,
					expectedRevisions: this.baselines.get(registration.providerId)?.snapshot.configured.resources,
				});
				return { registration, validation };
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "validate", message: errorMessage(error) });
				return { registration, validation: undefined };
			}
		}));
		const validationIssues = validations.flatMap((entry) => entry.validation?.issues ?? []);
		const validationConflicts = validations.flatMap((entry) => entry.validation?.conflicts ?? []);
		if (validationConflicts.length > 0) {
			return outcome("conflict", transactionId, validationIssues, validationConflicts, failures, [], {});
		}
		if (failures.length > 0 || validations.some((entry) => entry.validation?.valid !== true)) {
			return outcome("validation-failed", transactionId, validationIssues, [], failures, [], {});
		}

		const prepared: PreparedProvider[] = [];
		for (const { registration, changes } of registrations) {
			if (!registration.provider.prepare || !registration.provider.commit) {
				failures.push({ providerId: registration.providerId, stage: "prepare", message: "provider is read-only" });
				break;
			}
			try {
				const result = await registration.provider.prepare({
					context,
					transactionId,
					changes,
					expectedRevisions: this.baselines.get(registration.providerId)?.snapshot.configured.resources,
				});
				if (!result.prepared || !result.prepareToken || !result.validation.valid) {
					const conflicts = result.conflicts ?? result.validation.conflicts ?? [];
					await this.abortPrepared(context, transactionId, prepared, failures, "prepare rejected");
					return outcome(
						conflicts.length > 0 ? "conflict" : "prepare-failed",
						transactionId,
						result.validation.issues,
						conflicts,
						failures,
						result.activation ?? [],
						{},
					);
				}
				prepared.push({ registration, changes, result });
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "prepare", message: errorMessage(error) });
				break;
			}
		}
		if (failures.length > 0) {
			await this.abortPrepared(context, transactionId, prepared, failures, "prepare failed");
			return outcome("prepare-failed", transactionId, [], [], failures, [], {});
		}

		const committed: CommittedProvider[] = [];
		const activation: SettingsActivationPlan[] = [];
		try {
			for (const entry of prepared) {
				if (!this.registry.isCurrent(entry.registration.providerId, entry.registration.instanceId)) {
					throw new Error(`provider ${entry.registration.providerId} changed during commit`);
				}
				const previousBaseline = this.baselines.get(entry.registration.providerId)!;
				const result = await entry.registration.provider.commit!({
					context,
					transactionId,
					prepareToken: entry.result.prepareToken!,
				});
				committed.push({ prepared: entry, result, previousBaseline });
				activation.push(...result.activation);
			}
		} catch (error) {
			const providerId = prepared[committed.length]?.registration.providerId ?? "unknown";
			failures.push({ providerId, stage: "commit", message: errorMessage(error) });
			await this.rollbackCommitted(context, transactionId, committed, failures);
			await this.abortPrepared(context, transactionId, prepared.slice(committed.length), failures, "commit failed");
			return outcome("commit-failed", transactionId, [], [], failures, activation, {});
		}

		for (const entry of committed) {
			const { registration } = entry.prepared;
			this.baselines.set(registration.providerId, {
				instanceId: registration.instanceId,
				snapshot: entry.result.snapshot,
			});
			this.registry.emitChanged({
				providerId: registration.providerId,
				providerInstanceId: registration.instanceId,
				transactionId,
				changedKeys: entry.result.changedKeys,
				snapshot: entry.result.snapshot,
				revisions: entry.result.revisions,
				activation: entry.result.activation,
			});
		}

		const runtime: Record<string, SettingsApplyRuntimeResultV1> = {};
		for (const entry of committed) {
			const { registration, changes } = entry.prepared;
			if (registration.provider.applyRuntime) {
				try {
					runtime[registration.providerId] = await registration.provider.applyRuntime({
						context,
						transactionId,
						changes,
						snapshot: entry.result.snapshot,
					});
				} catch (error) {
					failures.push({ providerId: registration.providerId, stage: "runtime", message: errorMessage(error) });
				}
			}
			this.drafts.delete(registration.providerId);
		}
		return outcome("committed", transactionId, [], [], failures, activation, runtime);
	}

	private async abortPrepared(
		context: SettingsContextV1,
		transactionId: string,
		prepared: readonly PreparedProvider[],
		failures: SettingsProviderFailure[],
		reason: string,
	): Promise<void> {
		for (const entry of [...prepared].reverse()) {
			if (!entry.registration.provider.abort || !entry.result.prepareToken) continue;
			try {
				await entry.registration.provider.abort({ context, transactionId, prepareToken: entry.result.prepareToken, reason });
			} catch (error) {
				failures.push({ providerId: entry.registration.providerId, stage: "abort", message: errorMessage(error) });
			}
		}
	}

	private async rollbackCommitted(
		context: SettingsContextV1,
		transactionId: string,
		committed: readonly CommittedProvider[],
		failures: SettingsProviderFailure[],
	): Promise<void> {
		for (const entry of [...committed].reverse()) {
			const { registration, result, prepareToken } = {
				registration: entry.prepared.registration,
				result: entry.result,
				prepareToken: entry.prepared.result.prepareToken,
			};
			if (!registration.provider.rollback || !prepareToken) {
				failures.push({ providerId: registration.providerId, stage: "rollback", message: "provider cannot roll back a committed change" });
				continue;
			}
			try {
				const rollback = await registration.provider.rollback({
					context,
					transactionId,
					prepareToken,
					committedRevisions: result.revisions,
				});
				this.baselines.set(registration.providerId, rollback.snapshot
					? { instanceId: registration.instanceId, snapshot: rollback.snapshot }
					: entry.previousBaseline);
				if (!rollback.rolledBack) {
					failures.push({ providerId: registration.providerId, stage: "rollback", message: "provider reported an incomplete rollback" });
				}
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "rollback", message: errorMessage(error) });
			}
		}
	}
}

function emptyOutcome(status: SettingsApplyStatus): SettingsApplyOutcome {
	return outcome(status, undefined, [], [], [], [], {});
}

function outcome(
	status: SettingsApplyStatus,
	transactionId: string | undefined,
	issues: readonly SettingsValidationIssue[],
	conflicts: readonly SettingsResourceConflict[],
	failures: readonly SettingsProviderFailure[],
	activation: readonly SettingsActivationPlan[],
	runtime: Readonly<Record<string, SettingsApplyRuntimeResultV1>>,
): SettingsApplyOutcome {
	return { status, transactionId, issues, conflicts, failures, activation, runtime };
}
