---
title: "Monitor Cross-Session Coordination"
icon: "📊"
---

Monitor is a root agent-operated control mode for coordinating **other Pi sessions and workers**. Entering `/monitor` turns the current root session into the control window: the agent discovers targets, observes their current state, sends instructions, and manages workers in response to the policy you provide in `#control`.

Monitor mode does not run a background evaluator. It has no target-bound supervision modes, automatic analysis cycle, or persisted evaluator state. Use `observe` directly for a one-time check; use `/monitor` when a root agent should coordinate several local or remote workers and may need to intervene.

Existing `.pi` artifacts left by the removed Monitor runtime are inert. Monitor does not read them, and it does not delete them automatically.

---

## 1. Quick Start

Open the control window and describe the coordination task in natural language:

```text
/monitor

Create interactive backend, frontend, and tests worker windows.
Assign the API, UI, and integration-test work, coordinate them until all finish,
collect their results, and close windows that are no longer needed.
```

The root Monitor agent uses the available coordination tools. It delegates project implementation to workers rather than editing the project from the control window.

For existing Pi windows in the same workspace, give the agent a direct instruction:

```text
Find the backend and tests windows in this workspace, inspect their progress,
and ask tests to begin integration verification after backend reports completion.
```

The agent discovers windows with `teammate-list({ view: "windows" })`, observes them, and sends `follow_up` or `steer` messages as needed. A queued or accepted send receipt proves enqueueing only; the agent waits for target-side or state evidence before repeating a request.

## 2. Root Control Mode

A bare `/monitor` enters the root control mode and exposes the cross-window coordination surfaces. Messages in `#control` are monitoring policy, priorities, or intervention instructions.

The control agent can:

- inspect one or several local workspace windows with bounded `observe` calls;
- send non-urgent work with `follow_up` and time-sensitive corrections with `steer`;
- create and close local workers owned by this Monitor session;
- create and cancel configured SSH-backed remote runs;
- arrange ordered work in an existing managed window with Flow Schedule;
- create a bounded prompt `loop` when recurring supervision is explicitly required.

The control agent should not implement project work itself. Exit Monitor mode before using the root session for unrelated implementation.

## 3. Command Reference

| Command | Purpose |
|---------|---------|
| `/monitor` | enter the root Monitor control mode |
| `/monitor status` | show whether the mode is active plus Monitor-owned local and remote workers |
| `/monitor doctor` | read-only health summary for mode/tool exposure and visible local, managed, and remote resources |
| `/monitor exit` / `/monitor stop` | leave Monitor mode |
| `/monitor spawn <name> <objective>` | compatibility/debug command that starts a managed headless Pi worker and returns its exact owner target |
| `/monitor spawn status` | list managed windows |
| `/monitor spawn stop <name>` | stop a named managed window |

`/monitor exit` ends the control mode, but it does not cancel generic `loop` jobs. List and cancel monitoring loops first when recurring supervision is no longer needed.

## 4. Local Workspace Windows

The agent uses two different local-window paths.

### Existing Windows

`teammate-list({ view: "windows" })` discovers Pi root sessions in the same workspace. Each window is addressed by its exact `owner:<ownerId>` identity. The agent observes that owner as a workspace target and sends messages to the same exact owner.

Owner identity is the safety boundary. If a window closes or is replaced, the agent must rediscover it; a same-named window is not assumed to be the previous owner. Existing windows can be observed and messaged, but Monitor cannot close windows it did not create.

### Monitor-Owned Windows

For natural-language requests to create a worker, the agent uses `workspace-window`:

1. `create` opens an interactive terminal by default and delivers the objective once;
2. the call waits for exact workspace-owner registration before returning `owner:<ownerId>`;
3. the returned owner is used directly with `observe` and `teammate-send`;
4. the optional completion handle identifies an immutable `agent://` result that remains readable after the worker exits;
5. `close` is restricted to windows created by the current Monitor session and verifies process reclamation.

Do not resend the initial objective after `create`; send only new constraints, corrections, or explicit response requests. Keep the completion handle until the result has been collected or the work has been cancelled.

Monitor can never close a manually opened peer or a worker owned by another Monitor session. If ownership or process reclamation cannot be proven, the close operation reports an error instead of acting on a stale process identity.

Worker names must start with an alphanumeric character, may contain only `A-Z`, `a-z`, `0-9`, `.`, `_`, or `-`, and are limited to 64 characters. One Monitor session can own at most eight managed windows.

Interactive workers use Windows Terminal (`wt.exe`) on Windows, Terminal through `osascript` on macOS, and `PI_TEAMMATE_TERMINAL` or `x-terminal-emulator` on Linux. Creation fails and attempts cleanup if the terminal is unavailable or exact owner registration does not complete within 15 seconds. Root-session shutdown or reload also attempts to reclaim windows still owned by that session.

### Headless Compatibility Command

`/monitor spawn` remains available for compatibility and debugging:

```text
/monitor spawn migration Complete the database migration and run focused tests
/monitor spawn status
/monitor spawn stop migration
```

