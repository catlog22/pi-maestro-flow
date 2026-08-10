import fs from "node:fs";
import path from "node:path";

/**
 * Atomic JSON state write for .experts-mode.json (and similar).
 * Writes to a temp file in the same directory then renames (best-effort
 * atomic on Windows with short retries).
 */
export function writeJsonStateFile(
  filePath: string,
  data: unknown,
  opts: { retries?: number } = {},
): void {
  const file = path.resolve(filePath);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(tmp, payload, "utf8");
      try {
        fs.renameSync(tmp, file);
      } catch {
        // Windows: replace existing target
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
        fs.renameSync(tmp, file);
      }
      return;
    } catch (err) {
      lastErr = err;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  // Last resort: direct write so callers still persist state
  try {
    fs.writeFileSync(file, payload, "utf8");
  } catch (err) {
    throw lastErr || err;
  }
}

export function readJsonStateFile(filePath: string): Record<string, unknown> {
  const file = path.resolve(filePath);
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
