/** HTTP exposure checks and the native Gateway OAuth surface. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { GatewayAuthConfig, GatewayConfig } from "./config.ts";
import type { GatewayPrincipal } from "./contracts.ts";
import type { GatewayPairingStore } from "./pairing-store.ts";
import { createGatewayPrincipal } from "./principal.ts";

const OAUTH_BODY_LIMIT = 64 * 1024;

export function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash) && Buffer.byteLength(left, "utf8") === Buffer.byteLength(right, "utf8");
}

export function isLoopbackHost(value: string): boolean {
  const host = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.startsWith("::ffff:")) return isLoopbackHost(host.slice(7));
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  return false;
}

export function validateGatewayHttpSecurity(config: GatewayConfig, host = config.transport.http.host): void {
  const loopback = isLoopbackHost(host);
  const tunneled = Boolean(config.auth.oauth?.serverUrl) || config.server.disableLocalhostProtection;
  if (config.auth.mode === "open" && (!loopback || tunneled)) {
    throw new Error("Gateway auth.mode=open is allowed only on loopback without a public tunnel");
  }
  const nativeTls = config.transport.http.tls?.enabled === true;
  const trustedHttpsProxy = loopback
    && config.server.trustProxyHeaders
    && config.auth.oauth?.serverUrl?.startsWith("https://") === true;
  if (!loopback && !nativeTls && !trustedHttpsProxy) {
    throw new Error("Non-loopback Gateway HTTP requires native TLS; alternatively bind loopback behind an explicitly configured HTTPS reverse proxy");
  }
}

interface OAuthCode {
  clientId: string;
  redirectUri: string;
  expiresAt: number;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

interface OAuthToken {
  expiresAt: number;
  subject: string;
}

interface RegisteredClient {
  redirectUris: string[];
}

export interface GatewayHttpAuthResult {
  principal?: GatewayPrincipal;
  status?: number;
  message?: string;
  wwwAuthenticate?: string;
}

export class GatewayHttpAuth {
  private readonly auth: GatewayAuthConfig;
  private readonly pairingStore?: GatewayPairingStore;
  private readonly codes = new Map<string, OAuthCode>();
  private readonly tokens = new Map<string, OAuthToken>();
  private readonly clients = new Map<string, RegisteredClient>();

  constructor(auth: GatewayAuthConfig, pairingStore?: GatewayPairingStore) {
    this.auth = auth;
    this.pairingStore = pairingStore;
  }

  async authenticate(request: IncomingMessage, resourceMetadataUrl: string): Promise<GatewayHttpAuthResult> {
    const remote = request.socket.remoteAddress ?? "unknown";
    if (this.auth.mode === "open") {
      return { principal: createGatewayPrincipal("http", `open:${remote}`, { authenticated: false, source: remote, scopes: ["gateway"] }) };
    }
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header) : undefined;
    const token = match?.[1] ?? "";
    let accepted = false;
    if ((this.auth.mode === "bearer" || this.auth.mode === "dual") && this.auth.token) {
      accepted = constantTimeEqual(token, this.auth.token);
    }
    if (!accepted && (this.auth.mode === "oauth" || this.auth.mode === "dual")) {
      const issued = this.tokens.get(token);
      if (issued && issued.expiresAt > Date.now()) accepted = true;
      else if (issued) this.tokens.delete(token);
    }
    let pairing: Awaited<ReturnType<GatewayPairingStore["authenticate"]>>;
    if (!accepted && this.pairingStore) {
      pairing = await this.pairingStore.authenticate(token, { audience: "gateway" });
      // Tunnel-audience credentials are accepted only on the loopback hop used
      // by an owned external tunnel client. They remain invalid at the public
      // Gateway HTTP boundary and carry their narrow pairing scopes.
      if (!pairing && isLoopbackHost(remote)) pairing = await this.pairingStore.authenticate(token, { audience: "gateway.tunnel" });
      if (pairing) accepted = true;
    }
    if (!accepted) {
      return {
        status: 401,
        message: "Bearer authentication required",
        wwwAuthenticate: `Bearer resource_metadata="${resourceMetadataUrl}"`,
      };
    }
    const fingerprint = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
    return { principal: createGatewayPrincipal("http", pairing ? `pairing:${pairing.id}` : `bearer:${fingerprint}`, {
      authenticated: true,
      source: pairing?.provider ? `${remote}:${pairing.provider}` : remote,
      scopes: pairing?.scopes ?? ["gateway"],
      ...(pairing?.workspaceId === undefined ? {} : { workspaceId: pairing.workspaceId }),
    }) };
  }

  async handleOAuthRoute(request: IncomingMessage, response: ServerResponse, url: URL, baseUrl: string, mcpPath: string): Promise<boolean> {
    const pathname = url.pathname;
    if (pathname === "/.well-known/oauth-protected-resource" || pathname === `/.well-known/oauth-protected-resource${mcpPath}`) {
      this.json(response, 200, {
        resource: `${baseUrl}${mcpPath}`,
        authorization_servers: [baseUrl],
        scopes_supported: ["gateway"],
      });
      return true;
    }
    if (pathname === "/.well-known/oauth-authorization-server") {
      this.json(response, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256", "plain"],
        scopes_supported: ["gateway"],
      });
      return true;
    }
    if (pathname === "/register" && request.method === "POST") {
      const body = await readJsonBody(request);
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((value): value is string => typeof value === "string" && validRedirect(value)) : [];
      if (redirectUris.length === 0) return this.oauthError(response, 400, "invalid_redirect_uri");
      const clientId = randomToken(24);
      this.clients.set(clientId, { redirectUris });
      this.json(response, 201, { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: "none" });
      return true;
    }
    if (pathname === "/authorize" && request.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const clientId = url.searchParams.get("client_id") ?? "";
      if (!this.validClientRedirect(clientId, redirectUri)) return this.oauthError(response, 400, "invalid_redirect_uri");
      const fields = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"];
      const hidden = fields.map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(url.searchParams.get(name) ?? "")}">`).join("");
      const html = `<!doctype html><meta charset="utf-8"><title>Authorize Pi Maestro Gateway</title><form method="post" action="/authorize">${hidden}<label>Operations password <input type="password" name="password" required></label><button type="submit">Authorize</button></form>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(html) });
      response.end(html);
      return true;
    }
    if (pathname === "/authorize" && request.method === "POST") {
      const form = await readFormBody(request);
      const password = form.get("password") ?? "";
      if (!this.auth.oauth?.password || !constantTimeEqual(password, this.auth.oauth.password)) return this.oauthError(response, 403, "access_denied");
      const clientId = form.get("client_id") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      if (!this.validClientRedirect(clientId, redirectUri)) return this.oauthError(response, 400, "invalid_redirect_uri");
      const code = randomToken(32);
      this.codes.set(code, {
        clientId,
        redirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000,
        ...(form.get("code_challenge") ? { codeChallenge: form.get("code_challenge")! } : {}),
        ...(form.get("code_challenge_method") ? { codeChallengeMethod: form.get("code_challenge_method")! } : {}),
      });
      const destination = new URL(redirectUri);
      destination.searchParams.set("code", code);
      const state = form.get("state");
      if (state) destination.searchParams.set("state", state);
      response.writeHead(302, { location: destination.href, "cache-control": "no-store" });
      response.end();
      return true;
    }
    if (pathname === "/token" && request.method === "POST") {
      const form = await readFormBody(request);
      const codeValue = form.get("code") ?? "";
      const code = this.codes.get(codeValue);
      this.codes.delete(codeValue);
      if (!code || code.expiresAt <= Date.now()) return this.oauthError(response, 400, "invalid_grant");
      if (form.get("client_id") !== code.clientId || form.get("redirect_uri") !== code.redirectUri) return this.oauthError(response, 400, "invalid_grant");
      if (code.codeChallenge) {
        const verifier = form.get("code_verifier") ?? "";
        const projected = code.codeChallengeMethod === "S256"
          ? createHash("sha256").update(verifier, "utf8").digest("base64url")
          : verifier;
        if (!constantTimeEqual(projected, code.codeChallenge)) return this.oauthError(response, 400, "invalid_grant");
      }
      const accessToken = randomToken(32);
      const expiresIn = Math.max(1, Math.floor((this.auth.oauth?.tokenTtlMs ?? 24 * 60 * 60 * 1000) / 1000));
      this.tokens.set(accessToken, { expiresAt: Date.now() + expiresIn * 1000, subject: code.clientId });
      this.json(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, scope: "gateway" });
      return true;
    }
    return false;
  }

  private validClientRedirect(clientId: string, redirectUri: string): boolean {
    if (!validRedirect(redirectUri)) return false;
    const registered = this.clients.get(clientId);
    return registered ? registered.redirectUris.includes(redirectUri) : clientId.length > 0;
  }

  private oauthError(response: ServerResponse, status: number, error: string): true {
    this.json(response, status, { error });
    return true;
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
    response.end(body);
  }
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function validRedirect(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]!));
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > OAUTH_BODY_LIMIT) throw new Error("OAuth request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBoundedBody(request)).toString("utf8"));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBoundedBody(request)).toString("utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OAuth JSON body must be an object");
  return parsed as Record<string, unknown>;
}
