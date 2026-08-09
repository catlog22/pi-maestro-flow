---
title: "Monitor Cross-Session Supervision"
icon: "📊"
---

Monitor continuously supervises **other Pi sessions or windows in the same workspace**. On each tick it checks whether a target has failed, is waiting for input, has stalled, or has drifted from its objective. It can send a controlled `steer` intervention, record the outcome in a durable ledger, and restore valid bindings after reload.

Use Monitor for long-running parallel work, multi-window development, background migrations, and workflows that need closed-loop correction. For a one-time read-only status check, use `observe`; use `/monitor` when supervision should continue and may intervene.

> **Version availability:** v0.17.0, which contained the cross-session Scheduler, Window Bar handoff, and durable supervision enhancements, was withdrawn. The current npm stable release is 0.16.0. This page retains current-source behavior for review before a fixed release; do not install 0.17.0 to obtain these enhancements.

---

## 1. Quick Start

Open at least one other Pi window in the same workspace and give the session a recognizable name. In the supervising window:

```text
/monitor                       # open the control window without binding
/monitor backend auto          # supervise window "backend"
/monitor status                # bindings, recent output, ledger summary
/monitor metrics               # supervision effectiveness metrics
/monitor exit                  # stop and clear bindings
```

Type `/monitor ` and use completion to see bindable window names. A bare `/monitor` opens the control window; use the `#control` tab for supervision instructions or select a peer window to message it.

> Monitor binds workspace window endpoints. A stale binding is not reused after a target closes, changes workspace, or publishes a replacement endpoint.

## 2. Targets and Modes

### Auto Mode

```text
/monitor backend auto
/monitor backend frontend tests auto
```

`auto` is the default. Monitor combines deterministic checks with LLM drift analysis:

- failed targets and pending user interactions notify the supervising window;
- a running target idle beyond the threshold receives a recovery or blocker-report request;
- active work is checked against the objective, recent output, and verdict trend;
- intervention outcomes are recorded as recovered, repeated, escalated, or failed;
- repeated unresolved issues escalate for user review.

### Custom Mode

```text
/monitor backend custom:protect database migration backward compatibility
/monitor release custom:intervene if tests are skipped or publication order changes
```

Everything after `custom:` becomes the continuing supervision requirement. Base failure, interaction, and stall checks remain active; drift analysis focuses on the custom requirement.

Good custom prompts state a durable constraint:

- “Do not change the public API; ask the target to revert signature changes.”
- “Every implementation phase must run focused tests; no skips or suppressions.”
- “Publication order must remain settings-core, teammate, cockpit, flow.”

### Link a Goal

```text
/monitor backend --goal goal-123 auto
/monitor release --goal goal-123 custom:do not declare completion with blocked acceptance items
```

`--goal <id>` links a binding to a pi-peer Goal board. Goal closure standards become analysis context, and repeated stall or drift escalation can append a blocking objection to the Goal board.

## 3. Cockpit Workflow

With Pi Cockpit installed:

1. switch Cockpit to the Window view and select a target session;
2. press `Alt+W` to enable supervision;
3. press `Alt+W` again to remove the binding;
4. run `/monitor status` for the full binding and ledger view.

The Monitor control endpoint cannot supervise itself. `Alt+R` opens the teammate session list for handoff while preserving routing, monitor, and turns context.

Exit Monitor interaction mode with `/monitor exit`, or press bare `Esc` twice within 500 ms. The first Escape keeps native cancel/clear behavior; the second exits Monitor mode.

## 4. Command Reference

| Command | Purpose |
|---------|---------|
| `/monitor` | open the control window without binding every peer |
| `/monitor <targets...> [auto]` | bind one or more windows in auto mode |
| `/monitor <targets...> custom:<prompt>` | supervise against a continuing custom constraint |
| `/monitor <targets...> --goal <id>` | link bindings to a Goal board |
| `/monitor status` | session status, bindings, recent output, ledger summary |
| `/monitor metrics` | resolution, recovery, escalation, and drift rates |
| `/monitor doctor` | read-only health check for config, bindings, ledger, and warnings |
| `/monitor resume` | restore valid active bindings from the ledger |
| `/monitor exit` / `/monitor stop` | stop the Monitor session and clear bindings |
| `/monitor spawn <name> <objective>` | launch a managed headless Pi work window |
| `/monitor spawn status` | list managed windows |
| `/monitor spawn stop <name>` | stop a managed window |
| `/monitor ui` | legacy binding overlay, retained for compatibility |

