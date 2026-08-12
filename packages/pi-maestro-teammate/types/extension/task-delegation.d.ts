export declare const DELEGATION_ROOT_RELATIVE_PATH = ".pi/delegations";
export declare const DELEGATION_RECORD_VERSION = 1;
export declare const MAX_DELEGATION_REQUEST_CHARS = 20000;
export declare const MAX_DELEGATION_DOCUMENT_BYTES: number;
export type DelegationWorkerContext = "fresh" | "fork";
export type DelegationStatus = "draft" | "confirmed" | "spawning" | "dispatching" | "delivery_unknown" | "sent" | "cancelled" | "closed";
export interface DelegationTaskDraft {
    title: string;
    objective: string;
    context: string;
    deliverables: string[];
    acceptanceCriteria: string[];
    constraints: string[];
    suggestedFiles: string[];
    verification: string[];
    executionNotes?: string;
}
export interface DelegationSourceContext {
    cwd: string;
    workspaceId: string;
    sessionId: string;
    sessionName?: string;
    sessionFile: string;
}
export interface DelegationPlannerReceipt {
    agent: "planner";
    correlationId: string;
    model?: string;
    durationMs?: number;
}
export interface DelegatedWindowLaunch {
    name: string;
    sessionName: string;
    presentation: "interactive";
    startedAt: number;
}
export interface DelegatedWindowReceipt {
    name: string;
    sessionName: string;
    ownerId: string;
    ownerNonce: string;
    pid: number;
    presentation: "interactive";
    registeredAt: number;
    sentAt?: number;
}
export interface DelegationRecord {
    version: typeof DELEGATION_RECORD_VERSION;
    revision: number;
    id: string;
    status: DelegationStatus;
    request: string;
    workerContext: DelegationWorkerContext;
    source: DelegationSourceContext;
    task: DelegationTaskDraft;
    planner: DelegationPlannerReceipt;
    createdAt: number;
    updatedAt: number;
    confirmedAt?: number;
    cancelledAt?: number;
    closedAt?: number;
    launch?: DelegatedWindowLaunch;
    window?: DelegatedWindowReceipt;
    dispatchMessageId?: string;
    lastError?: string;
}
export type DelegationCommand = {
    action: "create";
    request: string;
    workerContext?: DelegationWorkerContext;
} | {
    action: "list";
} | {
    action: "show";
    id: string;
} | {
    action: "send";
    id: string;
} | {
    action: "stop";
    id: string;
} | {
    action: "cancel";
    id: string;
} | {
    action: "help";
} | {
    action: "invalid";
    error: string;
};
export declare const DELEGATION_TASK_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly title: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 120;
        };
        readonly objective: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 4000;
        };
        readonly context: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 8000;
        };
        readonly deliverables: {
            readonly type: "array";
            readonly minItems: 1;
            readonly maxItems: 12;
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
                readonly maxLength: 500;
            };
        };
        readonly acceptanceCriteria: {
            readonly type: "array";
            readonly minItems: 1;
            readonly maxItems: 12;
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
                readonly maxLength: 500;
            };
        };
        readonly constraints: {
            readonly type: "array";
            readonly maxItems: 12;
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
                readonly maxLength: 500;
            };
        };
        readonly suggestedFiles: {
            readonly type: "array";
            readonly maxItems: 20;
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
                readonly maxLength: 500;
            };
        };
        readonly verification: {
            readonly type: "array";
            readonly minItems: 1;
            readonly maxItems: 12;
            readonly items: {
                readonly type: "string";
                readonly minLength: 1;
                readonly maxLength: 500;
            };
        };
        readonly executionNotes: {
            readonly type: "string";
            readonly maxLength: 4000;
        };
    };
    readonly required: readonly ["title", "objective", "context", "deliverables", "acceptanceCriteria", "constraints", "suggestedFiles", "verification"];
    readonly additionalProperties: false;
};
export declare function parseDelegationTaskDraft(value: unknown): DelegationTaskDraft;
export declare function parseDelegationCommand(input: string): DelegationCommand;
export declare function validDelegationId(id: string): boolean;
export declare function createDelegationId(title: string, token?: string): string;
export declare function buildDelegationPlannerPrompt(request: string, source: DelegationSourceContext, workerContext?: DelegationWorkerContext): string;
export declare function formatDelegationDocument(record: DelegationRecord): string;
export declare function buildDelegatedWorkerBootstrap(record: DelegationRecord, replyTo: string): string;
export declare function buildDelegationDelivery(record: DelegationRecord, document: string, replyTo: string): string;
export declare function delegationRoot(root: string): string;
export declare function delegationDirectory(root: string, id: string): string;
export declare function delegationDocumentPath(root: string, id: string): string;
export declare function createDelegationDraft(root: string, input: {
    request: string;
    workerContext?: DelegationWorkerContext;
    source: DelegationSourceContext;
    task: DelegationTaskDraft;
    planner: DelegationPlannerReceipt;
    now?: number;
}): Promise<DelegationRecord>;
export declare function loadDelegationRecord(root: string, id: string): Promise<DelegationRecord>;
export declare function listDelegationRecords(root: string): Promise<DelegationRecord[]>;
export declare function readDelegationDocument(root: string, id: string): Promise<string>;
export interface DelegationUpdateOptions {
    expectedRevision?: number;
    expectedStatuses?: readonly DelegationStatus[];
}
export declare function updateDelegationRecord(root: string, id: string, update: (record: DelegationRecord) => DelegationRecord, options?: DelegationUpdateOptions): Promise<DelegationRecord>;
export declare function cancelDelegationDraft(root: string, id: string, now?: number): Promise<DelegationRecord>;
