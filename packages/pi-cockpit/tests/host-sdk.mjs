// Run Cockpit tests against an installed host without changing local dependencies:
// PI_COCKPIT_TEST_HOST=<absolute pi-coding-agent directory> node --import ./tests/host-sdk.mjs --test --experimental-transform-types <tests>
import { registerHooks } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const host = process.env.PI_COCKPIT_TEST_HOST;
if (!host || !isAbsolute(host)) throw new Error("PI_COCKPIT_TEST_HOST must be an absolute pi-coding-agent directory");
const hostPackageUrl = pathToFileURL(join(host, "package.json")).href;
const tuiReferenceUrl = pathToFileURL(join(host, "dist/modes/interactive/tui-renderer.js")).href;
const packages = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		// Exercise the host's actual switching proxy, not our copied test double.
		if (specifier.endsWith("/dynamic-tui-reference.ts")) return { url: import.meta.url, shortCircuit: true };
		const name = specifier.split("/").slice(0, 2).join("/");
		if (packages.has(name)) return nextResolve(specifier, { ...context, parentURL: hostPackageUrl });
		return nextResolve(specifier, context);
	},
});

const { createInteractiveTuiReference } = await import(tuiReferenceUrl);
export const createSwitchingDynamicTuiReference = createInteractiveTuiReference;
export const createDynamicTuiReference = renderer => createInteractiveTuiReference(() => renderer);
