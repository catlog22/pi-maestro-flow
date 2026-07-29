import { createHash } from "node:crypto";
import {
  CODEX_HOOK_EVENTS,
  type CodexHookEvent,
  type CodexHookHandler,
  type LoadedCodexHooks,
} from "./schema.ts";

export interface HookReviewEntry {
  id: string;
  event: CodexHookEvent;
  matcher?: string;
  type: CodexHookHandler["type"];
  command: string;
  timeout?: number;
  supported: boolean;
  enabled: boolean;
}

export function hookHandlerIdentity(
  event: CodexHookEvent,
  matcher: string | undefined,
  handler: CodexHookHandler,
): string {
  const handlerIdentity = handler.type === "command"
    ? [handler.type, handler.command, handler.commandWindows ?? "", handler.async ?? false]
    : [handler.type, String(handler.prompt ?? "")];
  return JSON.stringify([event, matcher ?? "", ...handlerIdentity]);
}

export function hookHandlerId(
  event: CodexHookEvent,
  matcher: string | undefined,
  handler: CodexHookHandler,
  occurrence = 0,
): string {
  const identity = hookHandlerIdentity(event, matcher, handler);
  return createHash("sha256").update(`${identity}\0${occurrence}`).digest("hex").slice(0, 16);
}

export function sanitizeHookDisplayText(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return `\\x${codePoint.toString(16).padStart(2, "0")}`;
    }
    if (isUnsafeUnicodeFormat(codePoint)) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    return character;
  }).join("");
}

function isUnsafeUnicodeFormat(codePoint: number): boolean {
  return codePoint === 0x00ad
    || codePoint === 0x061c
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x2028 && codePoint <= 0x202e)
    || (codePoint >= 0x2060 && codePoint <= 0x206f)
    || codePoint === 0xfeff;
}

export function buildHookReviewEntries(
  loaded: LoadedCodexHooks,
  toggles: Readonly<Record<string, boolean>>,
): HookReviewEntry[] {
  const entries: HookReviewEntry[] = [];
  const occurrences = new Map<string, number>();
  for (const event of CODEX_HOOK_EVENTS) {
    for (const group of loaded.config.hooks[event] ?? []) {
      for (const handler of group.hooks) {
        const identity = hookHandlerIdentity(event, group.matcher, handler);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        const id = hookHandlerId(event, group.matcher, handler, occurrence);
        const supported = handler.type === "command" && !handler.async;
        entries.push({
          id,
          event,
          ...(group.matcher ? { matcher: sanitizeHookDisplayText(group.matcher) } : {}),
          type: handler.type,
          command: sanitizeHookDisplayText(handler.type === "command"
            ? process.platform === "win32" && handler.commandWindows
              ? handler.commandWindows
              : handler.command
            : String(handler.prompt ?? `${handler.type} handler`)),
          ...(handler.type === "command" ? { timeout: handler.timeout } : {}),
          supported,
          enabled: supported && toggles[id] !== false,
        });
      }
    }
  }
  return entries;
}
