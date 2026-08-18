# Teammate Backend Adapter Contract

How to write an execution backend that teammate dispatch can run, and how a deployment registers it.

A backend is any module that implements `TeammateBackend` from `pi-maestro-backend-core/v1/backend` and exports an instance as its default export. The host loads it by module specifier, validates its configuration, evaluates its capability table once, and then dispatches tasks to it. Nothing in the host names your backend: the two shipped backends, `pi-subprocess` and `dsh`, reach dispatch through the same interface you do.

Types only live in `pi-maestro-backend-core`; the loading and adjudication code lives in `pi-maestro-backends`.

## The interface

`TeammateBackend` has seven members. Five are read once, at registration; `start` is called per task.

### `name`

The backend's own identity, used in every diagnostic that has to say which backend refused, degraded, or emulated something. It is not the registration name: a deployment may register the same module twice under different names, and both registrations report the same `name`.

The dispatch writes it onto the settled `SingleResult` as its `backend` field, so a consumer can always tell which backend served a run.

### `protocolVersion`

Must be `1`. The registry rejects anything else before touching the configuration, and the rejection names both sides:

```
teammate backend "<registration>" implements protocol version <yours>, but this host speaks version 1
```

Naming both versions is the point — an operator reading only one of them cannot tell whether to upgrade the host or the adapter.

### `capabilities`

A function from this registration's resolved configuration to a `BackendCapabilities` table. It is a function rather than a constant because capability is a property of a deployment: the same module registered twice, once with a host bridge configured and once without, supports different things.

The registry calls it exactly once per registration, after `resolveConfig` has applied defaults, and carries the result on `ResolvedBackend`. It must be a pure function of its argument — no `process.env`, no I/O. The result is memoized for the registration's lifetime, so anything read here that later changes leaves the host adjudicating against a table that is no longer true.

A registration's lifetime is its registry instance's, and that is shorter than it sounds. `TeammateBackendRegistry`'s own documentation states why: the teammate host builds one registry per dispatch, because the Pi backend it registers closes over that dispatch's run wiring. In the deployment that ships, "once per registration" therefore means **once per task**. Budget `capabilities` and `resolveConfig` accordingly — a probe, a file read, or a network check placed in either is paid on every task, not once at startup.

The table records what your backend **does**, not what its underlying runtime could theoretically be made to do. Declaring a capability you have not implemented routes tasks to you that you will then fail.

### `recoveryShape`

`replay` or `in-context-continuation`. This describes your backend, not the recovery the host performs: the host's only recovery is a fresh attempt under the next model candidate, which is a replay whichever value you declare. Declaring `in-context-continuation` does not clear the side-effect fence and may not be read as clearing it.

### `configFields`

The settings your backend accepts, as `BackendConfigField` entries. Omit it if you take none — a registration that then sets any key is refused by name. Declaring fields is what makes a registration checkable at load and editable in the settings shell; an undeclared key is a load-time error, not a value you silently ignore.

### `resolveConfig`

Validate a registration's configuration and apply defaults. Called once at registration, never per run — with the same caveat `capabilities` carries: the shipping host builds one registry per dispatch, so once at registration is once per task. A backend that declares `configFields` must implement it: the registry treats declared fields plus a missing implementation as a registration error rather than skipping validation.

Generic validation runs first, in `resolveBackendConfig`: unknown keys, wrong types, enum values outside `options`, missing values for a field marked `required`. Only a configuration that survives all of that reaches your `resolveConfig`, so you never defend against shapes the declaration already rejects. What is left for you is cross-field and semantic validation — an ssh mode that needs a host, a numeric bound, a field that must hold a name rather than a value.

Return `ResolvedBackendConfig`: the `values` the run will see, and `errors`. A non-empty `errors` list stops the registration, and the message names the backend and the setting.

Resolution is a distinct step rather than a `?? default` inside `start`, so an `auto` mode resolves to a concrete choice the host can log and reproduce.

### `start`

