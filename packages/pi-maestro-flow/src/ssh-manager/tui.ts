import {
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  rule,
  type FrameTheme,
} from "pi-cockpit/src/settings/ui-primitives.ts";
import type { SshHost } from "./model.ts";

export interface SshManagerTheme extends FrameTheme {}

export interface MaskedSecretInputParams {
  title: string;
  prompt: string;
  theme: SshManagerTheme;
  requestRender: () => void;
  done: (secret: string | undefined) => void;
  maximumLength?: number;
}

export class MaskedSecretInput implements Component, Focusable {
  focused = false;
  private value = "";

  constructor(private readonly params: MaskedSecretInputParams) {}

  invalidate(): void {}

  dispose(): void {
    this.value = "";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) return [fit("Secret input · Esc", safeWidth)];
    const inner = safeWidth - 2;
    const masked = this.value.length > 0 ? "*".repeat(Math.min(this.value.length, Math.max(1, inner - 4))) : "";
    return frame([
      headerLine(this.params.theme, this.params.title, [], inner),
      rule(inner),
      helpLine(this.params.theme, this.params.prompt, inner),
      fit(`› ${masked}`, inner),
      rule(inner),
      fit("Enter confirm · Esc cancel · Ctrl+U clear · Backspace delete", inner),
    ], safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.value = "";
      this.params.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      const result = this.value;
      this.value = "";
      this.params.done(result);
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
      this.value = removeLastGrapheme(this.value);
      this.params.requestRender();
      return;
    }
    if (data === "\x15" || matchesKey(data, Key.ctrl("u"))) {
      this.value = "";
      this.params.requestRender();
      return;
    }
    if (data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return;
    const printable = sanitizeSecretInput(data);
    if (!printable) return;
    const maximum = this.params.maximumLength ?? 4096;
    this.value = [...`${this.value}${printable}`].slice(0, maximum).join("");
    this.params.requestRender();
  }
}

export type SshHostManagerActionKind = "select" | "add" | "edit" | "delete" | "test" | "lock" | "close";

export interface SshHostManagerAction {
  kind: SshHostManagerActionKind;
  hostId?: string;
  query: string;
}

export interface SshHostManagerParams {
  hosts: readonly SshHost[];
  theme: SshManagerTheme;
  requestRender: () => void;
  done: (action: SshHostManagerAction) => void;
  initialQuery?: string;
  notice?: string;
}

const MAX_VISIBLE_HOSTS = 12;

export class SshHostManagerOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private filtering = false;
  private selected = 0;

  constructor(private readonly params: SshHostManagerParams) {
    this.query = params.initialQuery ?? "";
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const hosts = this.filteredHosts();
    this.selected = clampIndex(this.selected, hosts.length);
    if (safeWidth < 20) return [fit(`SSH hosts · ${hosts.length} · Esc`, safeWidth)];
    const inner = safeWidth - 2;
    const rows: string[] = [
      headerLine(this.params.theme, "SSH Server Manager", [`${hosts.length}/${this.params.hosts.length}`], inner),
      rule(inner),
    ];
    if (hosts.length === 0) {
      const empty = this.params.hosts.length === 0
        ? "○ no SSH servers configured"
        : "○ no hosts match the current filter";
      rows.push(fit(this.params.theme.fg("warning", empty), inner));
      if (this.params.hosts.length === 0) rows.push(fit("Press A to add your first SSH server.", inner));
    } else {
      const start = visibleStart(this.selected, hosts.length, MAX_VISIBLE_HOSTS);
      for (let offset = 0; offset < Math.min(MAX_VISIBLE_HOSTS, hosts.length); offset += 1) {
        const index = start + offset;
        const host = hosts[index]!;
        const marker = index === this.selected ? this.params.theme.fg("accent", "›") : " ";
        const label = index === this.selected ? this.params.theme.bold(host.label) : host.label;
        const summary = `${label} · ${host.user}@${host.host}:${host.port} · ${host.shell} · ${authKindLabel(host)}`;
        rows.push(fit(`${marker} ${summary}`, inner));
      }
    }
    rows.push(helpLine(this.params.theme, this.filtering
      ? `Filtering: ${this.query || "type a label, host, or user"} · Esc clear`
      : `Filter: press / then type · showing ${hosts.length}`, inner));
    if (this.params.notice) rows.push(fit(this.params.theme.fg("warning", this.params.notice), inner));
    rows.push(rule(inner), fitSegments(inner, [
      "Esc close", "↑↓ select", "/ filter", "Enter use", "A add", "E edit", "D delete", "T test", "L lock",
    ]));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filtering) {
        this.filtering = false;
        this.query = "";
        this.selected = 0;
        this.params.requestRender();
      } else {
        this.finish("close", false);
      }
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE_HOSTS);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE_HOSTS);

    if (this.filtering) {
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
        this.query = removeLastGrapheme(this.query);
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      if (data.startsWith("\x1b")) return;
      const printable = sanitizeSingleLine(data);
      if (!printable) return;
      this.query = `${this.query}${printable}`.slice(0, 256);
      this.selected = 0;
      this.params.requestRender();
      return;
    }

    if (data === "/") {
      this.filtering = true;
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") return this.finish("select", true);
    if (data === "a" || data === "A") return this.finish("add", false);
    if (data === "e" || data === "E") return this.finish("edit", true);
    if (data === "d" || data === "D") return this.finish("delete", true);
    if (data === "t" || data === "T") return this.finish("test", true);
    if (data === "l" || data === "L") return this.finish("lock", false);
  }

  private filteredHosts(): SshHost[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return this.params.hosts.filter((host) => {
      const haystack = `${host.label} ${host.host} ${host.user} ${host.port} ${host.shell}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private move(delta: number): void {
    const count = this.filteredHosts().length;
    this.selected = count === 0 ? 0 : (this.selected + delta % count + count) % count;
    this.params.requestRender();
  }

  private finish(kind: SshHostManagerActionKind, needsHost: boolean): void {
    const host = this.filteredHosts()[this.selected];
    if (needsHost && !host) return;
    this.params.done({ kind, ...(host ? { hostId: host.id } : {}), query: this.query });
  }
}

function authKindLabel(host: SshHost): string {
  if (host.auth.kind === "identity") return "identity";
  if (host.auth.kind === "password") return "password";
  return "agent";
}

function sanitizeSecretInput(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/[\r\n\x00-\x1f\x7f]/gu, "");
}

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n\t\x00-\x1f\x7f]/gu, "");
}

function removeLastGrapheme(value: string): string {
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  const parts = segmenter ? [...segmenter.segment(value)].map((entry) => entry.segment) : [...value];
  parts.pop();
  return parts.join("");
}

function visibleStart(selected: number, length: number, maximum: number): number {
  return length <= maximum ? 0 : Math.min(Math.max(0, selected - maximum + 1), length - maximum);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(0, index), length - 1);
}

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  return fit(kept.length > 0 ? kept.join(" · ") : segments[0] ?? "", width);
}
