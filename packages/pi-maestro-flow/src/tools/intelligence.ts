import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "./browser-tool.ts";
import { createComputerUseTool } from "./computer-use-tool.ts";
import { browserManager, type BrowserManagerLike } from "./browser/manager.ts";
import { browserBridge } from "./browser/bridge-server.ts";
import { computerUseManager, type ComputerUseManagerLike } from "./computer-use/manager.ts";
import { createLspTool } from "./lsp-tool.ts";
import { registerLspAutoDiagnostics } from "./lsp/auto-diagnostics.ts";
import { lspManager } from "./lsp/manager.ts";
import type { LspManagerLike } from "./lsp/types.ts";
import { registerSearchToolBm25 } from "./search-tool-bm25.ts";
import { registerSmartSearch } from "./smart-search.ts";
import { createSourceCheckTool } from "./web-access/source-check-tool.ts";
import { registerCuratorCommands } from "./web-access/curator.ts";

export function registerIntelligenceTools(pi: ExtensionAPI): void {
  pi.registerTool(createLspTool());
  registerLspAutoDiagnostics(pi);
  pi.registerTool(createBrowserTool());
  pi.registerTool(createComputerUseTool());
  registerSearchToolBm25(pi);
  registerSmartSearch(pi);
  pi.registerTool(createSourceCheckTool() as never);
  registerCuratorCommands(pi);
}

export async function shutdownIntelligenceTools(
  dependencies: {
    lsp: Pick<LspManagerLike, "shutdown">;
    browser: Pick<BrowserManagerLike, "closeAll">;
    bridge: Pick<typeof browserBridge, "shutdown">;
    computerUse?: Pick<ComputerUseManagerLike, "shutdown">;
  } = {
    lsp: lspManager,
    browser: browserManager,
    bridge: browserBridge,
    computerUse: computerUseManager,
  },
  timeoutMs = 5_000,
): Promise<void> {
  // Named extension entries may need the authenticated bridge to close owned
  // Chrome tabs, so release browser entries before shutting down the
  // process-owned bridge. Other intelligence managers can clean up in parallel.
  const browserCleanup = Promise.resolve(dependencies.browser.closeAll())
    .finally(() => dependencies.bridge.shutdown());
  const cleanup = Promise.allSettled([
    dependencies.lsp.shutdown(),
    browserCleanup,
    ...(dependencies.computerUse ? [dependencies.computerUse.shutdown()] : []),
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
