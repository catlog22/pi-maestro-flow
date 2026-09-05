export const SSH_GATEWAY_COMMAND = "pi-maestro-gateway connect --stdio";

export function sshGatewayGuide(): string {
  return [
    "Pi Maestro Gateway runs on the selected SSH server and must be installed and started there.",
    "",
    "1. Install the package that provides `pi-maestro-gateway` on the remote server.",
    "2. Start the daemon with `pi-maestro-gateway serve`.",
    "3. Verify the installation with `pi-maestro-gateway version --json`.",
    "4. Send `#ssh` (or `#ssh:<id>`) to select that server, then use the ssh tool's status, list, describe, call, or start_pi action.",
    "",
    "start_pi accepts existing local Pi todoIds plus an optional objective/agent/timeout and a required requestId. The host constructs a bounded read-only prompt snapshot; local Pi Todo and remote Gateway Todo remain independent and are never updated from remote lifecycle events.",
    "Use the returned non-secret launch receipt with the general call action for remote Monitor observe/message/cancel/result operations. Disconnecting SSH does not cancel the remote execution.",
    "",
    `Gateway actions always use the fixed remote command \`${SSH_GATEWAY_COMMAND}\`; host, authentication, command, remote cwd, raw snapshots, session ids, and callbacks are not accepted by start_pi.`,
  ].join("\n");
}
