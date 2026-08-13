export function createSwitchingDynamicTuiReference<T extends object>(getRenderer: () => T): T {
	return new Proxy({} as T, {
		get(_target, property) {
			const renderer = getRenderer();
			const value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			let methodRenderer = renderer;
			let method = value;
			return (...args: unknown[]) => {
				const currentRenderer = getRenderer();
				if (currentRenderer !== methodRenderer) {
					const current = Reflect.get(currentRenderer, property, currentRenderer);
					if (typeof current !== "function") throw new TypeError(`${String(property)} is not callable`);
					methodRenderer = currentRenderer;
					method = current;
				}
				return Reflect.apply(method, methodRenderer, args);
			};
		},
		set(_target, property, value) {
			const renderer = getRenderer();
			return Reflect.set(renderer, property, value, renderer);
		},
		has(_target, property) {
			return Reflect.has(getRenderer(), property);
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(getRenderer());
		},
	});
}

export function createDynamicTuiReference<T extends object>(renderer: T): T {
	return createSwitchingDynamicTuiReference(() => renderer);
}
