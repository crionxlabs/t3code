/**
 * AdelisOne: this computer's registration and sign-in with the business's central
 * service (adelisone-platform).
 *
 * Two things live here. The *install*: this computer's entry on the business's
 * whitelist, created once from the invite link (or a link an owner makes in
 * Settings → Employees) and revocable from there. The *sign-in*: the employee's
 * OAuth tokens, bound to that install, refreshed on use. The non-secret part
 * (which business, which install, which OAuth client) lives in
 * `<stateDir>/adelisone-account.json`; secrets go in T3's secret store.
 *
 * `A1Client` is plain async code so the flow stays easy to follow and test;
 * `A1Account` is the Effect service the server wires in.
 */
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSecretStore from "../../../apps/server/src/auth/ServerSecretStore.ts";
import {
  type A1Endpoints,
  type A1Tokens,
  authorizeUrl,
  endpointsFor,
  newState,
  normalizePlatformUrl,
  parseTokenResponse,
  pkcePair,
  tokenNeedsRefresh,
} from "./oauth.ts";

const ACCOUNT_FILE = "adelisone-account.json";
const TOKENS_SECRET = "adelisone-oauth";
const INSTALL_SECRET = "adelisone-install";
const CLIENT_NAME = "AdelisOne app";
/** How long a started sign-in may wait for the browser to come back. */
const PENDING_SIGN_IN_TTL_MS = 15 * 60 * 1000;

export interface A1AccountStatus {
  /** This computer is on the business's list. */
  readonly registered: boolean;
  readonly signedIn: boolean;
  readonly platformUrl: string | undefined;
  /** Email domains the company allows for AI accounts used inside the app. */
  readonly allowedEmailDomains: ReadonlyArray<string>;
  /** The server took this computer off its list; cleared by the next successful connect. */
  readonly removed: boolean;
}

interface AccountFile {
  readonly platformUrl: string;
  readonly installId: string;
  readonly clientId?: string;
  readonly redirectUri?: string;
}

interface InstallCredential {
  readonly installId: string;
  readonly installSecret: string;
}

interface PendingSignIn {
  readonly endpoints: A1Endpoints;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly startedAt: number;
}

export interface A1RpcError {
  readonly code: number;
  readonly message: string;
}

export class A1NotSignedIn extends Error {
  constructor() {
    super("Not signed in to AdelisOne.");
  }
}

export class A1RequestFailed extends Error {
  readonly rpc: A1RpcError | undefined;
  constructor(message: string, rpc?: A1RpcError) {
    super(message);
    this.rpc = rpc;
  }
}

export interface A1SecretStorage {
  readonly read: (name: string) => Promise<unknown>;
  readonly write: (name: string, value: unknown) => Promise<void>;
  readonly clear: (name: string) => Promise<void>;
}

/** Module-level copies read by code that runs outside the service: the shared
 * runtime-instructions builder and the provider-account guard (overrides.mjs). */
let runtimeInstructions = "";
let allowedDomains: ReadonlyArray<string> = [];
export function a1RuntimeInstructions(): string {
  return runtimeInstructions;
}
export function a1AllowedEmailDomains(): ReadonlyArray<string> {
  return allowedDomains;
}

/** Reads an invite or install link: the business address plus the one-time code. */
export function parseInstallLink(
  input: string,
): { readonly platformUrl: string; readonly code: string; readonly isInvite: boolean } | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  const platformUrl = normalizePlatformUrl(url.origin);
  const match = /^\/(invite|join)\/([A-Za-z0-9_-]+)\/?$/u.exec(url.pathname);
  if (!platformUrl || !match) return undefined;
  return { platformUrl, code: match[2]!, isInvite: match[1] === "invite" };
}

export class A1Client {
  private account: AccountFile | undefined;
  private install: InstallCredential | undefined;
  private tokens: A1Tokens | undefined;
  private instructions = "";
  private removed = false;
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<A1Tokens | undefined> | undefined;
  private readonly stateDir: string;
  private readonly secrets: A1SecretStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly machineName: string;

  constructor(
    stateDir: string,
    secrets: A1SecretStorage,
    options: {
      readonly fetchImpl?: typeof fetch;
      readonly now?: () => number;
      readonly machineName?: string;
    } = {},
  ) {
    this.stateDir = stateDir;
    this.secrets = secrets;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.machineName = options.machineName ?? NodeOS.hostname();
  }

