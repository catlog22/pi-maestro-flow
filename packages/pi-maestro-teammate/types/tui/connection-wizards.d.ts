import type { ModelCliRow } from "../models/cli-list.ts";
import { type RemoteConfigState, type RemoteConfigStorePair } from "../remote/config.ts";
import { type RemoteHostConfig, type RemoteTargetConfig, type RemoteWorkspaceConfig } from "../remote/types.ts";
import type { RemotePaneScope } from "./remote-config-pane.ts";
import { type ConnectionFormUi } from "./connection-forms.ts";
/** Prompt adapter used by connection wizards and scripted tests. */
export interface WizardUi extends ConnectionFormUi {
    select(prompt: string, options: readonly string[]): Promise<string | undefined>;
    /** Optional status channel for redacted publisher diagnostics. */
    write?(text: string): void;
}
export type ConnectionWizardOutcome = {
    ok: boolean;
    message?: string;
    reloadCatalog?: boolean;
} | {
    cancelled: true;
};
export interface DeploymentWizardDeps {
    /** Full document bytes collected before opening the wizard. */
    manifestRaw?: string;
    /** Destination path and parser diagnostic identity. */
    filePath: string;
    /** Pre-confirms only the external-change last-writer-wins prompt. */
    yes?: boolean;
    /** Dynamic module-loading seam, reached only after a module is selected. */
    importModule?: (specifier: string) => Promise<unknown>;
}
export interface DeploymentEditWizardDeps extends DeploymentWizardDeps {
    /** Rows already produced by buildModelList; the wizard does not rebuild them. */
    rows: readonly ModelCliRow[];
}
/** Edit one deployment selected through its supplied model-list registration row. */
export declare function wizardDeploymentEdit(ui: WizardUi, deps: DeploymentEditWizardDeps): Promise<ConnectionWizardOutcome>;
/** Add a deployment and its first model registration to a v2 manifest. */
export declare function wizardDeploymentAdd(ui: WizardUi, deps: DeploymentWizardDeps): Promise<ConnectionWizardOutcome>;
export interface RemotePaneOutcome {
    ok: boolean;
    message: string;
    reloadRemote: boolean;
}
export type RemoteStorePersistence = (cwd: string, expected: RemoteConfigStorePair, next: RemoteConfigStorePair, globalFilePath?: string) => void | Promise<void>;
interface RemoteWizardDeps {
    state: RemoteConfigState;
    scope: RemotePaneScope;
    cwd?: string;
    globalFilePath?: string;
    persist?: RemoteStorePersistence;
}
export interface RemoteHostWizardDeps extends RemoteWizardDeps {
    id?: string;
    current?: RemoteHostConfig;
}
export interface RemoteTargetWizardDeps extends RemoteWizardDeps {
    id?: string;
    current?: RemoteTargetConfig;
}
export interface RemoteWorkspaceWizardDeps extends RemoteWizardDeps {
    workspaceRef?: string;
    current?: RemoteWorkspaceConfig;
}
/** Create or edit a remote host while preserving the remote-store CAS path. */
export declare function wizardRemoteHost(ui: WizardUi, deps: RemoteHostWizardDeps): Promise<RemotePaneOutcome>;
/** Create or edit a remote target while preserving the remote-store CAS path. */
export declare function wizardRemoteTarget(ui: WizardUi, deps: RemoteTargetWizardDeps): Promise<RemotePaneOutcome>;
/** Create or edit an explicitly trusted remote Pi workspace. */
export declare function wizardRemoteWorkspace(ui: WizardUi, deps: RemoteWorkspaceWizardDeps): Promise<RemotePaneOutcome>;
/** Explicitly write a legacy preview to a new sibling, never the source path. */
export declare function wizardLegacyUpgrade(ui: WizardUi, skeletonText: string, filePath: string): Promise<ConnectionWizardOutcome>;
export {};
