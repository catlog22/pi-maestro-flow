import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../agents/frontmatter.ts";

export type PromptSource = "builtin" | "user" | "project";

export interface TeammatePromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  source: PromptSource;
  filePath: string;
}

export interface PromptResolution {
  task?: string;
  template?: TeammatePromptTemplate;
  error?: string;
}

const BUILTIN_PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
);

function firstDescriptionLine(body: string): string {
  const first = body.split("\n").find((line) => line.trim())?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function loadPromptsFromDir(dir: string, source: PromptSource): TeammatePromptTemplate[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const prompts: TeammatePromptTemplate[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = fs.statSync(filePath).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      prompts.push({
        name: path.basename(entry.name, ".md"),
        description: frontmatter.description || firstDescriptionLine(body),
        ...(frontmatter["argument-hint"] ? { argumentHint: frontmatter["argument-hint"] } : {}),
        content: body,
        source,
        filePath,
      });
    } catch {
      continue;
    }
  }
  return prompts;
}

export function discoverPromptTemplates(cwd: string): TeammatePromptTemplate[] {
  const builtin = loadPromptsFromDir(BUILTIN_PROMPTS_DIR, "builtin");
  const user = loadPromptsFromDir(path.join(os.homedir(), ".pi", "agent", "prompts"), "user");
  const project = loadPromptsFromDir(path.join(cwd, ".pi", "prompts"), "project");

  const byName = new Map<string, TeammatePromptTemplate>();
  for (const prompt of builtin) byName.set(prompt.name, prompt);
  for (const prompt of user) byName.set(prompt.name, prompt);
  for (const prompt of project) byName.set(prompt.name, prompt);
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function substitutePromptArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultNum, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultNum) {
        const value = args[Number(defaultNum) - 1];
        return value || defaultValue;
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return sliceLength
          ? args.slice(start, start + Number(sliceLength)).join(" ")
          : args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      return args[Number(simple) - 1] ?? "";
    },
  );
}

export function resolvePromptTask(
  cwd: string,
  promptName: string | undefined,
  task: string | undefined,
  promptArgs: string[] | undefined,
): PromptResolution {
  if (!promptName) return { task };

  const normalizedName = promptName.trim().replace(/^\//, "");
  const template = discoverPromptTemplates(cwd).find((candidate) => candidate.name === normalizedName);
  if (!template) {
    return { error: `Teammate prompt template "${normalizedName}" was not found.` };
  }

  const args = [task ?? "", ...(promptArgs ?? [])];
  return {
    task: substitutePromptArgs(template.content, args),
    template,
  };
}

export function formatPromptCatalog(cwd: string, maxPrompts = 24): string {
  const prompts = discoverPromptTemplates(cwd);
  if (prompts.length === 0) return "(no discovered teammate prompts)";

  const visible = prompts.slice(0, maxPrompts);
  const lines = visible.map((prompt) => {
    const hint = prompt.argumentHint ? ` ${prompt.argumentHint}` : "";
    return `- ${prompt.name}${hint} [${prompt.source}]: ${prompt.description}`;
  });
  if (prompts.length > visible.length) lines.push(`- … ${prompts.length - visible.length} more prompt(s)`);
  return lines.join("\n");
}
