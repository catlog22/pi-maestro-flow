export function createDynamicTuiReference<T extends object>(renderer: T): T {
	return new Proxy({} as T, {
		get(_target, property) {
			const value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const current = Reflect.get(renderer, property, renderer);
				if (typeof current !== "function") throw new TypeError(`${String(property)} is not callable`);
				return Reflect.apply(current, renderer, args);
			};
		},
		set(_target, property, value) {
			return Reflect.set(renderer, property, value, renderer);
		},
	});
}