The command waits for exact owner registration and reports the `owner:<ownerId>` target. Natural-language coordination through `workspace-window` remains the primary workflow.

## 5. Recurring Supervision with Loop

A one-shot status request or bounded wait does not need a loop. When the user explicitly needs supervision to continue without further messages, the Monitor agent can create one bounded prompt `loop` for the complete target set.

Before creating it, the agent lists current loops and reuses or cancels an existing monitoring loop to avoid duplicates. Each recurrence should:

1. rediscover the named workspace windows;
2. observe all targets in one call;
3. compare the new evidence with the prior observation;
4. intervene only when new evidence shows failure, a blocker, loss of progress, or departure from the stated task;
5. send at most one intervention per target;
6. cancel the loop when all targets settle or continuous supervision is no longer requested.

Use a prompt loop, not a shell loop, for Monitor supervision. `/monitor exit` does not own or stop these generic loop jobs.

## 6. Remote Workers

In Monitor mode, `remote-worker` manages configured SSH-backed runs without exposing SSH credentials or trusted commands.

- `targets` lists configured target IDs;
- `create` returns only after the SSH handshake, capability negotiation, remote start, and local ownership admission succeed;
- `list` shows remote runs owned by the current Monitor session;
- `close` performs owner-checked lifecycle cancellation.

Remote runs use stable `remote:<runId>` targets. Observe them as `kind: "remote"` and send later corrections with `teammate-send`. Do not treat a remote run as a workspace owner or pass it to `workspace-window`. Cross-target abort is unavailable; use `remote-worker close` for cancellation after collecting required results.

## 7. Flow Schedule

Flow Schedule is the Monitor-only surface for durable, ordered steps in an **already managed local workspace window**. Use it when work has a stable sequence that must advance from an exact correlated worker report.

Flow Schedule does not replace the other surfaces:

- `workspace-window` owns the worker process;
- `observe` reports current state;
- `teammate-send` handles ad hoc instructions;
- `loop` handles recurring checks;
- Flow Schedule controls ordered dispatch and exact result correlation.

Creating a schedule does not send work; the agent creates it, starts it, and uses schedule status to distinguish transport acceptance from exact completion evidence. Optional Todo completion and conflict gates apply only when the worker advertises the required capability. Without that capability, those gates are not negotiated and the exact correlated report remains the completion authority. Queued report reminders travel over a validated workspace-peer v1 transport identity and are fenced by the Monitor authority generation.

## 8. Monitor vs Advisor vs Observe

| Capability | Target | Trigger | Active action | Best for |
|------------|--------|---------|---------------|----------|
| Monitor | other workspace windows and Monitor-owned local or remote workers | root agent actions, optionally a bounded prompt loop | observe, message, create, coordinate, and reclaim owned workers | multi-window execution and cross-session coordination |
| Advisor | current main session | turn/tool checkpoints | quality guidance to the current agent | reasoning and constraint review |
| `observe` | an agent, command, workspace window, or remote run | one-shot or bounded wait/watch | none | status and completion checks |
| Goal verifier | Goal completion result | completion | independent verification | acceptance audit |

Advisor and Monitor can run together. Advisor reviews the current agent's reasoning quality; Monitor gives the root agent a control surface for coordinating other workers. Monitor does not independently judge worker quality in the background.

## 9. Troubleshooting

### A Local Worker Was Not Created

1. confirm `/monitor` is active; `workspace-window` is unavailable outside Monitor mode;
2. verify the platform terminal is available: Windows Terminal on Windows, Terminal on macOS, or `PI_TEAMMATE_TERMINAL`/`x-terminal-emulator` on Linux;
3. confirm the worker name is valid and the managed-window limit has not been reached;
4. if registration times out, confirm the new Pi window opened the same workspace and loaded the current extension;
5. ask the agent to list Monitor-owned windows and inspect their lifecycle state.

### An Existing Window Is Missing

1. confirm it is a Pi root window in the same workspace;
2. ask the agent to run `teammate-list({ view: "windows" })` again;
3. after a restart, use the newly published exact owner identity;
4. use `observe` for liveness; inbox history alone does not prove that a window is still live.

### A Message Has No Visible Effect

An accepted receipt is not proof that the target model consumed the message. Observe the target and allow the next turn boundary to inject queued messages. Send another message only when new evidence requires a correction or constraint.

### Old Monitor Files Still Exist

Artifacts from the deleted evaluator runtime may remain under `.pi`. They are not loaded by root Monitor mode and have no effect. Remove them manually only when normal repository housekeeping calls for it; Monitor intentionally does not delete them.

## 10. Related Guides

- [Advisor Turn-Level Supervision](/guides/advisor) — quality review for the current session
- [Pi Cockpit Visualization](/guides/cockpit) — workspace and session views
- [Parallel Multi-Agent Dispatch](/guides/teammate-dispatch) — dispatch, cross-session messages, and `observe`
- [Goals · Plans · Tasks](/guides/goal-plan-todo) — completion and acceptance workflows
