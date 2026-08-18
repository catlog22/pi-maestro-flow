/**
 * Fold one remote run's event stream and terminal snapshot into an
 * `AttemptOutcome`.
 *
 * This is a pure function of its argument: no clock, no I/O, no ambient state.
 * The settle time and the "the channel dropped" fact are both passed in, so the
 * same inputs always produce the same outcome and every rule below is testable
 * without a remote host.
 *
 * `reclamation` is the reason this is worth a module of its own. The host's
 * failover path in `runs/execution.ts` stops swapping models and re-running only
 * when it reads `unreaped`; a fold that answered `reclaimed` unconditionally
 * would turn that safety gate into a tautology, and every stale remote runtime
 * would be free to deliver callbacks into the replacement attempt. Three of the
 * cases below therefore answer `unreaped`, with reasons that stay distinct — an
 * operator handling "the remote lost the run" does something different from one
 * handling "we dropped the connection" or "the channel held but the run never
 * settled".
 *
 * The event stream is not discarded here. A backend feeds every raw
 * `RemoteRunEvent` to `options.onChildEvent` as it arrives, so replay keeps the
 * full record and this fold only owns the settled summary.
 */

import type { AttemptOutcome, AttemptReclamation, AttemptRecoveryFacts, SettlementAuthority } from "pi-maestro-backend-core/v1/backend";
import type { AgentTerminalStatus, CapabilityDelivery, SingleResult, TeammateRunSpec, Usage } from "pi-maestro-backend-core/v1/spec";
import type { RemoteRunEvent, RemoteRunResultEvent, RemoteRunSnapshot, RemoteStatus } from "./types.ts";

/** Everything the fold needs about one settled remote run. */
export interface RemoteOutcomeInput {
  readonly spec: TeammateRunSpec;
  readonly correlationId: string;
  /** Model name from the registration's config; the remote protocol carries no model field, so an unconfigured registration passes the empty string. */
  readonly model: string;
  readonly events: readonly RemoteRunEvent[];
  /** The terminal snapshot `manager.wait` settled on; when `wait` threw, the last snapshot the caller could still read. */
  readonly snapshot: RemoteRunSnapshot;
  readonly startedAt: number;
  readonly settledAt: number;
  /** Model turns this run actually took: the first one plus every delivered follow-up. */
  readonly turns: number;
  /** The wait failed, so this channel stopped answering before any `run/result` reached it. Only the caller knows this; a stream that merely ends without a result looks identical from here. */
  readonly disconnectedBeforeResult: boolean;
  /** Capability deliveries the backend recorded itself, such as an emulated `followUp` for a normalized prompt. */
  readonly capabilityDeliveries?: readonly CapabilityDelivery[];
}

/**
 * The remote's own settlement statement, or undefined when none arrived.
 *
 * The last one wins rather than the first: a replayed attach can redeliver the
 * result, and the newest statement is the one the remote stands behind.
 *
 * @param events - the run's events in arrival order.
 * @returns the final `run/result`, or undefined when the run never settled explicitly.
 */
function lastResultEvent(events: readonly RemoteRunEvent[]): RemoteRunResultEvent | undefined {
  let result: RemoteRunResultEvent | undefined;
  for (const event of events) {
    if (event.type === "run/result") result = event;
  }
  return result;
}

/**
 * Map a remote status onto the canonical lifecycle outcome.
 *
 * `default` rather than `assertNever`: `RemoteStatus` has nine members and the
 * non-terminal ones legitimately reach here through a snapshot taken while the
 * run was still moving. A run that never reached a terminal status did not
 * succeed, so every such value reads as `failed`.
 *
 * @param status - the remote status the run settled on, or was last seen in.
 * @returns the terminal status to publish.
 */
function terminalStatusOf(status: RemoteStatus): AgentTerminalStatus {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    // Cancellation is never inferred from an exit code, and the remote monitor
    // already maps `cancelled` this way.
    case "cancelled": return "terminated";
    case "lost": return "failed";
    default: return "failed";
  }
}

/**
 * How authoritatively the turn's end was established.
 *
 * @param resultEvent - the run's final `run/result`, when one arrived.
 * @returns `authoritative` only when the remote itself stated a settlement it still stands behind.
 */
function settlementAuthorityOf(resultEvent: RemoteRunResultEvent | undefined): SettlementAuthority {
  if (resultEvent === undefined) return "unknown";
  // A `lost` result is the remote saying it no longer knows what happened,
  // which is the opposite of an authoritative statement about the turn.
  if (resultEvent.status === "lost") return "unknown";
  return "authoritative";
}

/** Tool calls the stream paired, split by whether their `end` arrived. */
interface ToolCounts {
  completed: number;
  inFlight: number;
}

/**
 * Count tool calls by pairing `start` with `end` on `toolCallId`.
 *
 * Counting event arrivals instead would double-count a redelivered `start` and
 * report a completed call twice, once for each phase. The host reads these
 * numbers to decide how much work a replay would repeat, so the unit has to be
 * the call, not the message.
 *
 * @param events - the run's events in arrival order.
 * @returns how many tool calls finished, and how many were still outstanding.
 */
function countTools(events: readonly RemoteRunEvent[]): ToolCounts {
  const ended = new Map<string, boolean>();
  for (const event of events) {
    if (event.type !== "run/event" || event.event.type !== "tool") continue;
    const tool = event.event.tool;
    ended.set(tool.toolCallId, (ended.get(tool.toolCallId) ?? false) || tool.phase === "end");
  }
  let completed = 0;
  for (const done of ended.values()) if (done) completed += 1;
  return { completed, inFlight: ended.size - completed };
}

