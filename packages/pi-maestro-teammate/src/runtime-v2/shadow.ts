import * as path from "node:path";
import type { RuntimeEventDraftV2, RuntimeEventV2 } from "./contracts.ts";
import { RuntimeV2ShadowJournal } from "./journal.ts";
import {
  RUNTIME_V2_ROLLOUT_ENV,
  parseRuntimeV2RolloutMode,
  type RuntimeV2RolloutMode,
} from "./rollout.ts";

export interface RuntimeV2JournalAppender {
  append(event: RuntimeEventDraftV2): RuntimeEventV2;
}

export interface RuntimeV2ShadowSinkOptions {
  mode?: RuntimeV2RolloutMode;
  journal?: RuntimeV2JournalAppender;
  onError?: (error: unknown) => void;
}

export class RuntimeV2ShadowSink {
  readonly mode: RuntimeV2RolloutMode;
  readonly #journal: RuntimeV2JournalAppender | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;

  constructor(options: RuntimeV2ShadowSinkOptions = {}) {
    this.mode = options.mode ?? "disabled";
    this.#journal = options.journal;
    this.#onError = options.onError;
    if (this.mode === "shadow" && !this.#journal) throw new Error("Runtime V2 shadow mode requires a journal");
  }

  /**
   * The authoritative append runs first and its error is never intercepted.
   * Adapter and shadow-journal failures are advisory after that boundary.
   */
  appendAfterV1<Result>(
    appendV1: () => Result,
    adapt: () => readonly RuntimeEventDraftV2[],
  ): Result {
    const result = appendV1();
    if (this.mode !== "shadow") return result;
    try {
      for (const event of adapt()) this.#journal!.append(event);
    } catch (error) {
      try { this.#onError?.(error); } catch {}
    }
    return result;
  }
}

export function createRuntimeV2ShadowSink(options: {
  stateDirectory: string;
  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
}): RuntimeV2ShadowSink {
  const mode = parseRuntimeV2RolloutMode((options.env ?? process.env)[RUNTIME_V2_ROLLOUT_ENV]);
  if (mode === "disabled") return new RuntimeV2ShadowSink({ mode });
  return new RuntimeV2ShadowSink({
    mode,
    journal: new RuntimeV2ShadowJournal(path.join(options.stateDirectory, "runtime-v2-shadow")),
    onError: options.onError,
  });
}
