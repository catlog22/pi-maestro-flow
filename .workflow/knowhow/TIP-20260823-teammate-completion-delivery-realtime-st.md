---
title: "Teammate completion delivery: realtime state vs AgentSession-stop model consumption"
type: tip
created: 2026-08-23T07:24:38.515Z
---

# Teammate completion delivery: realtime state vs AgentSession-stop model consumption

## Applicable scope

Use this guidance when implementing or debugging `teammate-send`, background `teammate-complete` delivery, durable completion outboxes, or Cockpit completion displays.

## Canonical delivery semantics

- A tool call is part of the active agent turn. Returning from one tool call is not a message-delivery boundary because the model may consume the tool result, continue reasoning, call more tools, retry, or compact.
- `follow_up` is non-interrupting. It is consumed only when the target AgentSession would otherwise stop: the active model response, every tool call and continuation, native retry, compaction, and earlier queued input must finish first. If the AgentSession never reaches that stop point, the message may remain queued indefinitely.
- `steer` requests cancellation of the active turn. After cancellation is acknowledged, the message becomes the replacement or next prompt. It is not inserted into the middle of a running tool call. If cancellation is not acknowledged promptly, steer may degrade to queued follow_up.
- A queued or accepted receipt proves enqueueing, not target-model consumption.

## Completion must use two channels

1. Publish lifecycle state immediately. Agent completion should update `teammate:complete` observers, Cockpit, agent lists, dependency scheduling, and observation APIs as soon as the agent settles.
2. Deliver the result to the target model without interrupting unrelated active work. The automatic `teammate-complete` model notification normally follows the AgentSession-stop boundary above.

Do not use an interrupting steer merely to make completion status visible. Use steer only when correctness or safety requires the target to receive new information before its active turn completes.

## Failure modes and fixes

### Accepted follow-up retry accumulation

If the host accepts a follow-up while the target is busy, the message may be waiting in the host queue and therefore cannot produce a consumption receipt yet. Retrying on a fixed receipt timeout can enqueue the same `deliveryId` many times. When the target finally stops, the queued duplicates drain one per new turn.

Fix: after the host accepts a delivery, suppress same-host re-enqueueing for that `deliveryId` until it is consumed or the coordinator/process restarts. Preserve the durable queued record so a new process can recover and retry after a crash.

### Provider/outbox receipt revision mismatch

A provider intent revision and an outbox-record integrity revision are different hashes unless they share exactly the same canonical data. Sending the outbox hash to a provider that validates the intent hash strands the provider manifest in `finalized` and makes it recoverable forever.

Fix: persist the immutable provider `intentRevision` in the outbox and echo that exact revision through transcript receipts and `acknowledgeApplied`. Keep the outbox record hash as a separate internal integrity field. Upgrade legacy records when their recoverable intent is imported.

### Durable envelope renderer fallback

A legacy `teammate-complete` renderer may require `details.results` or `details.result`, while a durable envelope carries fields such as `source`, `deliveryId`, `contentRevision`, `resources`, and `replayed`. Returning `undefined` for the durable shape exposes the raw custom-message block.

Fix: render `source: "completion-outbox"` explicitly. Use a compact one-line collapsed view and retain the full result when expanded.

## Verification invariants

- Advancing past the receipt deadline in the same coordinator does not enqueue a second accepted delivery.
- Restarting the coordinator can recover and retry the persisted queued delivery once.
- A strict provider accepts the receipt revision and transitions its manifest out of `finalized`.
- Transcript rebuild applies a matching receipt without reinjection.
- The durable completion renderer handles the outbox envelope without raw fallback.
- Cockpit receives completion lifecycle state independently of when the target model consumes the result.

## Mode selection

| Need | Mode |
|---|---|
| Target must see a correction or safety constraint before active work continues | `steer` |
| Message must not interrupt current model/tool execution | `follow_up` |
| Show agent completion immediately | lifecycle event / Cockpit state |
| Let the model process a background result when it can safely start another turn | deduplicated `teammate-complete` follow-up |
| Start a recovery turn after the AgentSession is already settled | `triggerTurn` at the settled boundary |

Related background: `knowhow-tip-20260802-352357efafb917b0` documents failover-specific follow-up queue stalling and settled-boundary recovery injection.
