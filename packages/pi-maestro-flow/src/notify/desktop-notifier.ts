import { spawn } from "node:child_process";

export type DesktopNotificationTarget = "windows" | "osc777" | "osc9" | "osc99";

export interface DesktopNotificationOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  write?: (value: string) => boolean;
  spawnProcess?: typeof spawn;
}

export function detectDesktopNotificationTarget(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DesktopNotificationTarget {
  if (platform === "win32" || env.WT_SESSION) return "windows";
  if (env.KITTY_WINDOW_ID) return "osc99";
  if (env.TERM_PROGRAM === "iTerm.app" || env.ITERM_SESSION_ID) return "osc9";
  return "osc777";
}

export function sanitizeNotificationText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function buildWindowsToastScript(title: string, body: string): string {
  const safeTitle = escapePowerShellSingleQuoted(sanitizeNotificationText(title));
  const safeBody = escapePowerShellSingleQuoted(sanitizeNotificationText(body));
  const type = "Windows.UI.Notifications";
  const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText02`;
  return [
    `${manager} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$text = $xml.GetElementsByTagName('text')`,
    `$text.Item(0).AppendChild($xml.CreateTextNode('${safeTitle}')) > $null`,
    `$text.Item(1).AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
    `$toast = [${type}.ToastNotification]::new($xml)`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)`,
  ].join("; ");
}

export function buildOscNotification(
  target: Exclude<DesktopNotificationTarget, "windows">,
  title: string,
  body: string,
  tmux = false,
): string {
  const safeTitle = sanitizeOscField(title);
  const safeBody = sanitizeOscField(body);
  const sequence = target === "osc99"
    ? `\x1b]99;i=pi-maestro:d=0;${safeTitle}\x1b\\\x1b]99;i=pi-maestro:p=body;${safeBody}\x1b\\`
    : target === "osc9"
      ? `\x1b]9;${safeTitle}: ${safeBody}\x07`
      : `\x1b]777;notify;${safeTitle};${safeBody}\x07`;
  return tmux ? wrapForTmux(sequence) : sequence;
}

/**
 * Send a native notification. Terminal protocols delegate foreground
 * suppression and click-to-focus behavior to the terminal itself.
 */
export function sendDesktopNotification(
  title: string,
  body: string,
  options: DesktopNotificationOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const target = detectDesktopNotificationTarget(env, platform);
  try {
    if (target === "windows") {
      const spawnProcess = options.spawnProcess ?? spawn;
      const child = spawnProcess(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", buildWindowsToastScript(title, body)],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.on("error", () => {});
      child.unref();
      return true;
    }
    const write = options.write ?? process.stdout.write.bind(process.stdout);
    write(buildOscNotification(target, title, body, Boolean(env.TMUX)));
    return true;
  } catch {
    return false;
  }
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function sanitizeOscField(value: string): string {
  return sanitizeNotificationText(value).replaceAll(";", ":");
}

function wrapForTmux(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}