/**
 * Sum the run's usage events.
 *
 * `totalTokens` is deliberately not folded anywhere: it is the provider's own
 * sum of input and output, so adding it to either field would count the same
 * tokens twice. Its absence is a judgement, not an omission.
 *
 * `cacheReadTokens` and `cacheWriteTokens` are zero because `RemoteUsage`
 * carries no cache accounting at all — the same honest zeroing the dsh backend
 * uses for the usage its transport never reports.
 *
 * @param events - the run's events in arrival order.
 * @param turns - model turns this run actually took.
 * @returns the attempt's usage totals.
 */
function foldUsage(events: readonly RemoteRunEvent[], turns: number): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const event of events) {
    if (event.type !== "run/event" || event.event.type !== "usage") continue;
    const usage = event.event.usage;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cost += usage.costUsd ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, cost, turns };
}

/**
 * The messages a reader of this result sees.
 *
 * The remote's own final text wins, then its error, then the streamed text
 * joined in arrival order. The streamed fallback matters: a run whose channel
 * dropped before `run/result` still produced words, and dropping them would
 * leave the failure with nothing to read.
 *
 * @param events - the run's events in arrival order.
 * @param resultEvent - the run's final `run/result`, when one arrived.
 * @returns the message list for the published result.
 */
function foldMessages(
  events: readonly RemoteRunEvent[],
  resultEvent: RemoteRunResultEvent | undefined,
): Array<{ role: string; content: string }> {
  if (resultEvent?.result !== undefined) return [{ role: "assistant", content: resultEvent.result }];
  if (resultEvent?.error !== undefined) return [{ role: "system", content: resultEvent.error }];
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "run/event" || event.event.type !== "text") continue;
    texts.push(event.event.text);
  }
  return texts.length === 0 ? [] : [{ role: "assistant", content: texts.join("\n") }];
}

/**
 * Whether the failed attempt's remote resources were confirmed released.
 *
 * The three `unreaped` reasons stay separate on purpose. "The remote lost the
 * run", "we lost the connection", and "the channel held but no result ever came"
 * are different faults with different handling — the first says a live runtime
 * may still be acting on the remote host, the second says we simply stopped
 * watching one, the third says the daemon answered our wait yet never spoke for
 * the run — and a single merged sentence would leave an operator unable to tell
 * which happened. The third is why `disconnectedBeforeResult` is a parameter
 * rather than something this fold could derive: an absent `run/result` alone
 * cannot distinguish a channel that dropped from one that stayed up.
 *
 * @param resultEvent - the run's final `run/result`, when one arrived.
 * @param disconnectedBeforeResult - the wait failed, so this channel stopped answering before any result reached it.
 * @returns the reclamation verdict for this attempt.
 */
function reclamationOf(
  resultEvent: RemoteRunResultEvent | undefined,
  disconnectedBeforeResult: boolean,
): AttemptReclamation {
  if (resultEvent !== undefined && resultEvent.status !== "lost" && !disconnectedBeforeResult) {
    return { status: "reclaimed" };
  }
  if (resultEvent?.status === "lost") {
    return { status: "unreaped", reason: "remote run lost before the daemon confirmed release" };
  }
  if (disconnectedBeforeResult) {
    return { status: "unreaped", reason: "the remote connection dropped before the daemon confirmed release" };
  }
  return { status: "unreaped", reason: "the remote stream ended without a result before the daemon confirmed release" };
}

/**
 * Fold a settled remote run into the outcome the host's failover reads.
 *
 * @param input - the run's spec, events, terminal snapshot, and the timings and connection facts only the caller knows.
 * @returns the settled attempt, with recovery facts and an already-decided reclamation verdict.
 */
export function foldRemoteOutcome(input: RemoteOutcomeInput): AttemptOutcome {
  const resultEvent = lastResultEvent(input.events);
  const terminalStatus = terminalStatusOf(resultEvent?.status ?? input.snapshot.status);
  const settlementAuthority = settlementAuthorityOf(resultEvent);
  const tools = countTools(input.events);
  const recovery: AttemptRecoveryFacts = {
    settlementAuthority,
    completedToolCount: tools.completed,
    inFlightToolCount: tools.inFlight,
    // Nothing the model or its tools did was ever observed, and the run did not
    // succeed: there is no work for a replay to repeat.
    preActivityInfrastructureExit: input.events.every((event) => event.type !== "run/event")
      && terminalStatus !== "completed",
    // Without an authoritative settlement the attempt's own tool accounting is
    // incomplete by definition, so effects may exist that it never saw.
    externalReplayRisk: settlementAuthority !== "authoritative",
  };
  const result: SingleResult = {
    agent: input.spec.agent,
    ...(input.spec.name === undefined ? {} : { name: input.spec.name }),
    task: input.spec.task,
    exitCode: terminalStatus === "completed" ? 0 : 1,
    messages: foldMessages(input.events, resultEvent),
    usage: foldUsage(input.events, input.turns),
    model: input.model,
    correlationId: input.correlationId,
    durationMs: input.settledAt - input.startedAt,
    toolCount: tools.completed,
    // A terminal remote run refuses input — the manager throws rather than
    // queueing it — so declaring this wakeable would send teammate-send to
    // knock on a door that is certain not to open.
    wakeable: false,
    terminalStatus,
    ...(resultEvent?.structuredOutput === undefined ? {} : { structuredOutput: resultEvent.structuredOutput }),
    ...(input.capabilityDeliveries === undefined || input.capabilityDeliveries.length === 0
      ? {}
      : { capabilityDeliveries: [...input.capabilityDeliveries] }),
  };
  return {
    result,
    recovery,
    // The verdict is decided here, not awaited: the contract field is a promise
    // because the host awaits it only on the failover path.
    reclamation: Promise.resolve(reclamationOf(resultEvent, input.disconnectedBeforeResult)),
  };
}
