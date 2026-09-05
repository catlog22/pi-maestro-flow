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
import type { SshHost, SshKey } from "./model.ts";
import type { SshHostOperationalStatus } from "./status-monitor.ts";

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
  dispose(): void { this.value = ""; }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) return [fit("Secret input · Esc", safeWidth)];
    const inner = safeWidth - 2;
    const masked = this.value.length > 0 ? "*".repeat(Math.min(this.value.length, Math.max(1, inner - 4))) : "";
    return frame([
      headerLine(this.params.theme, this.params.title, [], inner), rule(inner),
      helpLine(this.params.theme, this.params.prompt, inner), fit(`› ${masked}`, inner), rule(inner),
      fit("Enter confirm · Esc cancel · Ctrl+U clear · Backspace delete", inner),
    ], safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.value = ""; this.params.done(undefined); return; }
    if (matchesKey(data, Key.enter) || data === "\r") { const result = this.value; this.value = ""; this.params.done(result); return; }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") { this.value = removeLastGrapheme(this.value); this.params.requestRender(); return; }
    if (data === "\x15" || matchesKey(data, Key.ctrl("u"))) { this.value = ""; this.params.requestRender(); return; }
    if (data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return;
    const printable = sanitizeSecretInput(data);
    if (!printable) return;
    this.value = [...`${this.value}${printable}`].slice(0, this.params.maximumLength ?? 4096).join("");
    this.params.requestRender();
  }
}

export type SshManagerView = "hosts" | "keys";
export type SshHostManagerActionKind =
  | "select" | "add" | "edit" | "delete" | "test" | "reset" | "import"
  | "add-key" | "edit-key" | "replace-key" | "delete-key" | "lock" | "close";

export interface SshHostManagerAction {
  kind: SshHostManagerActionKind;
  hostId?: string;
  keyId?: string;
  query: string;
  view?: SshManagerView;
}

export interface SshHostManagerParams {
  hosts: readonly SshHost[];
  keys?: readonly SshKey[];
  statuses?: ReadonlyMap<string, SshHostOperationalStatus>;
  theme: SshManagerTheme;
  requestRender: () => void;
  done: (action: SshHostManagerAction) => void;
  initialQuery?: string;
  initialView?: SshManagerView;
  notice?: string;
}

const MAX_VISIBLE_ROWS = 12;