## 5. Managed Work Windows

```text
/monitor spawn migration complete the database migration and run integration tests
/monitor spawn status
/monitor migration auto
```

Names must start with an alphanumeric character, contain only `A-Z`, `a-z`, `0-9`, `.`, `_`, or `-`, and be at most 64 characters. The objective is the full command text after the name.

Stop the window explicitly when done:

```text
/monitor spawn stop migration
```

Managed windows are attached to the extension lifecycle. Explicit cleanup avoids leaving an unnecessary Pi process running.

## 6. Detection and Intervention

Each tick uses a start-of-tick endpoint snapshot and revalidates the exact owner and endpoint after asynchronous analysis. A restarted or rotated window cannot accidentally receive an intervention intended for its predecessor.

Processing order:

1. **Failed:** notify the supervising window; do not repeatedly message a failed target.
2. **Interaction needed:** notify the supervising window so a user can answer.
3. **Stalled:** if running but idle beyond the current built-in 60-second heuristic, send `steer`; high context pressure changes the guidance to compact first.
4. **Drift:** for active non-stalled work, analyze the objective, output tail, and recent verdict trend.
5. **Closed-loop outcome:** after `pendingOutcomeEvalMs`, record recovery, repetition, failure, or escalation.
6. **Escalation:** after `escalationThreshold` unresolved interventions, notify the supervising window and append a Goal objection when linked.

Cooldown, deduplication, and per-window delivery limits apply per target. Failed delivery retries are bounded; exhaustion writes a dead-letter record and reports the unreachable target.

## 7. Project Configuration

Monitor reads the `monitor` section of `.pi/settings.json`:

