# pi-maestro-flow

Maestro workflow orchestration as [Pi](https://github.com/earendil-works/pi) extensions.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [pi-teammate](./pi-teammate/) | Teammate dispatch with P0 three-axis decoupling (name × reply_to × lifecycle) | `pi-maestro-teammate` |
| [pi-maestro-flow](./flow/) | Explore, delegate, MOA tools + 113 skills + 28 agent definitions | `pi-maestro-flow` |

## Install

```bash
# From npm (pi-maestro-flow includes pi-maestro-teammate as dependency)
pi install npm:pi-maestro-flow

# Or from local path
pi install ./flow
```

After installation:
- 3 tools available: `maestro`, `maestro-wait`, `maestro-status`
- 113 skills available as `/skill:name` slash commands
- 28 agent definitions for teammate dispatch

## License

MIT