export class SshHostManagerOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private filtering = false;
  private selected = 0;
  private view: SshManagerView;

  constructor(private readonly params: SshHostManagerParams) {
    this.query = params.initialQuery ?? "";
    this.view = params.initialView ?? "hosts";
  }
  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const rowsForView = this.view === "hosts" ? this.filteredHosts() : this.filteredKeys();
    this.selected = clampIndex(this.selected, rowsForView.length);
    if (safeWidth < 20) return [fit(`SSH ${this.view} · ${rowsForView.length} · Esc`, safeWidth)];
    const inner = safeWidth - 2;
    const total = this.view === "hosts" ? this.params.hosts.length : (this.params.keys?.length ?? 0);
    const rows: string[] = [
      headerLine(this.params.theme, "SSH Manager", [`[${this.view === "hosts" ? "Hosts" : "Keys"}]`, `${rowsForView.length}/${total}`], inner),
      rule(inner),
    ];
    if (rowsForView.length === 0) {
      const empty = total === 0 ? (this.view === "hosts" ? "○ no SSH servers configured" : "○ no SSH keys configured") : `○ no ${this.view} match the current filter`;
      rows.push(fit(this.params.theme.fg("warning", empty), inner));
      if (total === 0) rows.push(fit(this.view === "hosts" ? "Press A to add your first SSH server; I imports OpenSSH config." : "Press A to import a private key from an explicit path.", inner));
    } else {
      const start = visibleStart(this.selected, rowsForView.length, MAX_VISIBLE_ROWS);
      for (let offset = 0; offset < Math.min(MAX_VISIBLE_ROWS, rowsForView.length); offset += 1) {
        const index = start + offset;
        const value = rowsForView[index]!;
        const marker = index === this.selected ? this.params.theme.fg("accent", "›") : " ";
        const summary = this.view === "hosts" ? this.hostSummary(value as SshHost, index === this.selected) : this.keySummary(value as SshKey, index === this.selected);
        rows.push(fit(`${marker} ${summary}`, inner));
      }
    }
    rows.push(helpLine(this.params.theme, this.filtering
      ? `Filtering: ${this.query || "type label, endpoint, user, or tag"} · Esc clear`
      : `Tab/H/K switch Hosts/Keys · / filter · showing ${rowsForView.length}`, inner));
    if (this.params.notice) rows.push(fit(this.params.theme.fg("warning", this.params.notice), inner));
    const actions = this.view === "hosts"
      ? ["Esc close", "↑↓ select", "Enter use", "A add", "E edit", "D delete", "T test", "R reset", "I import", "L lock"]
      : ["Esc close", "↑↓ select", "A import", "E rename", "R replace", "D delete", "L lock"];
    rows.push(rule(inner), fitSegments(inner, actions));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filtering) { this.filtering = false; this.query = ""; this.selected = 0; this.params.requestRender(); }
      else this.finish("close", false);
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE_ROWS);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE_ROWS);
    if (this.filtering) {
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") { this.query = removeLastGrapheme(this.query); this.selected = 0; this.params.requestRender(); return; }
      if (data.startsWith("\x1b")) return;
      const printable = sanitizeSingleLine(data);
      if (!printable) return;
      this.query = `${this.query}${printable}`.slice(0, 256); this.selected = 0; this.params.requestRender(); return;
    }
    if (matchesKey(data, Key.tab) || data === "h" || data === "H" || data === "k" || data === "K") {
      this.view = this.view === "hosts" ? "keys" : "hosts"; this.selected = 0; this.params.requestRender(); return;
    }
    if (data === "/") { this.filtering = true; this.params.requestRender(); return; }
    if (this.view === "hosts") {
      if (matchesKey(data, Key.enter) || data === "\r") return this.finish("select", true);
      if (data === "a" || data === "A") return this.finish("add", false);
      if (data === "e" || data === "E") return this.finish("edit", true);
      if (data === "d" || data === "D") return this.finish("delete", true);
      if (data === "t" || data === "T") return this.finish("test", true);
      if (data === "r" || data === "R") return this.finish("reset", true);
      if (data === "i" || data === "I") return this.finish("import", false);
    } else {
      if (data === "a" || data === "A") return this.finish("add-key", false);
      if (data === "e" || data === "E") return this.finish("edit-key", true);
      if (data === "r" || data === "R") return this.finish("replace-key", true);
      if (data === "d" || data === "D") return this.finish("delete-key", true);
    }
    if (data === "l" || data === "L") return this.finish("lock", false);
  }

  private hostSummary(host: SshHost, selected: boolean): string {
    const label = selected ? this.params.theme.bold(host.label) : host.label;
    const jump = host.jumpHostId ? this.params.hosts.find((candidate) => candidate.id === host.jumpHostId)?.label ?? "missing jump" : "direct";
    const trust = host.hostKey === null ? "untrusted" : "trusted";
    const monitor = this.params.statuses?.get(host.id)?.status ?? (host.monitorEnabled ? "checking" : "disabled");
    const tags = (host.tags?.length ?? 0) > 0 ? ` · tags ${host.tags.join(",")}` : "";
    return `${label} · ${host.user}@${formatAddress(host.host, host.port)} · ${host.shell} · ${authKindLabel(host, this.params.keys)}${tags} · jump ${jump} · ${trust} · monitor ${monitor}`;
  }

  private keySummary(key: SshKey, selected: boolean): string {
    const label = selected ? this.params.theme.bold(key.label) : key.label;
    return `${label} · ${key.publicKeyFingerprint} · created ${key.createdAt} · ${Buffer.byteLength(key.privateKey, "utf8")} bytes`;
  }

  private filteredHosts(): SshHost[] {
    const terms = termsFrom(this.query);
    return this.params.hosts.filter((host) => {
      const jump = host.jumpHostId ? this.params.hosts.find((candidate) => candidate.id === host.jumpHostId)?.label ?? "" : "direct";
      const haystack = `${host.label} ${host.host} ${host.user} ${host.port} ${host.shell} ${host.auth.kind} ${(host.tags ?? []).join(" ")} ${jump}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private filteredKeys(): SshKey[] {
    const terms = termsFrom(this.query);
    return (this.params.keys ?? []).filter((key) => terms.every((term) => `${key.label} ${fingerprintAlgorithm(key.publicKeyFingerprint)} ${key.createdAt}`.toLocaleLowerCase().includes(term)));
  }

  private move(delta: number): void {
    const count = this.view === "hosts" ? this.filteredHosts().length : this.filteredKeys().length;
    this.selected = count === 0 ? 0 : (this.selected + delta % count + count) % count;
    this.params.requestRender();
  }

  private finish(kind: SshHostManagerActionKind, needsItem: boolean): void {
    const host = this.view === "hosts" ? this.filteredHosts()[this.selected] : undefined;
    const key = this.view === "keys" ? this.filteredKeys()[this.selected] : undefined;
    if (needsItem && !host && !key) return;
    this.params.done({ kind, ...(host ? { hostId: host.id } : {}), ...(key ? { keyId: key.id } : {}), query: this.query, view: this.view });
  }
}

function authKindLabel(host: SshHost, keys: readonly SshKey[] = []): string {
  if (host.auth.kind === "identity") return "identity";
  if (host.auth.kind === "password") return "password";
  if (host.auth.kind === "key") { const keyId = host.auth.keyId; return `key ${keys.find((key) => key.id === keyId)?.label ?? "missing"}`; }
  return "agent";
}
function fingerprintAlgorithm(fingerprint: string): string { return fingerprint.startsWith("SHA256:") ? "SHA256 public key" : "public key"; }
function formatAddress(host: string, port: number): string { return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`; }
function termsFrom(value: string): string[] { return value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean); }
function sanitizeSecretInput(value: string): string { return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/[\r\n\x00-\x1f\x7f]/gu, ""); }
function sanitizeSingleLine(value: string): string { return value.replace(/[\r\n\t\x00-\x1f\x7f]/gu, ""); }
function removeLastGrapheme(value: string): string { const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined; const parts = segmenter ? [...segmenter.segment(value)].map((entry) => entry.segment) : [...value]; parts.pop(); return parts.join(""); }
function visibleStart(selected: number, length: number, maximum: number): number { return length <= maximum ? 0 : Math.min(Math.max(0, selected - maximum + 1), length - maximum); }
function clampIndex(index: number, length: number): number { return length === 0 ? 0 : Math.min(Math.max(0, index), length - 1); }
function fitSegments(width: number, segments: readonly string[]): string { const kept: string[] = []; for (const segment of segments) { const candidate = [...kept, segment].join(" · "); if (visibleWidth(candidate) > width) break; kept.push(segment); } return fit(kept.length > 0 ? kept.join(" · ") : segments[0] ?? "", width); }
