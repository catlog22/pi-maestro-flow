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
export declare function discoverPromptTemplates(cwd: string): TeammatePromptTemplate[];
export declare function substitutePromptArgs(content: string, args: string[]): string;
export declare function resolvePromptTask(cwd: string, promptName: string | undefined, task: string | undefined, promptArgs: string[] | undefined): PromptResolution;
export declare function formatPromptCatalog(cwd: string, maxPrompts?: number): string;