Called per task with the `TeammateRunSpec` and `BackendRunOptions`. It resolves once the run is **live**, not once it finishes, because teammate-send addresses running tasks by name and needs the control channel while the outcome is still pending.

`TeammateRunSpec` carries only orchestrator-visible fields: `agent`, `task`, `name`, `backend`, `context`, `model`, `thinking`, `cwd`, `outputSchema`, `todos`. Most of what is absent is absent because the host enforces it — `fallbackModels` is sequenced by the host across attempts, `maxNestingDepth` is checked before a child starts, and `cwd` arrives already resolved.

**`timeoutMs` is the exception, and it is the one you are most likely to want.** It is absent from `TeammateRunSpec` and enforced by nobody on the registry path: `RunSingleTeammateParams` carries a `timeoutMs`, `backendSpecOf` does not forward it, and the word does not appear in `execution.ts` at all. Two host call sites pass one today — the advisor and the delegation planner — and under `mode: "backend-registry"` both are dropped, for every backend rather than only for CLI ones. So a task-level timeout does not reach you, and no host watchdog is standing behind you.

An adapter that needs a time bound declares one as a `configFields` entry and applies it itself. That makes the bound **per registration, not per task**: two tasks routed to the same registration get the same bound, and a caller cannot ask for a shorter one. `acp-cli`'s `runTimeoutMs` is that shape, and it is a deliberate accepted limit rather than an oversight — closing it means adding a field to `TeammateRunSpec`, which is a change to the published `v1` interface. Register the same module twice with different `config` when two workloads need different bounds.

`BackendRunOptions` carries what the spec does not: `correlationId`, `baseCwd`, `signal`, the observer callbacks `onProgress`, `onChildEvent`, and `onTurnComplete`, the borrowed host abilities in `host`, the assembled `systemPrompt` when the host built one, and this registration's resolved `config`.

Call `onTurnComplete` when the turn settles, before returning the outcome. The host buffers completions across a model-candidate sweep and publishes only the surviving one, so it must learn of settlement while it can still discard it — the returned outcome is too late for that.

Provider credentials are deliberately not modelled in `BackendRunOptions`. A backend driving an external runtime lets that runtime resolve its own credentials from its own configuration.

## What `start` returns

`BackendRun` has three members.

### `outcome`

A promise of `AttemptOutcome`, which is `result`, `recovery`, and `reclamation`. It rejects only on backend-internal faults; an ordinary task failure settles as a `SingleResult` with a non-zero `exitCode`.

### `send`

`send(message, mode)` delivers a live control message, where `ControlMode` is `prompt`, `follow_up`, or `steer`. Return `false` when you cannot — that is how you decline a message the host would otherwise report as delivered. A backend that publishes no channel of its own is handed one by `createBackendControlStdin`, which translates written control lines into this call, so implementing `send` is all a backend needs to be addressable.

### `abort`

Cancel the running task. The host calls it when the dispatch signal aborts; merely stopping the await would leave your runtime alive.

## Recovery facts

The `recovery` member of `AttemptOutcome` is an `AttemptRecoveryFacts` with five members, and it is how the host decides whether recovering this task is safe:

| Field | Meaning |
|---|---|
| `settlementAuthority` | `authoritative`, `inferred`, or `unknown` — how firmly you established that the turn ended |
| `completedToolCount` | Tool calls that reached a terminal state, successful **or** failed, whose effects a replay would repeat |
| `inFlightToolCount` | Tool calls still outstanding at failure, whose effects are unknown |
| `preActivityInfrastructureExit` | The attempt died before any model or tool activity, so there is nothing to replay |
| `externalReplayRisk` | Effects were observed outside this attempt's own tool accounting |

Every field describes observed side-effect risk, not backend preference: the host decides whether recovery is safe, and you report only what you saw.

These facts must travel on the returned value. A process-internal side channel is not an acceptable substitute, because a backend that forgets to populate one silently loses failover for every task it serves — no error, no warning, nothing in the transcript. The same rule is why they are members of `AttemptOutcome` rather than an out-of-band channel in the first place.