  private get accountPath(): string {
    return NodePath.join(this.stateDir, ACCOUNT_FILE);
  }

  /** Loads persisted state. Safe to call once at startup; errors mean "not set up". */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await NodeFS.readFile(this.accountPath, "utf8"),
      ) as Partial<AccountFile>;
      if (typeof parsed.platformUrl === "string" && typeof parsed.installId === "string") {
        this.account = {
          platformUrl: parsed.platformUrl,
          installId: parsed.installId,
          ...(typeof parsed.clientId === "string" ? { clientId: parsed.clientId } : {}),
          ...(typeof parsed.redirectUri === "string" ? { redirectUri: parsed.redirectUri } : {}),
        };
      }
    } catch {
      this.account = undefined;
    }
    if (!this.account) return;
    const install = (await this.secrets.read(INSTALL_SECRET).catch(() => undefined)) as
      | Partial<InstallCredential>
      | undefined;
    this.install =
      typeof install?.installId === "string" && typeof install.installSecret === "string"
        ? { installId: install.installId, installSecret: install.installSecret }
        : undefined;
    // A computer removed in Settings while the app was closed must not come back "connected".
    if (this.registered && !(await this.verifyRegistration())) return;
    this.tokens = this.install
      ? ((await this.secrets.read(TOKENS_SECRET).catch(() => undefined)) as A1Tokens | undefined)
      : undefined;
    if (this.signedIn) await this.refreshPolicy().catch(() => undefined);
  }

  get registered(): boolean {
    return this.account !== undefined && this.install !== undefined;
  }

  get signedIn(): boolean {
    return this.registered && this.tokens !== undefined;
  }

  status(): A1AccountStatus {
    return {
      registered: this.registered,
      signedIn: this.signedIn,
      platformUrl: this.account?.platformUrl,
      allowedEmailDomains: allowedDomains,
      removed: this.removed,
    };
  }

  /**
   * Asks the server whether this computer is still on its list, and forgets the registration
   * when it is not, so the app never claims a connection the server has cut. An unreachable
   * server is not a removal: the local state stays until the server answers.
   */
  async verifyRegistration(): Promise<boolean> {
    const account = this.account;
    const install = this.install;
    if (!account || !install) return false;
    const response = await this.fetchImpl(`${account.platformUrl}/api/a1/installs/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        install_id: install.installId,
        install_secret: install.installSecret,
      }),
    }).catch(() => undefined);
    if (!response?.ok) return true;
    const body = (await response.json().catch(() => ({}))) as { readonly active?: unknown };
    if (body.active !== false) return true;
    await this.forget();
    this.removed = true;
    return false;
  }

  /** Drops everything that tied this computer to the server: files, secrets, tokens, tools. */
  private async forget(): Promise<void> {
    this.account = undefined;
    this.install = undefined;
    this.tokens = undefined;
    this.instructions = "";
    runtimeInstructions = "";
    allowedDomains = [];
    await this.secrets.clear(TOKENS_SECRET).catch(() => undefined);
    await this.secrets.clear(INSTALL_SECRET).catch(() => undefined);
    await NodeFS.rm(this.accountPath, { force: true }).catch(() => undefined);
    this.notify();
  }

  /** Fires after a sign-in or sign-out so the MCP bridge can resync its tool list. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener failing must never break sign-in itself.
      }
    }
  }

  /**
   * First-time setup from the invite (or install) link: registers this computer with
   * the business, then starts the sign-in. Returns the page to open in the browser.
   * For an invite, that page accepts the invite first and continues to the consent page.
   */
  async connectWithLink(link: string, callbackUrl: string): Promise<string> {
    const parsed = parseInstallLink(link);
    if (!parsed) {
      throw new A1RequestFailed(
        "That doesn't look like an AdelisOne invite link. It should start with your business's address and contain /invite/ or /join/.",
      );
    }
    const response = await this.fetchImpl(`${parsed.platformUrl}/api/a1/installs/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: parsed.code, name: this.machineName }),
    }).catch(() => undefined);
    if (!response) throw new A1RequestFailed(`Could not reach AdelisOne at ${parsed.platformUrl}.`);
    const body = (await response.json().catch(() => ({}))) as {
      readonly install_id?: unknown;
      readonly install_secret?: unknown;
      readonly message?: unknown;
    };
    if (
      !response.ok ||
      typeof body.install_id !== "string" ||
      typeof body.install_secret !== "string"
    ) {
      throw new A1RequestFailed(
        typeof body.message === "string" ? body.message : "AdelisOne did not accept this link.",
      );
    }
    this.install = { installId: body.install_id, installSecret: body.install_secret };
    this.tokens = undefined;
    this.removed = false;
    this.account = { platformUrl: parsed.platformUrl, installId: body.install_id };
    await this.secrets.write(INSTALL_SECRET, this.install);
    await this.secrets.clear(TOKENS_SECRET).catch(() => undefined);
    await this.persistAccount();
    const consent = await this.startSignIn(callbackUrl);
    if (!parsed.isInvite) return consent;
    // A new employee accepts the invite on the platform first; it then continues to the consent page.
    const next = consent.slice(parsed.platformUrl.length);
    return `${parsed.platformUrl}/invite/${parsed.code}?next=${encodeURIComponent(next)}`;
  }

  /**
   * Starts a sign-in for a registered computer: binds an OAuth client to the install
   * (once per callback address) and returns the consent-page URL to open in the browser.
   */
  async startSignIn(callbackUrl: string): Promise<string> {
    const account = this.account;
    const install = this.install;
    if (!account || !install) {
      throw new A1RequestFailed("This computer isn't set up yet. Paste your invite link first.");
    }
    const endpoints = endpointsFor(account.platformUrl, await this.discover(account.platformUrl));
    const clientId = await this.ensureClient(endpoints, install, callbackUrl);
    const { verifier, challenge } = pkcePair();
    const state = newState();
    this.sweepPending();
    this.pending.set(state, {
      endpoints,
      clientId,
      redirectUri: callbackUrl,
      verifier,
      startedAt: this.now(),
    });
    return authorizeUrl({ endpoints, clientId, redirectUri: callbackUrl, state, challenge });
  }

  /** The browser came back: exchange the code and persist the sign-in. */
  async completeSignIn(code: string, state: string): Promise<void> {
    this.sweepPending();
    const flow = this.pending.get(state);
    if (!flow)
      throw new A1RequestFailed("This sign-in link has expired. Start again from AdelisOne.");
    this.pending.delete(state);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    const tokens = parseTokenResponse(await this.postForm(flow.endpoints.token, body), this.now());
    if (!tokens) throw new A1RequestFailed("AdelisOne did not issue a sign-in.");
    this.tokens = tokens;
    await this.secrets.write(TOKENS_SECRET, tokens);
    await this.refreshPolicy().catch(() => undefined);
    this.notify();
  }

  /** Signs the employee out; the computer stays registered. */
  async signOut(): Promise<void> {
    this.tokens = undefined;
    this.instructions = "";
    runtimeInstructions = "";
    allowedDomains = [];
    await this.secrets.clear(TOKENS_SECRET).catch(() => undefined);
    this.notify();
  }

  /** The platform's standing instructions from `initialize` (business memory rules, approvals). */
  get platformInstructions(): string {
    return this.instructions;
  }

  /** JSON-RPC against the platform's MCP endpoint as the signed-in employee. */
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const account = this.account;
    if (!account || !this.tokens) throw new A1NotSignedIn();
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${account.platformUrl}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
    });
    if (response.status === 401) {
      // The business said no: the employee or this computer was removed, or the token revoked.
      await this.dropTokens();
      await this.verifyRegistration().catch(() => undefined);
      throw new A1NotSignedIn();
    }
    if (!response.ok) {
      throw new A1RequestFailed(`AdelisOne returned HTTP ${response.status} for ${method}.`);
    }
    const payload = (await response.json()) as {
      readonly result?: T;
      readonly error?: A1RpcError;
    };
    if (payload.error) throw new A1RequestFailed(payload.error.message, payload.error);
    return payload.result as T;
  }

  private async dropTokens(): Promise<void> {
    this.tokens = undefined;
    await this.secrets.clear(TOKENS_SECRET).catch(() => undefined);
    this.notify();
  }

  private async accessToken(): Promise<string> {
    const tokens = this.tokens;
    const account = this.account;
    if (!tokens || !account?.clientId) throw new A1NotSignedIn();
    if (!tokenNeedsRefresh(tokens, this.now()) || !tokens.refreshToken) return tokens.accessToken;
    const clientId = account.clientId;
    // Single-flight: concurrent tool calls share one refresh.
    this.refreshing ??= (async () => {
      const endpoints = endpointsFor(account.platformUrl);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refreshToken ?? "",
      });
      const next = parseTokenResponse(await this.postForm(endpoints.token, body), this.now());
      if (next) {
        this.tokens = { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
        await this.secrets.write(TOKENS_SECRET, this.tokens);
      }
      return next;
    })().finally(() => {
      this.refreshing = undefined;
    });
    const refreshed = await this.refreshing;
    if (!refreshed) {
      await this.dropTokens();
      throw new A1NotSignedIn();
    }
    return refreshed.accessToken;
  }

  /** `initialize` carries the standing instructions and the company's AI-account rule. */
  private async refreshPolicy(): Promise<void> {
    const result = await this.rpc<{
      readonly instructions?: unknown;
      readonly adelisone?: { readonly allowedEmailDomains?: unknown };
    }>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: "1" },
    });
    this.instructions = typeof result?.instructions === "string" ? result.instructions : "";
    runtimeInstructions = this.instructions;
    const domains = result?.adelisone?.allowedEmailDomains;
    allowedDomains = Array.isArray(domains)
      ? domains.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase())
      : [];
  }

  private async discover(platformUrl: string): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.fetchImpl(
        `${platformUrl}/.well-known/oauth-authorization-server`,
        {
          headers: { accept: "application/json" },
        },
      );
      return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The OAuth client bound to this install, registered once per callback address. */
  private async ensureClient(
    endpoints: A1Endpoints,
    install: InstallCredential,
    callbackUrl: string,
  ): Promise<string> {
    const account = this.account!;
    if (account.clientId && account.redirectUri === callbackUrl) return account.clientId;
    const response = await this.fetchImpl(endpoints.register, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [callbackUrl],
        install_id: install.installId,
        install_secret: install.installSecret,
      }),
    });
    if (!response.ok) {
      throw new A1RequestFailed(
        response.status === 400
          ? "This computer is no longer registered with the business. Ask your owner or manager for a new install link."
          : `Could not reach AdelisOne at ${endpoints.issuer} (HTTP ${response.status}).`,
      );
    }
    const body = (await response.json()) as { readonly client_id?: unknown };
    if (typeof body.client_id !== "string") {
      throw new A1RequestFailed("AdelisOne did not accept this app as a client.");
    }
    this.account = { ...account, clientId: body.client_id, redirectUri: callbackUrl };
    await this.persistAccount();
    return body.client_id;
  }

  private async persistAccount(): Promise<void> {
    await NodeFS.mkdir(this.stateDir, { recursive: true });
    await NodeFS.writeFile(this.accountPath, JSON.stringify(this.account, null, 2));
  }

  private async postForm(url: string, body: URLSearchParams): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    const json = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      const code =
        typeof json === "object" && json !== null && "error" in json
          ? String((json as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new A1RequestFailed(`Sign-in failed (${code}).`);
    }
    return json;
  }

  private sweepPending(): void {
    const cutoff = this.now() - PENDING_SIGN_IN_TTL_MS;
    for (const [state, flow] of this.pending) {
      if (flow.startedAt < cutoff) this.pending.delete(state);
    }
  }
}

export class A1Account extends Context.Service<A1Account, A1Client>()("adelisone/A1Account") {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const secrets: A1SecretStorage = {
    read: (name) =>
      Effect.runPromise(
        secretStore
          .get(name)
          .pipe(
            Effect.map((value) =>
              Option.isSome(value)
                ? (JSON.parse(decoder.decode(value.value)) as unknown)
                : undefined,
            ),
          ),
      ),
    write: (name, value) =>
      Effect.runPromise(secretStore.set(name, encoder.encode(JSON.stringify(value)))),
    clear: (name) => Effect.runPromise(secretStore.remove(name)),
  };
  const client = new A1Client(config.stateDir, secrets);
  yield* Effect.promise(() => client.load());
  return client;
});

export const layer = Layer.effect(A1Account)(make);
