type LogLevel = "debug" | "info" | "warn" | "error";

function enabled(): boolean {
  const flag = process.env.PI_GUI_DEBUG;
  return flag === "1" || flag === "true";
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!enabled()) return;
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  process.stderr.write(`[GUI:${level.toUpperCase()}] ${message}${suffix}\n`);
}

export const guiLogger = {
  debug: (message: string, context?: Record<string, unknown>) => write("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
};
