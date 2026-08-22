import { type ModelsCliTranslator } from "./cli-i18n.ts";
/**
 * The safe write path for the pi-teammate-models CLI.
 *
 * Publishing a registry document is four gates in order, and every gate can
 * stop the write before anything on disk changes shape:
 *
 * 1. the candidate is validated through the same `parseModelRegistryManifest`
 *    the runtime loads with, so a document the CLI would not itself accept is
 *    never written;
 * 2. the file is re-read and compared against the bytes the edit started
 *    from — an external change is shown as a redacted diff summary and must
 *    be confirmed explicitly (`--yes` pre-confirms; continuing is documented
 *    last-writer-wins);
 * 3. backups rotate (current → `.bak`, prior `.bak` → `.bak.1`) and any
 *    rotation failure aborts before publish;
 * 4. the candidate publishes atomically: sibling temp file named with the
 *    pid and a UUID, fsynced, renamed over the target, with a Windows
 *    remove-retry fallback mirroring the state-io pattern.
 */
export interface WriteConfirmIO {
    /** Write one output chunk (already newline-terminated where needed). */
    write(text: string): void;
    /**
     * Ask a yes/no question; resolves false on decline or end of input, so an
     * aborted stream can never confirm destructive continuation.
     */
    confirm(prompt: string): Promise<boolean>;
}
export interface PublishModelRegistryOptions {
    /** Absolute registry document path. */
    file: string;
    /** Full serialized candidate document. */
    candidateRaw: string;
    /** Bytes the edit flow started from; undefined when the file did not exist. */
    baselineRaw?: string;
    /** Pre-confirm external-change overwrite (--yes). */
    yes?: boolean;
    io: WriteConfirmIO;
    /** Defaults to the English models-CLI translator. */
    translate?: ModelsCliTranslator;
}
export type PublishResult = {
    kind: "written";
    backupPath: string | undefined;
} | {
    kind: "declined-external-change";
};
/**
 * Publish a validated model-registry document with rotation and atomic
 * replacement.
 *
 * @throws when the candidate fails manifest validation or backup rotation
 * fails; in both cases nothing has been published yet.
 */
export declare function publishModelRegistryDocument(options: PublishModelRegistryOptions): Promise<PublishResult>;
