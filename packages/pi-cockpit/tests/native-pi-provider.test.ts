import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue, SettingsChange, SettingsContextV1 } from "pi-maestro-settings-core/v1";
import { createNativePiSettingsProvider } from "../src/settings/native-pi-provider.ts";

const context: SettingsContextV1 = { cwd: "/workspace", locale: "en" };

interface TempSandbox {
	directory: string;
	globalPath: string;
	projectPath: string;
}

function tempSandbox(): TempSandbox {
	const directory = mkdtempSync(join(tmpdir(), "native-pi-provider-"));
	const globalPath = join(directory, "agent", "settings.json");
	const projectPath = join(directory, "project", ".pi", "settings.json");
	mkdirSync(join(directory, "agent"), { recursive: true });
	mkdirSync(join(directory, "project", ".pi"), { recursive: true });
	return { directory, globalPath, projectPath };
}

function providerAt(sandbox: TempSandbox) {
	const provider = createNativePiSettingsProvider({
		getGlobalPath: () => sandbox.globalPath,
		getProjectPath: () => sandbox.projectPath,
	});
	return provider;
}

function setChange(key: string, value: JsonValue, scope: "global" | "project" = "global"): SettingsChange {
	return { operation: "set", key, scope, value };
}

test("native-pi provider describes the high-value Pi settings", async () => {
	const sandbox = tempSandbox();
	try {
		const provider = providerAt(sandbox);
		const description = await provider.describe({ context });
		assert.equal(description.id, "pi-native");
		assert.equal(description.capabilities.write, true);
		const keys = description.settings.map((setting) => setting.key);
		assert.ok(keys.includes("defaultModel"), "model key present");
		assert.ok(keys.includes("defaultThinkingLevel"));
		assert.ok(keys.includes("terminal.showImages"));
		assert.ok(keys.includes("transport"));
		assert.ok(keys.includes("httpProxy"));
		assert.equal(keys.includes("compaction.enabled"), false, "compaction.* is owned solely by the flow provider (dedup)");
		assert.equal(keys.includes("retry.enabled"), true);
		const model = description.settings.find((setting) => setting.key === "defaultModel")!;
		assert.equal(model.editor.kind, "model");
		const trust = description.settings.find((setting) => setting.key === "defaultProjectTrust")!;
		assert.deepEqual(trust.scopes, ["global"], "defaultProjectTrust is global-only");
		assert.ok(description.settings.length >= 30, `expected a substantial surface, got ${description.settings.length}`);
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("read reports defaults, global and project overrides with effective merge", async () => {
	const sandbox = tempSandbox();
	try {
		writeFileSync(sandbox.globalPath, JSON.stringify({ defaultModel: "gpt-5.6-sol", hideThinkingBlock: true }, null, 2));
		writeFileSync(sandbox.projectPath, JSON.stringify({ defaultModel: "deepseek-v4-flash" }, null, 2));
		const provider = providerAt(sandbox);
		const snapshot = await provider.read({ context });
		const effective = (key: string) => snapshot.effective.values.find((entry) => entry.key === key);
		assert.equal(effective("defaultModel")?.value, "deepseek-v4-flash", "project overrides global");
		assert.equal(effective("defaultModel")?.scope, "project");
		assert.equal(effective("hideThinkingBlock")?.value, true, "global value falls through");
		assert.equal(effective("theme")?.value, "", "unset key falls back to default");
		assert.equal(effective("defaultThinkingLevel")?.value, "medium", "default value when unset anywhere");
		const configuredGlobal = snapshot.configured.values.filter((entry) => entry.scope === "global");
		assert.ok(configuredGlobal.some((entry) => entry.key === "hideThinkingBlock"), "global configured values present");
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("prepare+commit writes to the scoped file and preserves unknown keys", async () => {
	const sandbox = tempSandbox();
	try {
		writeFileSync(sandbox.globalPath, JSON.stringify({ theme: "dark", customKey: { nested: true } }, null, 2));
		const provider = providerAt(sandbox);
		const prepared = await provider.prepare!({
			context,
			transactionId: "t1",
			changes: [setChange("theme", "light"), setChange("defaultThinkingLevel", "high")],
		});
		assert.equal(prepared.prepared, true);
		const committed = await provider.commit!({ context, transactionId: "t1", prepareToken: prepared.prepareToken! });
		assert.ok(committed.changedKeys.includes("theme"));
		const written = JSON.parse(readFileSync(sandbox.globalPath, "utf8"));
		assert.equal(written.theme, "light", "theme written to global file");
		assert.equal(written.defaultThinkingLevel, "high");
		assert.deepEqual(written.customKey, { nested: true }, "unknown keys preserved");
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("project-scope change writes to the project file, not the global one", async () => {
	const sandbox = tempSandbox();
	try {
		writeFileSync(sandbox.globalPath, JSON.stringify({ defaultModel: "gpt-5.6-sol" }, null, 2));
		const provider = providerAt(sandbox);
		const prepared = await provider.prepare!({
			context,
			transactionId: "t2",
			changes: [setChange("defaultModel", "grok-4.5", "project")],
		});
		await provider.commit!({ context, transactionId: "t2", prepareToken: prepared.prepareToken! });
		assert.equal(JSON.parse(readFileSync(sandbox.projectPath, "utf8")).defaultModel, "grok-4.5");
		assert.equal(JSON.parse(readFileSync(sandbox.globalPath, "utf8")).defaultModel, "gpt-5.6-sol", "global file untouched");
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("validation rejects unknown keys, global-only scope misuse and bad values", async () => {
	const sandbox = tempSandbox();
	try {
		const provider = providerAt(sandbox);
		const unknown = await provider.validate({
			context,
			transactionId: "t3",
			changes: [setChange("not.a.real.key", 1)],
		});
		assert.equal(unknown.valid, false);
		const globalOnlyInProject = await provider.validate({
			context,
			transactionId: "t3",
			changes: [setChange("httpProxy", "http://x", "project")],
		});
		assert.equal(globalOnlyInProject.valid, false);
		const badEnum = await provider.validate({
			context,
			transactionId: "t3",
			changes: [setChange("transport", "carrier-pigeon")],
		});
		assert.equal(badEnum.valid, false);
		const ok = await provider.validate({
			context,
			transactionId: "t3",
			changes: [setChange("transport", "websocket")],
		});
		assert.equal(ok.valid, true);
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("unset removes the key from the scoped file", async () => {
	const sandbox = tempSandbox();
	try {
		writeFileSync(sandbox.globalPath, JSON.stringify({ theme: "dark", quietStartup: true }, null, 2));
		const provider = providerAt(sandbox);
		const prepared = await provider.prepare!({
			context,
			transactionId: "t4",
			changes: [{ operation: "unset", key: "theme", scope: "global" }],
		});
		await provider.commit!({ context, transactionId: "t4", prepareToken: prepared.prepareToken! });
		const written = JSON.parse(readFileSync(sandbox.globalPath, "utf8"));
		assert.equal(written.theme, undefined, "unset removes the key");
		assert.equal(written.quietStartup, true, "sibling keys preserved");
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("rollback restores the prior file content", async () => {
	const sandbox = tempSandbox();
	try {
		writeFileSync(sandbox.globalPath, JSON.stringify({ theme: "dark" }, null, 2));
		const provider = providerAt(sandbox);
		const prepared = await provider.prepare!({
			context,
			transactionId: "t5",
			changes: [setChange("theme", "light")],
		});
		await provider.commit!({ context, transactionId: "t5", prepareToken: prepared.prepareToken! });
		assert.equal(JSON.parse(readFileSync(sandbox.globalPath, "utf8")).theme, "light");
		await provider.rollback!({ context, transactionId: "t5", prepareToken: prepared.prepareToken!, committedRevisions: [] });
		assert.equal(JSON.parse(readFileSync(sandbox.globalPath, "utf8")).theme, "dark", "rollback restores bytes");
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("invalid JSON in settings.json surfaces as an invalid configured state, not a crash", async () => {
	const sandbox = tempSandbox();
	try {
		writeFileSync(sandbox.globalPath, "{ not json");
		const provider = providerAt(sandbox);
		const snapshot = await provider.read({ context });
		const theme = snapshot.configured.values.find((entry) => entry.key === "theme");
		assert.equal(theme?.state, "invalid", "invalid document reported as invalid");
		assert.ok(theme?.messageKey, "invalid document carries an error message");
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});

test("keybindings action is handled and reports the keybindings path", async () => {
	const sandbox = tempSandbox();
	try {
		const provider = providerAt(sandbox);
		const result = await provider.invokeAction!({ context, actionId: "native.keybindings", key: "keybindings" });
		assert.equal(result.handled, true);
	} finally {
		rmSync(sandbox.directory, { recursive: true, force: true });
	}
});