```json
{
  "monitor": {
    "tickMs": 15000,
    "stallIdleSeconds": 60,
    "interventionCooldownMs": 60000,
    "maxRetries": 2,
    "retryBackoffMs": 1000,
    "maxInterventionLog": 20,
    "analysisTailLines": 20,
    "escalationThreshold": 2,
    "pendingOutcomeEvalMs": 30000,
    "contextCompactThresholdPercent": 80,
    "ledgerEnabled": true,
    "autoResume": true
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `tickMs` | `15000` | delay between supervision ticks in milliseconds |
| `stallIdleSeconds` | `60` | idle boundary for LLM drift analysis; the deterministic stall heuristic currently remains fixed at 60 seconds |
| `interventionCooldownMs` | `60000` | minimum time between interventions for one target |
| `maxRetries` | `2` | retries after the first delivery failure |
| `retryBackoffMs` | `1000` | linear retry backoff base in milliseconds |
| `maxInterventionLog` | `20` | accepted reserved setting; runtime retention is currently fixed at 20 records |
| `analysisTailLines` | `20` | accepted reserved setting; runtime analysis currently reads a fixed 20 lines |
| `escalationThreshold` | `2` | unresolved interventions before escalation |
| `pendingOutcomeEvalMs` | `30000` | minimum delay before evaluating an intervention outcome |
| `contextCompactThresholdPercent` | `80` | context pressure that changes stall guidance to compact |
| `ledgerEnabled` | `true` | append the durable Monitor ledger |
| `autoResume` | `true` | restore valid active bindings on session start |

> **Current v0.17.0 limitation:** `stallIdleSeconds` affects the LLM analysis branch, while the deterministic stall check still uses the built-in 60 seconds. `maxInterventionLog` and `analysisTailLines` are accepted by the config loader, but runtime behavior remains fixed at 20. `/monitor doctor` reports loaded config and does not imply that these three override values are fully applied to the heuristic.

Numeric values must be positive integers. Environment overrides:

| Environment variable | Config field |
|----------------------|--------------|
| `PI_MONITOR_TICK_MS` | `tickMs` |
| `PI_MONITOR_STALL_IDLE_SECONDS` | `stallIdleSeconds` |
| `PI_MONITOR_COOLDOWN_MS` | `interventionCooldownMs` |
| `PI_MONITOR_MAX_RETRIES` | `maxRetries` |
| `PI_MONITOR_RETRY_BACKOFF_MS` | `retryBackoffMs` |
| `PI_MONITOR_ESCALATION_THRESHOLD` | `escalationThreshold` |
| `PI_MONITOR_LEDGER` | `ledgerEnabled` |
| `PI_MONITOR_AUTO_RESUME` | `autoResume` |

Environment values take precedence over `.pi/settings.json`. Boolean values accept `1/true/on/yes/enabled` and `0/false/off/no/disabled`.

## 8. Ledger, Status, and Metrics

The durable record is:

```text
.pi/monitor-ledger.jsonl
```

| Kind | Content |
|------|---------|
| `binding` | binding creation, removal, disconnect, exit, shutdown |
| `analysis` | `on-track` / `drift` verdict changes |
| `intervention` | delivered correction and trace ID |
| `outcome` | recovered, repeated, escalated, failed |
| `delivery` | delivery failure and dead-letter |
| `review` | Advisor concern/blocker verdict |
| `checkpoint` | Monitor start, stop, and resume boundaries |

Use `/monitor status` routinely, `/monitor metrics` to assess outcomes, and `/monitor doctor` for diagnosis. The ledger may contain target names, custom requirements, and corrective messages; do not commit it or place credentials in prompts.

## 9. Monitor vs Advisor vs observe

| Capability | Target | Continuous | Active intervention | Best for |
|------------|--------|------------|---------------------|----------|
| Monitor | other workspace windows/sessions | yes, periodic ticks | yes, controlled `steer` | multi-window and background work |
| Advisor | current main session | turn/tool checkpoints | quality guidance only | reasoning and constraint review |
| `observe` | Agent, background command, or workspace | one-shot or bounded wait | no | status, completion wait, turns |
| Goal verifier | Goal completion result | at completion | no | acceptance and completion audit |

Monitor and Advisor can run together. Monitor watches whether other windows have stalled or drifted; Advisor reviews the current main session's reasoning quality. See [Advisor Turn-Level Supervision](/guides/advisor).

Agents should discover windows with `teammate-list({ view: "windows" })` and inspect them with `observe`. Legacy `teammate-watch`, `teammate-wait`, and standalone observation tools are hidden by default and should not be used for new workflows.

## 10. Troubleshooting

### Target Not Found

1. confirm the target is a Pi window in the same workspace;
2. type `/monitor ` and check completions;
3. inspect Cockpit Window Bar or `teammate-list({ view: "windows" })`;
4. after a target restart, wait for its new endpoint and bind again.

### Binding Did Not Resume

```text
/monitor doctor
/monitor resume
/monitor status
```

Check `ledgerEnabled` and `autoResume`. The target must still be discoverable; an old ledger owner is never forced onto a replacement endpoint.

### Intervention Was Not Delivered

Run `/monitor doctor` and inspect dead-letter counts and warnings, then confirm the target is alive. Delivery retries follow `maxRetries` and `retryBackoffMs` and never continue indefinitely.

### Too Many Notifications

Increase `interventionCooldownMs` or `escalationThreshold`, and use a more precise `custom:` requirement. In v0.17.0, the deterministic stall check is fixed at 60 seconds, so changing `stallIdleSeconds` does not move that trigger. Disabling the ledger does not disable interventions and should not be used to hide the signal.

## 11. Related Guides

- [Advisor Turn-Level Supervision](/guides/advisor) — low-frequency second-model review for the current session
- [Pi Cockpit Visualization](/guides/cockpit) — Window Bar, session tabs, and `Alt+W`
- [Parallel Multi-Agent Dispatch](/guides/teammate-dispatch) — dispatch, cross-session messages, and `observe`
- [Goals · Plans · Tasks](/guides/goal-plan-todo) — Goal links and completion verification
- [Compaction Capacity Management](/guides/compaction-config) — compaction behavior under high context pressure
