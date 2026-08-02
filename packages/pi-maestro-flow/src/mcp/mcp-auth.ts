/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and PKCE state for MCP servers.
 *
 * Token storage location: $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json when set,
 * otherwise <Pi agent dir>/mcp-oauth/sha256-<server-hash>/tokens.json
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getAgentPath } from './agent-dir.ts';

/** OAuth token storage format */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in seconds
  scope?: string;
}

/** OAuth client information from dynamic or static registration */
export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  redirectUris?: string[];
}

/** Complete auth entry for a server */
export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string; // Track the URL these credentials are for
}

// Base directory for auth storage - can be overridden via env var for testing
function getAuthBaseDir(): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  return override ? override : getAgentPath('mcp-oauth');
}

/**
 * Get the server-specific directory path.
 */
function getServerDir(serverName: string): string {
  if (typeof serverName !== 'string') {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  const storageKey = createHash('sha256').update(serverName, 'utf8').digest('hex');
  return join(getAuthBaseDir(), `sha256-${storageKey}`);
}

/**
 * Get the tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: string): string {
  return join(getServerDir(serverName), 'tokens.json');
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function validateDirectory(dir: string, label: string): boolean {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing unsafe MCP OAuth ${label}: ${dir}`);
    }
    chmodSync(dir, 0o700);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function ensureAuthBaseDir(): string {
  const baseDir = getAuthBaseDir();
  if (!validateDirectory(baseDir, 'base directory')) {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    if (!validateDirectory(baseDir, 'base directory')) {
      throw new Error(`Failed to create MCP OAuth base directory: ${baseDir}`);
    }
  }
  return baseDir;
}

function validateRegularFile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing unsafe MCP OAuth token file: ${filePath}`);
    }
    chmodSync(filePath, 0o600);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Ensure the server directory exists with secure permissions.
 */
function ensureServerDir(serverName: string): string {
  const baseDir = ensureAuthBaseDir();
  const dir = getServerDir(serverName);
  if (dirname(dir) !== baseDir) {
    throw new Error(`Invalid MCP OAuth server directory: ${dir}`);
  }
  if (!validateDirectory(dir, 'server directory')) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    if (!validateDirectory(dir, 'server directory')) {
      throw new Error(`Failed to create MCP OAuth server directory: ${dir}`);
    }
  }
  return dir;
}

function getValidatedServerDir(serverName: string): string | undefined {
  const baseDir = getAuthBaseDir();
  if (!validateDirectory(baseDir, 'base directory')) return undefined;
  const dir = getServerDir(serverName);
  if (dirname(dir) !== baseDir) {
    throw new Error(`Invalid MCP OAuth server directory: ${dir}`);
  }
  return validateDirectory(dir, 'server directory') ? dir : undefined;
}

/**
 * Read the auth entry for a server from disk.
 * Returns undefined if file doesn't exist.
 */
function readAuthEntry(serverName: string): AuthEntry | undefined {
  try {
    if (!getValidatedServerDir(serverName)) return undefined;
    const filePath = getAuthEntryFilePath(serverName);
    if (!validateRegularFile(filePath)) return undefined;
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as AuthEntry;
  } catch (error) {
    console.error(`Failed to read auth entry for ${serverName}:`, error);
    return undefined;
  }
}

/**
 * Write the auth entry for a server to disk with secure permissions.
 */
function writeAuthEntry(serverName: string, entry: AuthEntry): void {
  const dir = ensureServerDir(serverName);
  const filePath = getAuthEntryFilePath(serverName);
  validateRegularFile(filePath);
  const tmpPath = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(entry, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    validateRegularFile(filePath);
    renameSync(tmpPath, filePath);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure; the temp path is still unlinked below.
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(serverName: string): AuthEntry | undefined {
  return readAuthEntry(serverName);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(serverName: string, serverUrl: string): AuthEntry | undefined {
  const entry = getAuthEntry(serverName);
  if (!entry) return undefined;

  // If no serverUrl is stored, this is from an old version - consider it invalid
  if (!entry.serverUrl) return undefined;

  // If URL has changed, credentials are invalid
  if (entry.serverUrl !== serverUrl) return undefined;

  return entry;
}

/**
 * Save auth entry for a server.
 */
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string): void {
  // Always update serverUrl if provided
  if (serverUrl) {
    entry.serverUrl = serverUrl;
  }
  writeAuthEntry(serverName, entry);
}

/**
 * Remove auth entry for a server.
 * Also removes the server directory if empty.
 */
export function removeAuthEntry(serverName: string): void {
  const dir = getValidatedServerDir(serverName);
  if (!dir) return;

  const filePath = getAuthEntryFilePath(serverName);
  if (validateRegularFile(filePath)) {
    unlinkSync(filePath);
  }

  try {
    rmdirSync(dir);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY') && !isNodeError(error, 'EEXIST')) {
      throw error;
    }
  }
}

/**
 * Update tokens for a server.
 */
export function updateTokens(
  serverName: string,
  tokens: StoredTokens,
  serverUrl?: string
): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.clientInfo;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.tokens = tokens;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Update client info for a server.
 */
export function updateClientInfo(
  serverName: string,
  clientInfo: StoredClientInfo,
  serverUrl?: string
): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.clientInfo = clientInfo;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Update code verifier for a server.
 */
export function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.oauthState;
  }
  entry.codeVerifier = codeVerifier;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Clear code verifier for a server.
 */
export function clearCodeVerifier(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.codeVerifier;
    saveAuthEntry(serverName, entry);
  }
}

/**
 * Update OAuth state for a server.
 */
export function updateOAuthState(serverName: string, state: string, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.codeVerifier;
  }
  entry.oauthState = state;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Get OAuth state for a server.
 */
export function getOAuthState(serverName: string): string | undefined {
  const entry = getAuthEntry(serverName);
  return entry?.oauthState;
}

/**
 * Clear OAuth state for a server.
 */
export function clearOAuthState(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.oauthState;
    saveAuthEntry(serverName, entry);
  }
}

/**
 * Check if stored tokens are expired.
 * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
 */
export function isTokenExpired(serverName: string): boolean | null {
  const entry = getAuthEntry(serverName);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000;
}

/**
 * Check if a server has stored tokens.
 */
export function hasStoredTokens(serverName: string): boolean {
  const entry = getAuthEntry(serverName);
  return !!entry?.tokens;
}

/**
 * Clear all credentials for a server.
 */
export function clearAllCredentials(serverName: string): void {
  removeAuthEntry(serverName);
}

/**
 * Clear only client info for a server.
 */
export function clearClientInfo(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.clientInfo;
    saveAuthEntry(serverName, entry);
  }
}

/**
 * Clear only tokens for a server.
 */
export function clearTokens(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.tokens;
    saveAuthEntry(serverName, entry);
  }
}
