import { createHash } from "node:crypto";
import { applyPiConfigPayload } from "../../src/gateway/pi-config-apply.ts";

const [root, provider, delayText = "0", mode = "normal"] = process.argv.slice(2);
if (!root || !provider) throw new Error("worker arguments required");
const body = Buffer.from(JSON.stringify({ providers: { [provider]: { models: [] } } }));
const header = Buffer.from(`${JSON.stringify({ version: 1, entries: [{ category: "models", bytes: body.length, digest: createHash("sha256").update(body).digest("hex") }] })}\n`);
const payload = Buffer.concat([header, body]);
try {
  let announced = false;
  await applyPiConfigPayload(payload, {
    homeDirectory: root,
    platform: "linux",
    enforcePrivate: async () => undefined,
    beforePublish: async () => {
      if (!announced) { announced = true; process.stdout.write("locked\n"); }
      await new Promise((resolve) => setTimeout(resolve, Number(delayText)));
    },
    fault: async (point) => { if (mode === "crash" && point === "publish:durable") process.exit(79); },
  });
  process.stdout.write("done\n");
} finally {
  body.fill(0); header.fill(0); payload.fill(0);
}
