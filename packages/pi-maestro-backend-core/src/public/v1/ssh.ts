/**
 * Dependency-light SSH host-reference contracts shared by teammate hosts and
 * execution backends.
 *
 * A profile is deliberately not a general SSH credential object. It contains
 * only connection material the current teammate transports can consume without
 * copying a password or private-key passphrase across the host/backend seam.
 */

/** Authentication forms safe for the current teammate SSH consumers. */
export type SshHostProfileAuthentication =
  | { readonly kind: "agent" }
  | { readonly kind: "identity"; readonly identityFile: string };

/** A validated, non-secret SSH connection profile resolved at run time. */
export interface SshHostProfile {
  /** Stable id owned by the SSH host provider. */
  readonly id: string;
  /** Human-readable display name; never used for routing. */
  readonly label: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  /** Current teammate SSH consumers execute POSIX commands only. */
  readonly shell: "bash";
  /** Pinned SHA256 host-key fingerprint. */
  readonly hostKeySha256: string;
  readonly authentication: SshHostProfileAuthentication;
}

/** Safe, enumerable incompatibilities reported without credential values. */
export type SshHostReferenceIssue =
  | "unsupported-shell"
  | "unsupported-password-authentication"
  | "unsupported-identity-passphrase";

/** Bounded display metadata for a host reference picker. */
export interface SshHostReferenceSummary {
  readonly id: string;
  readonly label: string;
  readonly compatible: boolean;
  readonly issue?: SshHostReferenceIssue;
}
