// Central invalidation fan-out for memoized web-search.json provider configs.
//
// Provider modules memoize their parsed web-search.json view for process
// lifetime. When WebAccessConfigSync rewrites the file, every memoized view
// must be dropped or providers keep serving stale credentials/endpoints.
// Each provider registers its cache reset here; the sync calls
// invalidateWebConfigCaches() after a successful write.
//
// Security policy loaders (ssrf-protection.ts) deliberately do NOT register:
// SSRF ranges and domain policy must stay live reads on every request.

export type WebConfigInvalidator = () => void;

const invalidators = new Set<WebConfigInvalidator>();

/** Register a provider config cache reset. Returns an unregister function. */
export function registerWebConfigInvalidator(invalidator: WebConfigInvalidator): () => void {
	invalidators.add(invalidator);
	return () => {
		invalidators.delete(invalidator);
	};
}

/** Drop every registered provider config cache. One failing reset must not block the others. */
export function invalidateWebConfigCaches(): void {
	for (const invalidator of [...invalidators]) {
		try {
			invalidator();
		} catch {
			// Registered resets are trivial null-assignments; a throwing one
			// must not prevent the remaining providers from invalidating.
		}
	}
}

/** Test only: number of registered invalidators. */
export function webConfigInvalidatorCountForTesting(): number {
	return invalidators.size;
}
