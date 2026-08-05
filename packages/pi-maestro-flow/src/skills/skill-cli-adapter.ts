import { defaultRunner, type RunCliRunner } from "../session/cli-adapter.ts";

export interface MaestroSkillEntry {
  type: "command" | "skill" | "step";
  scope: "global" | "project" | string;
  platform: string;
  name: string;
  path: string;
  hint: string;
  description: string;
  /** Prepare/workflow source for step entries; absent otherwise. */
  source?: "prepare" | "workflow" | string;
  /** Nested step names when the CLI emits them (legacy shape). */
  steps?: string[];
}

export interface SkillCliListOptions {
  platform?: "claude" | "codex" | "agent" | "agy" | "pi";
  steps?: boolean;
}

/**
 * Bridges the external `maestro skills` CLI surface (commands/Skills/steps)
 * into the plugin. The plugin's own SkillManagerStore remains authoritative for
 * runtime loading; this adapter exposes the CLI's discovery view for inspection.
 */
export class SkillCliAdapter {
  constructor(
    readonly workflowRoot: string,
    private readonly runner: RunCliRunner = defaultRunner,
  ) {}

  async list(options: SkillCliListOptions = {}): Promise<MaestroSkillEntry[]> {
    const args = [
      "skills",
      "--json",
      "--platform", options.platform ?? "pi",
      ...(options.steps ? ["--steps"] : []),
    ];
    const result = await this.runner(args, this.workflowRoot);
    if (result.exitCode !== 0) {
      throw new Error(
        `maestro ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    const entries: MaestroSkillEntry[] = [];
    for (const line of result.stdout.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        entries.push(JSON.parse(text) as MaestroSkillEntry);
      } catch {
        // Non-JSON diagnostic lines (e.g. WARNING headers) are skipped.
      }
    }
    return entries;
  }
}
