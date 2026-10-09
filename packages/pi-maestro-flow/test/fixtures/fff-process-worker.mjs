// Test protocol matches bin/fff-worker.mjs: {id, method, args} requests and
// {id, result} / {id, error} replies. No startup handshake. init receives options.
import { writeFileSync } from "node:fs";
let options;
let calls = 0;
const reply = (id, result) => { if (process.connected) process.send({ id, result }); };
process.on("disconnect", () => process.exit(0));
process.on("message", ({ id, method, args }) => {
  calls++;
  if (method === "init") {
    options = args[0];
    if (options.basePath === "hang-init") {
      // A test-private PID marker proves initialization really began before destroy.
      if (options.logFilePath) writeFileSync(options.logFilePath, String(process.pid), { flag: "wx", mode: 0o600 });
      return;
    }
    if (options.basePath === "fail-init") {
      reply(id, { ok: false, error: "injected initialization failure" });
      return;
    }
    reply(id, { ok: true, value: true });
  } else if (method === "waitForScan") {
    if (options.basePath === "scan-failure") reply(id, { ok: false, error: "injected scan failure" });
    else reply(id, { ok: true, value: true });
  } else if (method === "grep") {
    if (args[0] === "hang") return;
    if (args[0] === "crash") {
      process.stderr.write("injected crash diagnostic\n", () => process.exit(23));
      return;
    }
    if (args[0] === "disconnect") {
      process.disconnect();
      return;
    }
    if (args[0] === "stderr-crash") {
      process.stderr.write("x".repeat(100_000) + "diagnostic-tail", () => process.exit(24));
      return;
    }
    reply(id, { ok: true, value: { items: [], totalMatched: 0, totalFilesSearched: 0, totalFiles: 0, filteredFileCount: 0, nextCursor: args[1]?.cursor ?? null } });
  } else {
    const meta = JSON.stringify({ pid: process.pid, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, options, calls });
    reply(id, { ok: true, value: { items: [{ relativePath: meta, fileName: "meta", size: 0, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" }], scores: [], totalMatched: 1, totalFiles: 1 } });
  }
});
