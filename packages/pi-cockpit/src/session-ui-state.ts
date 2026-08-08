export type SessionUiMode = "agent" | "window";

export interface EndpointUiState {
	draft: string;
	unread: number;
	lastSeenRevision: string | undefined;
	scroll: number;
	followTail: boolean;
	detail: boolean;
}

export interface SessionUiEndpointDescriptor {
	id: string;
	logicalKey: string;
	outputRevision?: string;
}

export interface SessionUiReconcileResult {
	previousSelectedId: string | undefined;
	selectedId: string | undefined;
	selectionChanged: boolean;
	fellBack: boolean;
}

function initialEndpointState(): EndpointUiState {
	return {
		draft: "",
		unread: 0,
		lastSeenRevision: undefined,
		scroll: 0,
		followTail: true,
		detail: true,
	};
}

function mergeState(source: EndpointUiState, destination: EndpointUiState | undefined): EndpointUiState {
	if (!destination) return source;
	return {
		draft: source.draft || destination.draft,
		unread: Math.max(source.unread, destination.unread),
		lastSeenRevision: source.lastSeenRevision ?? destination.lastSeenRevision,
		scroll: source.scroll,
		followTail: source.followTail,
		detail: source.detail,
	};
}

/** Stateful controller shared by Agent Bar now and Window Bar later. */
export class SessionUiState {
	#mode: SessionUiMode = "agent";
	#states = new Map<string, EndpointUiState>();
	#observedRevisions = new Map<string, string>();
	#selectedByMode = new Map<SessionUiMode, string>();
	#logicalIds = new Map<string, string>();

	get mode(): SessionUiMode {
		return this.#mode;
	}

	setMode(mode: SessionUiMode): void {
		this.#mode = mode;
	}

	selectedId(mode: SessionUiMode = this.#mode): string | undefined {
		return this.#selectedByMode.get(mode);
	}

	endpoint(id: string): Readonly<EndpointUiState> {
		return { ...this.#ensure(id) };
	}

	select(id: string, mode: SessionUiMode = this.#mode): void {
		this.#selectedByMode.set(mode, id);
		const state = this.#ensure(id);
		state.unread = 0;
		state.lastSeenRevision = this.#observedRevisions.get(id) ?? state.lastSeenRevision;
	}

	setDraft(id: string, draft: string): void {
		this.#ensure(id).draft = draft;
	}

	setScroll(id: string, scroll: number, followTail: boolean): void {
		const state = this.#ensure(id);
		state.scroll = Math.max(0, Number.isFinite(scroll) ? Math.floor(scroll) : 0);
		state.followTail = followTail;
	}

	setDetail(id: string, detail: boolean): void {
		this.#ensure(id).detail = detail;
	}

	toggleDetail(id: string): boolean {
		const state = this.#ensure(id);
		state.detail = !state.detail;
		return state.detail;
	}

	clearUnread(id: string): void {
		const state = this.#ensure(id);
		state.unread = 0;
		state.lastSeenRevision = this.#observedRevisions.get(id) ?? state.lastSeenRevision;
	}

	observeOutput(id: string, revision: string | undefined, mode: SessionUiMode = this.#mode): void {
		if (!revision || this.#observedRevisions.get(id) === revision) return;
		this.#observedRevisions.set(id, revision);
		const state = this.#ensure(id);
		if (this.#mode === mode && this.#selectedByMode.get(mode) === id) {
			state.unread = 0;
			state.lastSeenRevision = revision;
		} else {
			state.unread = Math.min(999, state.unread + 1);
		}
	}

	reconcile(
		mode: SessionUiMode,
		endpoints: readonly SessionUiEndpointDescriptor[],
		fallbackId: string | undefined,
	): SessionUiReconcileResult {
		const previousSelectedId = this.#selectedByMode.get(mode);
		for (const endpoint of endpoints) {
			const logicalKey = `${mode}:${endpoint.logicalKey}`;
			const previousId = this.#logicalIds.get(logicalKey);
			if (previousId && previousId !== endpoint.id) this.#migrate(previousId, endpoint.id);
			this.#logicalIds.set(logicalKey, endpoint.id);
			this.#ensure(endpoint.id);
		}

		const available = new Set(endpoints.map((endpoint) => endpoint.id));
		let selectedId = this.#selectedByMode.get(mode);
		let fellBack = false;
		if (!selectedId || !available.has(selectedId)) {
			selectedId = fallbackId && available.has(fallbackId) ? fallbackId : endpoints[0]?.id;
			fellBack = previousSelectedId !== undefined && previousSelectedId !== selectedId;
			if (selectedId) this.select(selectedId, mode);
			else this.#selectedByMode.delete(mode);
		}

		for (const endpoint of endpoints) {
			this.observeOutput(endpoint.id, endpoint.outputRevision, mode);
		}
		selectedId = this.#selectedByMode.get(mode);
		return {
			previousSelectedId,
			selectedId,
			selectionChanged: previousSelectedId !== selectedId,
			fellBack,
		};
	}

	reset(): void {
		this.#mode = "agent";
		this.#states.clear();
		this.#observedRevisions.clear();
		this.#selectedByMode.clear();
		this.#logicalIds.clear();
	}

	#ensure(id: string): EndpointUiState {
		let state = this.#states.get(id);
		if (!state) {
			state = initialEndpointState();
			this.#states.set(id, state);
		}
		return state;
	}

	#migrate(previousId: string, nextId: string): void {
		const previous = this.#states.get(previousId);
		if (previous) {
			this.#states.set(nextId, mergeState(previous, this.#states.get(nextId)));
			this.#states.delete(previousId);
		}
		const observed = this.#observedRevisions.get(previousId);
		if (observed) {
			this.#observedRevisions.set(nextId, observed);
			this.#observedRevisions.delete(previousId);
		}
		for (const [mode, selectedId] of this.#selectedByMode) {
			if (selectedId === previousId) this.#selectedByMode.set(mode, nextId);
		}
	}
}
