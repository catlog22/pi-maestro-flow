export function resolvePackageDir(name: string, fromUrl?: string): string | undefined;

export function collectCompanionDirs(opts?: {
  names?: string[];
  fromUrl?: string;
}): string[];

export function registerCompanionPackages(opts?: {
  settingsFile?: string;
  packageDirs?: string[];
}): { changed: boolean; added: string[]; packages: string[] };
