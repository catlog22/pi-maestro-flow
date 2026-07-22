# Swarm Skill `read(file_path)` validation failure

## Answer

`/swarm` sends literal `/skill:swarm ...` text through `pi.sendUserMessage()`, but Pi 0.74.0 deliberately disables Skill/template expansion on that API. The model therefore attempts to load `SKILL.md` itself and emits the wrong argument dialect, `{ file_path }`, while Pi's registered `read` schema requires `{ path }`.

## Evidence trail

| Source | Finding |
|---|---|
| `.pi/skills/swarm/SKILL.md:4-6` | The Skill only allows `swarm_runtime`; it does not request `read`. |
| `packages/pi-maestro-flow/src/tools/swarm.ts:271,288` | Both handoff paths call `pi.sendUserMessage('/skill:swarm ...')`. |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1017-1023` | `sendUserMessage()` disables expansion. |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:843-856` | Normal Skill expansion reads and inlines the Skill without a tool call. |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js:15-19` | The provider-facing schema requires `path`. |

## Recommendation

Make `/swarm` expand or inline the bundled Skill before calling `pi.sendUserMessage()`, and test the expanded user-message contract. Do not treat `file_path` schema compatibility as the primary fix.