`completedToolCount` in particular is load-bearing. `buildReplayFence` blocks a fresh replay when any tool completed or any effect is unknown, so reporting a constant zero tells the host that a run which edited files and then failed had touched nothing.

Count a failed tool call too. The field's own name says completion and the declaration in `pi-maestro-backend-core` still reads "ran to completion", but the number the fence needs is terminal calls: an edit that reported failure may have written the file before it failed, and a replay would write it again. Excluding failures under-reports replay risk, which is the one direction this fence must never err in.

`preActivityInfrastructureExit` is the mirror of that rule and the easier one to get wrong. It means no model or tool activity was ever observed — not that no protocol traffic arrived. A handshake that succeeded and a runtime that then died on a bad flag is still a pre-activity exit, and reporting it as activity costs the task its only failover.

`reclamation` is a promise of `AttemptReclamation`: `{ status: "reclaimed" }` or `{ status: "unreaped", reason }`. The host awaits it only on the failover path, and that await serialises attempts — the replacement must not start while your failed runtime may still be alive. Report `unreaped` when you could not confirm the runtime is gone.

## Configuration fields

`BackendConfigField` has a `key`, a `kind`, a `labelKey` for the host-owned label, an optional `descriptionKey`, an optional `default`, and an optional `required` flag. Eight kinds exist:

| `kind` | Accepts |
|---|---|
| `text` | a string |
| `integer` | a whole number |
| `number` | any number |
| `boolean` | a boolean |
| `enum` | one of the `options` values, which the field must declare |
| `string-list` | an array of strings |
| `path` | a string naming a filesystem path |
| `credential-ref` | a string naming **where a secret lives**, never the secret |

A missing value with no `default` and `required: true` is a load-time error.

### `credential-ref`

A field selecting a credential holds the lookup name rather than the value, and declares `credentialLocation`:

- `env-file-key` — a key in the runtime's own env file, which the runtime loads for itself. This is the only location a host can serve without taking custody of a provider credential.
- `env-var` — a variable in the runtime process's environment. A host that does not construct that environment cannot serve it and must reject the registration rather than write the secret somewhere else.

Because the field holds a reference, a registration document can be committed to a repository and a settings editor can display the value in full. Masking a stored secret only hides it on screen; storing a reference means there is nothing to hide.

The `dsh` backend's `apiKeyEnv` field is the worked instance: `kind: "credential-ref"`, `credentialLocation: "env-file-key"`, `default: "DEEPSEEK_API_KEY"`. Nothing in the host ever reads its value, and `resolveConfig` refuses a value that is not shaped like a variable name — the likeliest reason it would not be is that someone pasted the key itself.

## Capability adjudication

`BackendCapabilities` has nine members, each a `CapabilitySupport` of `native`, `emulated`, or `unsupported`:

`outputSchema`, `forkContext`, `modelSelection`, `thinkingLevel`, `todoBinding`, `toolFilter`, `steer`, `followUp`, `abort`.

Membership is decided by one question: can a backend ignore this and leave the orchestrator none the wiser? A field the host resolves and enforces before dispatch fails that test and is absent from the table.

`requiredCapabilities` derives what one task needs, from the spec alone:

- `outputSchema` set → requires `outputSchema`
- `context` is `"fork"` → requires `forkContext`
- `model` set → requires `modelSelection`
- `thinking` set → requires `thinkingLevel`
- a non-empty `todos` → requires `todoBinding`

`toolFilter`, `steer`, and `followUp` are never required at validation: no orchestrator-visible field expresses the first, and the other two are not knowable until a message is actually sent, at which point your `send` refuses it.

`validateBackendCapabilities` then adjudicates each task against its resolved backend and partitions the result into a `CapabilityVerdict`:

- **`native`** — no entry; the task runs.
- **`emulated`** — a warning, and the run records a `CapabilityDelivery` so a consumer can tell a host-compensated value from a native one.
- **`unsupported`** — an error that rejects the task before `start` is called, unless the capability is degradable.
- **degradable** — `DegradableCapability` has exactly one member, `forkContext`. A task that asked to inherit parent history still runs correctly from a fresh context, so its absence produces a warning and a recorded degradation instead of a rejection.

Adjudication runs during graph validation and again on the single-dispatch path, both before `start`. That is deliberate: a task declaring `outputSchema` whose downstream sibling reads its value would otherwise burn a full model turn to discover the capability was missing.

The load-bearing rule for an adapter author: **the table records what this backend actually does, not what it could do**. Declaring `emulated` for something you have not built routes the task to you and then fails it — later, and with a worse diagnostic, than an honest `unsupported`.

## Registering a backend

The registration document is `.pi/teammate-backends.json` in the workspace root, shaped as `BackendRegistryConfig`:

```json
{
  "mode": "backend-registry",
  "default": "pi-subprocess",
  "backends": {
    "gemini": {
      "module": "pi-maestro-teammate/v1/acp-cli",
      "config": {
        "command": "gemini",
        "args": ["--acp"],
        "modelId": "cli/gemini"
      }
    }
  }
}
```

- `mode` is `legacy` or `backend-registry`, and **absent means `legacy`**. Writing registrations does not by itself change how anything runs; opting in is one explicit edit, and reverting is the same edit.
- `default` names the backend a task that names none will use. A `default` that is not registered is rejected when the document is read.
- `backends` maps a registration name to a `BackendRegistration`, which is a `module` specifier plus an optional `config`.
- The `pi-subprocess` registration is merged in automatically, so a document that only adds a backend does not lose Pi.

### `cli/<tool>` routes and `teammate-cli-tools.json`

A `cli/<tool>` model reaches a registration named after the tool, and two files decide two different things about it. Each is sufficient for its own half and neither is sufficient for both:

| Question | Decided by |
|---|---|
| Can `cli/<tool>` **run**? | the registration in `.pi/teammate-backends.json`, alone |
| Does `cli/<tool>` **appear** in the model catalog? | the entry in `teammate-cli-tools.json`, alone |

The launch path reads no file: `cliToolArgv` and `probeCliToolCommand` take the configuration as an argument, and it comes from the registration. The catalog path reads only `teammate-cli-tools.json`, through `toCliToolModelEntries`.

Two consequences worth stating outright, because both look like bugs from the other side:

- A registered tool with no entry in `teammate-cli-tools.json` runs when a task names it and is never offered in the picker.
- A tool with an entry but no registration is offered and then refused by name. So is one whose entry says `enabled: false` but which *is* registered — it runs. The registration is the enablement decision, and `enabled` in the tools file governs catalog visibility only.

Whether the catalog should be derived from the registration document instead is an open design question, not the behaviour described here.

A task selects a registration through the `backend` field of its `TeammateRunSpec`. A name that is not registered fails the dispatch by name rather than falling back, so a typo cannot silently route elsewhere:

```
teammate backend "<name>" is not registered (registered: <known names>)
```

### The default export

The loader resolves your `module` through a real dynamic import, and `asBackend` takes the loaded module's `.default` when it has one, falling back to the loaded value itself when it does not. That fallback is deliberate: the built-in loaders hand the registry a backend object rather than a module namespace.

So a default export is not strictly required — what is required is that whichever of the two the registry lands on carries `name`, `capabilities`, and `start`. A module exporting those three as named bindings is accepted. A module whose named exports are anything else, which is the usual case, is rejected with:

```
teammate backend "<name>" loaded from "<module>" but exports no backend (expected an object with name, capabilities, and start)
```

Export a named factory for tests and a default instance for the registry. Relying on the namespace fallback is legal and not worth it: the moment you add one unrelated named export the layout still works, but nothing about the module says which shape the registry is reading.

## Worked example: `acp-cli`

packages/pi-maestro-teammate/src/backends/acp-cli.ts is a complete, generic adapter, and it is registered the same way a third-party one is — the host loader has no branch for it.

