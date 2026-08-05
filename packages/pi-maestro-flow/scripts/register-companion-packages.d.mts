export type CompanionPackageEntry = unknown;

export interface CompanionRegistrationReplacement {
  name: string;
  from: string;
  to: string;
}

export interface CompanionRegistrationSource {
  name: string;
  source: string;
}

export interface CompanionVersionMismatch {
  name: string;
  expected: string;
  actual?: string;
}

export interface CompanionRegistrationResult {
  changed: boolean;
  added: string[];
  replaced: CompanionRegistrationReplacement[];
  adopted: string[];
  preservedUnowned: CompanionRegistrationSource[];
  versionMismatch: CompanionVersionMismatch[];
  packages: CompanionPackageEntry[];
  settingsFile: string;
  stateFile: string;
}

export function getAgentDir(env?: { PI_CODING_AGENT_DIR?: string | undefined }): string;

export function getCompanionStatePath(agentDir?: string): string;

export function resolvePackageDir(name: string, fromUrl?: string): string | undefined;

export function collectCompanionDirs(opts?: {
  names?: string[];
  fromUrl?: string;
}): string[];

export function registerCompanionPackages(opts?: {
  agentDir?: string;
  settingsFile?: string;
  stateFile?: string;
  packageDirs?: string[];
  expectedVersions?: Record<string, string | undefined>;
  writeFile?: (filePath: string, content: string) => void;
}): CompanionRegistrationResult;
