/**
 * Parse markdown files with YAML frontmatter (--- delimited).
 *
 * Extracts structured fields from the frontmatter block and returns
 * the remaining body as the system prompt.
 */
export interface AgentFrontmatter {
    name?: string;
    description?: string;
    tools?: string;
    taskType?: string;
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
export declare function parseFrontmatter(content: string): {
    frontmatter: AgentFrontmatter;
    body: string;
};
