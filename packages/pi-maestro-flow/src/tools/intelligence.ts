import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "./browser-tool.ts";
import { browserManager, type BrowserManagerLike } from "./browser/manager.ts";
import { createLspTool } from "./lsp-tool.ts";
import { lspManager } from "./lsp/manager.ts";
import type { LspManagerLike } from "./lsp/types.ts";
import { registerSearchToolBm25 } from "./search-tool-bm25.ts";

export function registerIntelligenceTools(pi: ExtensionAPI): void {
  pi.registerTool(createLspTool());
  pi.registerTool(createBrowserTool());
  registerSearchToolBm25(pi);
}

export async function shutdownIntelligenceTools(
  dependencies: { lsp: Pick<LspManagerLike, "shutdown">; browser: Pick<BrowserManagerLike, "closeAll"> } = {
    lsp: lspManager,
    browser: browserManager,
  },
  timeoutMs = 5_000,
): Promise<void> {
  const cleanup = Promise.allSettled([
    dependencies.lsp.shutdown(),
    dependencies.browser.closeAll(),
  ]).then(() => undefined);
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
