/**
 * Parse markdown files with YAML frontmatter (--- delimited).
 *
 * Extracts structured fields from the frontmatter block and returns
 * the remaining body as the system prompt.
 */

/**
 * Escape regex special characters for use in a RegExp constructor.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string;
  thinking?: string;
  systemPromptMode?: string;
  inheritProjectContext?: string;
  inheritSkills?: string;
  defaultContext?: string;
  model?: string;
  fallbackModels?: string;
  output?: string;
  defaultReads?: string;
  skill?: string;
  skills?: string;
  extensions?: string;
  [key: string]: string | undefined;
}

export function parseFrontmatter(content: string): {
  frontmatter: AgentFrontmatter;
  body: string;
} {
  const frontmatter: AgentFrontmatter = {};
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized };
  }

  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  const lines = frontmatterBlock.split("\n");
  let currentKey: string | null = null;
  let currentBlockLines: string[] | null = null;
  let currentIndent: number | null = null;

  for (const line of lines) {
    const indent = line.search(/\S|$/);
    const trimmed = line.trim();

    if (
      currentKey !== null &&
      currentBlockLines !== null &&
      indent > (currentIndent ?? 0)
    ) {
      currentBlockLines.push(line);
      continue;
    }

    // Flush any pending block value
    if (currentKey !== null && currentBlockLines !== null) {
      const rawBlock = currentBlockLines.join("\n");
      const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
      const prefix = leadingSpaces?.[1] ?? "";
      const stripped = prefix
        ? rawBlock
            .replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "")
            .replace(/^\n/, "")
        : rawBlock;
      frontmatter[currentKey] = stripped;
      currentKey = null;
      currentBlockLines = null;
      currentIndent = null;
    }

    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (value === "") {
        currentKey = match[1];
        currentBlockLines = [];
        currentIndent = indent;
      } else {
        frontmatter[match[1]] = value;
      }
    }
  }

  // Flush final block value
  if (currentKey !== null && currentBlockLines !== null) {
    const rawBlock = currentBlockLines.join("\n");
    const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
    const prefix = leadingSpaces?.[1] ?? "";
    const stripped = prefix
      ? rawBlock
          .replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "")
          .replace(/^\n/, "")
      : rawBlock;
    frontmatter[currentKey] = stripped;
  }

  return { frontmatter, body };
}
