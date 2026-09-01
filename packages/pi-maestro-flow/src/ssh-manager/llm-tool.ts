import { Type, type Static } from "typebox";
import {
  MAX_SSH_COMMAND_BYTES,
  MAX_SSH_TIMEOUT_SECONDS,
  SshExecutor,
  type SshExecuteOptions,
  type SshExecutionResult,
} from "./executor.ts";
import { SSH_HOST_ID_PATTERN, type SshHost } from "./model.ts";

export const SshToolParams = Type.Object({
  command: Type.String({
    minLength: 1,
    maxLength: MAX_SSH_COMMAND_BYTES,
    description: "Command to execute on the currently selected SSH server",
  }),
  cwd: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Optional working directory on the selected server",
  })),
  timeout: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_SSH_TIMEOUT_SECONDS,
    description: "Timeout in seconds (default 30, maximum 300)",
  })),
}, {
  additionalProperties: false,
  description: "Execute on the SSH server selected outside the model tool. Host and authentication parameters are never accepted.",
});

export type SshToolInput = Static<typeof SshToolParams>;

export interface SshHostProvider {
  getHosts(): SshHost[];
}

export interface BoundSshToolContext {
  readonly hostId: string;
  readonly systemContext: string;
  execute(input: SshToolInput, options?: SshExecuteOptions): Promise<SshExecutionResult>;
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
    async execute(input: SshToolInput, options?: SshExecuteOptions) {
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
