import { randomUUID } from "node:crypto";
import {
	SETTINGS_ANNOUNCE_EVENT,
	SETTINGS_CHANGED_EVENT,
	SETTINGS_DISCOVER_EVENT,
	SETTINGS_LOCALE_EVENT,
	SETTINGS_PROTOCOL_VERSION,
	type SettingsAnnounceEventV1,
	type SettingsChangedEventV1,
	type SettingsContextV1,
	type SettingsLocaleEventV1,
	type SettingsProviderDescriptionV1,
	type SettingsProviderV1,
} from "pi-maestro-settings-core/v1";

export interface SettingsEventBus {
	on(event: string, handler: (payload: unknown) => void): void | (() => void);
	emit(event: string, payload: unknown): void;
}

export interface RegisteredSettingsProvider {
	providerId: string;
	instanceId: string;
	provider: SettingsProviderV1;
	announcedAt: number;
}

export interface DescribedSettingsProvider extends RegisteredSettingsProvider {
	description: SettingsProviderDescriptionV1;
}

function isProvider(value: unknown): value is SettingsProviderV1 {
	if (!value || typeof value !== "object") return false;
	const provider = value as Partial<SettingsProviderV1>;
	return typeof provider.describe === "function"
		&& typeof provider.read === "function"
		&& typeof provider.validate === "function";
}

function announcePayload(value: unknown): SettingsAnnounceEventV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Partial<SettingsAnnounceEventV1>;
	if (payload.version !== SETTINGS_PROTOCOL_VERSION) return undefined;
	if (typeof payload.providerId !== "string" || payload.providerId.length === 0) return undefined;
	if (typeof payload.instanceId !== "string" || payload.instanceId.length === 0) return undefined;
	if (!isProvider(payload.provider)) return undefined;
	return payload as SettingsAnnounceEventV1;
}

export class SettingsProviderRegistry {
	private readonly providers = new Map<string, RegisteredSettingsProvider>();
	private readonly descriptionErrors = new Map<string, string>();
	private unsubscribe: (() => void) | undefined;

	constructor(
		private readonly events: SettingsEventBus,
		private readonly now: () => number = Date.now,
	) {}

	start(): void {
		if (this.unsubscribe) return;
		const result = this.events.on(SETTINGS_ANNOUNCE_EVENT, (payload) => {
			const announcement = announcePayload(payload);
			if (!announcement) return;
			this.register(announcement);
		});
		this.unsubscribe = typeof result === "function" ? result : () => {};
	}

	discover(context: SettingsContextV1): string {
		this.start();
		this.providers.clear();
		this.descriptionErrors.clear();
		const requestId = randomUUID();
		this.events.emit(SETTINGS_DISCOVER_EVENT, {
			version: SETTINGS_PROTOCOL_VERSION,
			requestId,
			context,
		});
		return requestId;
	}

	register(announcement: SettingsAnnounceEventV1): RegisteredSettingsProvider {
		const current = this.providers.get(announcement.providerId);
		if (current?.instanceId === announcement.instanceId) return current;
		const registration: RegisteredSettingsProvider = {
			providerId: announcement.providerId,
			instanceId: announcement.instanceId,
			provider: announcement.provider,
			announcedAt: this.now(),
		};
		this.providers.set(registration.providerId, registration);
		return registration;
	}

	get(providerId: string): RegisteredSettingsProvider | undefined {
		return this.providers.get(providerId);
	}

	isCurrent(providerId: string, instanceId: string): boolean {
		return this.providers.get(providerId)?.instanceId === instanceId;
	}

	list(): RegisteredSettingsProvider[] {
		return [...this.providers.values()].sort((left, right) =>
			left.providerId.localeCompare(right.providerId)
		);
	}

	async describe(context: SettingsContextV1): Promise<DescribedSettingsProvider[]> {
		this.descriptionErrors.clear();
		const described: DescribedSettingsProvider[] = [];
		await Promise.all(this.list().map(async (registration) => {
			try {
				const description = await registration.provider.describe({ context });
				if (description.id !== registration.providerId || description.instanceId !== registration.instanceId) {
					this.descriptionErrors.set(registration.providerId, "provider description identity mismatch");
					return;
				}
				described.push({ ...registration, description });
			} catch (error) {
				this.descriptionErrors.set(
					registration.providerId,
					error instanceof Error ? error.message : String(error),
				);
			}
		}));
		return described.sort((left, right) =>
			(left.description.order ?? 0) - (right.description.order ?? 0)
			|| left.providerId.localeCompare(right.providerId)
		);
	}

	descriptionError(providerId: string): string | undefined {
		return this.descriptionErrors.get(providerId);
	}

	emitChanged(payload: Omit<SettingsChangedEventV1, "version">): void {
		this.events.emit(SETTINGS_CHANGED_EVENT, {
			version: SETTINGS_PROTOCOL_VERSION,
			...payload,
		});
	}

	emitLocale(locale: SettingsLocaleEventV1["locale"], generation: string = randomUUID()): string {
		this.events.emit(SETTINGS_LOCALE_EVENT, {
			version: SETTINGS_PROTOCOL_VERSION,
			locale,
			generation,
		});
		return generation;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.providers.clear();
		this.descriptionErrors.clear();
	}
}
