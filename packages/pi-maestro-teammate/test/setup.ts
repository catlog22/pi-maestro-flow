import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeTuiLocale } from "../src/tui/locale.ts";

// Legacy render assertions use the historical English default. Locale-specific
// tests set and restore their own runtime locale explicitly.
initializeTuiLocale("en");

// An empty agent directory, so no test reads the developer's own Pi
// configuration.
//
// `backendRegistryConfigSync` falls back to `<agent dir>/teammate-backends.json`
// when a workspace has no document of its own, which put every dispatch test at
// the mercy of whatever backends the machine running them happens to register:
// a developer with a real registration document saw unrelated tests fail with
// that document's backend names, and the suite passed or failed by home
// directory rather than by code. Runs before every test module, so a file
// needing a populated directory sets its own at module scope and wins.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "teammate-test-agent-"));

// Legacy-focused tests opt out explicitly; rollout tests pass their own env and
// sidecar tests exercise the default-on broker bootstrap in isolation.
process.env.PI_RUNTIME_BROKER = "off";
process.env.PI_RUNTIME_V2_READ = "0";
