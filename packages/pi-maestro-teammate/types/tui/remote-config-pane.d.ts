import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ModelCliRow } from "../models/cli-list.ts";
import type { RemoteConfigState } from "../remote/config.ts";
import { type SupportedSettingsLocale, type TuiTranslator } from "./locale.ts";
export type RemotePaneScope = "global" | "project";
export type RemotePaneRow = {
    kind: "deployment";
    registrationId: string;
    modelId: string;
    deploymentId: string;
    harness: string;
    transportKind: string;
    resolvable: boolean;
    healthyStatic: boolean;
} | {
    kind: "host";
    id: string;
    host: string;
    user: string;
    port: number;
    keyPrefix: string;
    sshHostRef?: string;
    scope: RemotePaneScope;
    hidden?: boolean;
} | {
    kind: "target";
    id: string;
    host: string;
    driver: string;
    cwd: string;
    scope: RemotePaneScope;
    hidden?: boolean;
} | {
    kind: "workspace";
    workspaceRef: string;
    host: string;
    cwd: string;
    minimumWindowProtocol: number;
    scope: RemotePaneScope;
    hidden?: boolean;
};
export type RemotePaneAction = {
    kind: "connection-edit-deployment";
    registrationId: string;
} | {
    kind: "connection-add-deployment";
} | {
    kind: "connection-upgrade-legacy";
} | {
    kind: "remote-edit-host";
    hostId: string;
    scope: RemotePaneScope;
} | {
    kind: "remote-new-host";
    scope: RemotePaneScope;
} | {
    kind: "remote-edit-target";
    targetId: string;
    scope: RemotePaneScope;
} | {
    kind: "remote-new-target";
    scope: RemotePaneScope;
} | {
    kind: "remote-edit-workspace";
    workspaceRef: string;
    scope: RemotePaneScope;
} | {
    kind: "remote-new-workspace";
    scope: RemotePaneScope;
} | {
    kind: "remote-delete-host";
    hostId: string;
    scope: RemotePaneScope;
} | {
    kind: "remote-delete-target";
    targetId: string;
    scope: RemotePaneScope;
} | {
    kind: "remote-delete-workspace";
    workspaceRef: string;
    scope: RemotePaneScope;
} | {
    kind: "remote-scope";
    scope: RemotePaneScope;
} | {
    kind: "reload";
    tab: "connections";
};
export type RemotePaneDeployments = {
    kind: "registry";
    rows: readonly ModelCliRow[];
    defaultModel: string;
    diagnostics: readonly string[];
} | {
    kind: "legacy";
};
export interface RemoteConfigPaneOptions {
    state: RemoteConfigState;
    deployments?: RemotePaneDeployments;
    theme: {
        fg(role: string, text: string): string;
        bold(text: string): string;
    };
    t: TuiTranslator;
    requestRender: () => void;
    close: (action: RemotePaneAction | null) => void;
    onTest: (targetId: string, signal: AbortSignal) => Promise<string>;
    locale?: SupportedSettingsLocale;
    /** Injectable test hook; the product default is a 10s SSH probe timeout. */
    testTimeoutMs?: number;
}
/**
 * Pure-UI connections tab embedded in the Teammate Control Center.
 *
 * The pane renders precomputed registry deployments plus one remote scope at
 * a time (global or project), emits edit/create/delete/scope actions through
 * `close`, and runs inline target connectivity probes through `onTest`.
 * Manifest access, field-level wizards, persistence, and real SSH testing live
 * outside the pane.
 */
export declare class RemoteConfigPane implements Component, Focusable {
    private readonly options;
    focused: boolean;
    private scope;
    private query;
    private selected;
    private testingId;
    /** Aborts the in-flight probe when the pane is disposed or a new test starts. */
    private testAbort;
    private disposed;
    private statusText;
    private statusTone;
    private lastWidth;
    private readonly t;
    private readonly testTimeoutMs;
    private readonly localeDisposer;
    constructor(options: RemoteConfigPaneOptions);
    invalidate(): void;
    dispose(): void;
    handleInput(data: string): void;
    render(width: number): string[];
    /** Action-first single-column layout for narrow terminals (<40 columns). */
    private renderCompactRows;
    private get theme();
    private frame;
    private headerLine;
    private scopeLine;
    private filterLine;
    private statusLine;
    private footerLine;
    private sectionLine;
    private rowLine;
    private rowLabel;
    private buildRows;
    private rowSearchText;
    private visibleItems;
    private move;
    private setScope;
    private activateRow;
    private deleteRow;
    private startTest;
    private runTest;
    private timeoutLabel;
}
