// Plain Node sidecar: no Pi SDK, TypeScript loader, or native imports in parent.
// JSON IPC: {id, method, args} -> {id, result: native Result} | {id, error}.
// init takes [InitOptions]; remaining methods take their native argument tuples.
// GrepCursor is already JSON-safe: {__brand: "GrepCursor", _offset: number}.
let finder;
let initialized;
let stopping = false;
const methods = new Set(["waitForScan", "grep", "glob", "fileSearch"]);

function stop() {
  if (stopping) return;
  stopping = true;
  // Do not await native cleanup (it might be the operation that crashed/hung).
  // Process exit reclaims the index, mmap cache and filesystem watchers.
  process.exit(0);
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
if (!process.send || !process.connected) stop();

function reply(message) {
  if (stopping || !process.connected) return;
  try {
    process.send(message, (error) => { if (error) stop(); });
  } catch {
    stop();
  }
}

async function handle(message) {
  if (stopping || !message || !Number.isSafeInteger(message.id) || !Array.isArray(message.args)) return;
  const { id, method, args } = message;
  try {
    if (method === "init") {
      if (initialized) throw new Error("FFF worker already initialized");
      initialized = (async () => {
        const { FileFinder } = await import("@ff-labs/fff-node");
        if (stopping || !process.connected) throw new Error("FFF parent disconnected");
        const created = FileFinder.create(args[0]);
        if (!created.ok) return created;
        finder = created.value;
        return { ok: true, value: true };
      })();
      reply({ id, result: await initialized });
      return;
    }
    if (!methods.has(method)) throw new Error(`Unknown FFF worker method: ${method}`);
    if (!initialized) throw new Error("FFF worker not initialized");
    const ready = await initialized;
    if (stopping || !process.connected) return;
    if (!ready.ok) {
      reply({ id, result: ready });
      return;
    }
    const result = await finder[method](...args);
    if (stopping || !process.connected) return;
    reply({ id, result });
  } catch (error) {
    reply({ id, error: error instanceof Error ? error.message : String(error) });
  }
}
process.on("message", (message) => { void handle(message).catch(stop); });
