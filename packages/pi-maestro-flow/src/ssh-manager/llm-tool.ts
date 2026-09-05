import { Type, type Static } from "typebox";
import {
  MAX_SSH_COMMAND_BYTES,
  MAX_SSH_TIMEOUT_SECONDS,
  SshExecutor,
  type SshExecuteOptions,
  type SshExecutionResult,
} from "./executor.ts";
import { SSH_HOST_ID_PATTERN, type SshHost } from "./model.ts";
import type { SshStartPiInput } from "./gateway-session-launch.ts";

const sshCommandProperties = {
  command: Type.String({
    minLength: 1,
    maxLength: MAX_SSH_COMMAND_BYTES,
    description: "Command to execute on the resolved SSH target",
  }),
  cwd: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Optional working directory on the resolved target",
  })),
  timeout: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_SSH_TIMEOUT_SECONDS,
    description: "Timeout in seconds (default 30, maximum 300)",
  })),
};

const sshTargetId = () => Type.Optional(Type.String({
  pattern: SSH_HOST_ID_PATTERN.source,
  minLength: 1,
  maxLength: 64,
  description: "Provider-owned target id returned by action=targets; omitted uses the current #ssh selection",
}));

export const SshCommandToolParams = Type.Object(sshCommandProperties, { additionalProperties: false });
const SshTargetedCommandToolParams = Type.Object({
  targetId: sshTargetId(),
  ...sshCommandProperties,
}, { additionalProperties: false });

const gatewayToolName = Type.String({ minLength: 1, maxLength: 128 });
const sshAction = <T extends "guide" | "targets" | "status" | "list" | "describe" | "call" | "start_pi" | "sync_pi_config">(action: T) => Type.Literal(action);

export const SshToolParams = Type.Union([
  SshTargetedCommandToolParams,
  Type.Object({ action: sshAction("guide") }, { additionalProperties: false }),
  Type.Object({ action: sshAction("targets") }, { additionalProperties: false }),
  Type.Object({ action: sshAction("status"), targetId: sshTargetId() }, { additionalProperties: false }),
  Type.Object({ action: sshAction("list"), targetId: sshTargetId() }, { additionalProperties: false }),
  Type.Object({
    action: sshAction("sync_pi_config"),
    targetId: sshTargetId(),
    categories: Type.Array(Type.Union([
      Type.Literal("models"),
      Type.Literal("auth"),
      Type.Literal("teammate"),
    ]), { minItems: 1, maxItems: 3, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    action: sshAction("start_pi"),
    targetId: sshTargetId(),
    todoIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true })),
    objective: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
    agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    timeout: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: MAX_SSH_TIMEOUT_SECONDS,
      description: "Gateway orchestration timeout in seconds (default 30, maximum 300)",
    })),
    requestId: Type.String({ minLength: 1, maxLength: 256 }),
  }, { additionalProperties: false }),
  Type.Object({
    action: sshAction("describe"),
    targetId: sshTargetId(),
    tool: gatewayToolName,
  }, { additionalProperties: false }),
  Type.Object({
    action: sshAction("call"),
    targetId: sshTargetId(),
    tool: gatewayToolName,
    args: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown(), { maxProperties: 256 })),
    timeout: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: MAX_SSH_TIMEOUT_SECONDS,
      description: "Gateway call timeout in seconds (default 30, maximum 300)",
    })),
  }, { additionalProperties: false }),
], {
  type: "object",
  description: "List unlocked SSH targets, execute a legacy command, or use the built-in Gateway. targetId selects a provider-owned configured server; omission preserves the current #ssh selection. Host, authentication, and Gateway command parameters are never accepted.",
});

export type SshCommandToolInput = Static<typeof SshCommandToolParams>;
export type SshToolInput = Static<typeof SshToolParams>;
export type { SshStartPiInput };

export interface SshHostProvider {
  getHosts(): SshHost[];
}

export interface BoundSshToolContext {
  readonly hostId: string;
  readonly systemContext: string;
  execute(input: SshCommandToolInput, options?: SshExecuteOptions): Promise<SshExecutionResult>;
}

export function createBoundSshToolContext(
  hosts: SshHostProvider,
  executor: SshExecutor,
  selectedHostId: string,
): BoundSshToolContext {
  if (!SSH_HOST_ID_PATTERN.test(selectedHostId)) throw new Error("Selected SSH host id is invalid");
  const selected = findSelectedHost(hosts, selectedHostId);
  return Object.freeze({
    hostId: selectedHostId,
    systemContext: `SSH commands run only on the user-selected server ${JSON.stringify(selected.label)}. The tool accepts command, cwd, and timeout only; never request or provide host or authentication data.`,
    async execute(input: SshCommandToolInput, options?: SshExecuteOptions) {
      const current = findSelectedHost(hosts, selectedHostId);
      return executor.execute(current, input, options);
    },
  });
}

function findSelectedHost(hosts: SshHostProvider, selectedHostId: string): SshHost {
  const host = hosts.getHosts().find((candidate) => candidate.id === selectedHostId);
  if (!host) throw new Error("Selected SSH host is unavailable");
  return host;
}
