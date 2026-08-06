# Understanding: Swarm Skill read schema failure

- Question: why does Swarm load `.pi/skills/swarm/SKILL.md` with `{ file_path, limit }` when Pi requires `{ path, offset?, limit? }`?
- Scope: Swarm Skill, `/swarm` command handoff, Pi 0.74.0 Skill expansion, and Pi `read` schema.
- Confirmed root cause: `pi.sendUserMessage()` bypasses Skill/template expansion, while the local handler sends it a literal `/skill:swarm` command.
- Durable boundary: extension-originated Skill activation must inline/expand the Skill before calling `sendUserMessage`.
