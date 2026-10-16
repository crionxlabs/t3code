/**
 * AdelisOne: pure OAuth 2.1 helpers for signing an install in to the central
 * service (adelisone-platform). The platform is a public-client authorization
 * server with PKCE (S256), dynamic client registration, and a refresh grant.
 * No I/O here, so it is unit-testable without Effect.
 */
import { createHash, randomBytes } from "node:crypto";

export interface A1Endpoints {
  readonly issuer: string;
  readonly authorize: string;
  readonly token: string;
  readonly register: string;
  readonly mcp: string;
}

/** Normalizes what a person types ("localhost:3000", "https://acme.adelisone.com/") into an origin. */
export function normalizePlatformUrl(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !local) return undefined;
  return url.origin;
}

/** The platform's well-known layout; RFC 8414 metadata can override it. */
export function endpointsFor(
  platformUrl: string,
  metadata?: {
    readonly authorization_endpoint?: unknown;
    readonly token_endpoint?: unknown;
    readonly registration_endpoint?: unknown;
  },
): A1Endpoints {
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" && value.length > 0 ? value : fallback;
  return {
    issuer: platformUrl,
    authorize: str(metadata?.authorization_endpoint, `${platformUrl}/oauth/authorize`),
    token: str(metadata?.token_endpoint, `${platformUrl}/api/oauth/token`),
    register: str(metadata?.registration_endpoint, `${platformUrl}/api/oauth/register`),
    mcp: `${platformUrl}/api/mcp`,
  };
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function authorizeUrl(input: {
  readonly endpoints: A1Endpoints;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.endpoints.authorize);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "mcp");
  return url.toString();
}

export interface A1Tokens {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** Epoch milliseconds; absent when the server gave no expiry. */
  readonly expiresAt: number | undefined;
}

/** Reads a token-endpoint response. Returns undefined when it is not a usable grant. */
export function parseTokenResponse(body: unknown, now: number): A1Tokens | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;
  const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token : undefined;
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn === undefined ? undefined : now + expiresIn * 1000,
  };
}

/** Refresh a minute early so a token never expires mid-call. */
export function tokenNeedsRefresh(tokens: A1Tokens, now: number): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - now < 60_000;
}