It drives any CLI that speaks the Agent Client Protocol. Its shape:

```ts
export function createAcpCliBackend(run: CliToolRunner = runCliTool): TeammateBackend {
  return {
    name: "acp-cli",
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    recoveryShape: "replay",
    configFields: CONFIG_FIELDS,
    resolveConfig(config) { /* cross-field validation */ },
    async start(spec, options) { /* launch, settle, report */ },
  };
}

export default createAcpCliBackend();
```

Its configuration fields are `command`, `args`, `cwd`, `env`, `mode`, `host`, `user`, `port`, `hostKeySha256`, `identityFile`, `modelId`, `runTimeoutMs`, and `startupTimeoutMs`. None of them is a `credential-ref`: an ACP CLI resolves its own provider credentials from its own configuration, so there is no secret for the host to hold. `env` holds variable **names** the parent process may forward, and `resolveConfig` refuses an entry containing `=`, because a name-and-value entry writes a secret into a committed document.

Its capability table declares `modelSelection: "native"` and `abort: "native"`, and everything else `unsupported`. The `native` model selection is honoured rather than assumed: one registration serves one route, and `start` refuses a spec naming any other model instead of running the wrong CLI under the requested model's name.

`runTimeoutMs` is the worked instance of the timeout rule stated under `start`: per registration rather than per task, because `TeammateRunSpec` carries no timeout field and nothing else on this path enforces one. Two `cli/<tool>` workloads needing different bounds are two registrations.

`startupTimeoutMs` bounds a different thing — how long the ACP handshake may take before the launch is called failed — and it defaults to the driver's 15s. That default assumes `command` names an already-installed binary. A command that fetches before it answers does not: `npx -y @agentclientprotocol/claude-agent-acp` on a cold cache spends most of a first run downloading, blows the default, and reports `ACP initialize timed out after 15000ms`, which says nothing about the cause. Raise it for any launch command that resolves or downloads, and note that a warm cache hides the problem — the first run on a new machine is the one that fails.

Its recovery facts come from what the run observed. `settleAcpRun` counts ACP `tool_call` and `tool_call_update` events, and `recoveryFactsOf` folds that into `completedToolCount` and `inFlightToolCount` — the latter paired by tool call id, so an update whose call was never announced cannot cancel out a call that is genuinely outstanding.

`preActivityInfrastructureExit` is read off observed activity, never off the exit code, and `settleAcpRun` counts only progress events as activity. The lifecycle transition the driver emits when the ACP handshake lands does not count, which is the whole point of the field here: a CLI that answers `initialize`, answers `session/new`, and then dies on a bad flag or a missing config has done nothing a replay would repeat, and this backend's failure text never matches the host's fallback-provider predicate, so this flag is the only thing that can hand such a task to the next model candidate.

## Second example: `dsh`

packages/pi-maestro-backends/src/dsh/backend.ts drives a DeepSeek Harness runtime over stdio JSON-RPC. It is not an ACP adapter, which is the point: the seam is about capability and configuration, not about a wire format.

Its table differs from `acp-cli` for reasons that are each traceable to its transport:

- `outputSchema: "emulated"` — the SDK has no schema parameter, so the schema is appended to the prompt and the value is extracted and validated host-side. `acp-cli` declares `unsupported` because it builds no such compensation.
- `todoBinding` is computed from configuration: `native` when the registration sets `todoBridge`, `unsupported` otherwise. The same module registered twice therefore reports two different tables, which is exactly why `capabilities` is a function.
- `followUp: "native"` — a `dsh` session id stays addressable, so a later message is another run on the same session. An `acp-cli` process exits with its turn and has nothing to address.
- `abort: "emulated"` — there is no per-run cancel, so stopping one run means closing the runtime. `acp-cli` cancels its ACP session directly and declares `native`.

Its `recoveryShape` is `in-context-continuation`, and the fence still gates it exactly as it gates a `replay` backend.
