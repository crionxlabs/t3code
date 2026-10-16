/**
 * AdelisOne: HTTP routes for connecting this computer to the business. Wired into
 * the route table by an overrides.mjs patch on apps/server/src/server.ts.
 *
 *   GET  /api/a1/account             → { registered, signedIn, platformUrl, allowedEmailDomains }
 *   POST /api/a1/account/connect     { link } → { authorizationUrl }   first time, from the invite link
 *   POST /api/a1/account/sign-in     → { authorizationUrl }            later sign-ins
 *   GET  /api/a1/oauth/callback      the browser returns here with ?code&state
 *   POST /api/a1/account/sign-out
 *
 * The callback is the only unauthenticated route: the OAuth `state` ties it to
 * a sign-in this server started, and it carries nothing but the one-time code.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../../../apps/server/src/auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../../apps/server/src/config.ts";
import { A1Account, A1RequestFailed } from "./A1Account.ts";

const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const authed = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
    return Option.isSome(session);
  });

const failureMessage = (error: unknown): string =>
  error instanceof A1RequestFailed || error instanceof Error ? error.message : String(error);

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** The page the browser lands on after the platform's consent screen. */
const callbackPage = (success: boolean, detail: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${success ? "Signed in" : "Sign-in didn't finish"} · AdelisOne</title>
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181b;background:#fafafa}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{max-width:440px;background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:32px}
h1{font-size:22px;font-weight:600;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#71717a;margin:0}
@media(prefers-color-scheme:dark){:root{color:#fafafa;background:#09090b}main{background:#18181b;border-color:#27272a}p{color:#a1a1aa}}
</style></head><body><main>
<h1>${success ? "You're signed in to AdelisOne" : "Sign-in didn't finish"}</h1>
<p>${escapeHtml(detail)}</p>
</main></body></html>`;

/** The browser must reach this server directly; the web origin may be a dev proxy or
 * the desktop's custom scheme, so the loopback address is the one that is always right. */
const callbackUrl = Effect.map(
  ServerConfig.ServerConfig,
  (config) => `http://127.0.0.1:${config.port}/api/a1/oauth/callback`,
);

const startedResponse = (start: Promise<string>) =>
  Effect.promise(() =>
    start
      .then((authorizationUrl) => json(200, { authorizationUrl }))
      .catch((error: unknown) => json(400, { error: failureMessage(error) })),
  );

export const a1AccountStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/a1/account",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    const account = yield* A1Account;
    // The card and the startup popup read this; checking with the server here is what makes a
    // computer removed in Settings → Employees stop showing "connected".
    yield* Effect.promise(() => account.verifyRegistration().catch(() => true));
    return json(200, { ...account.status() });
  }),
);

export const a1ConnectRouteLayer = HttpRouter.add(
  "POST",
  "/api/a1/account/connect",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    const account = yield* A1Account;
    const callback = yield* callbackUrl;
    const body = yield* request.json.pipe(Effect.option);
    const link =
      Option.isSome(body) && typeof body.value === "object" && body.value !== null
        ? String((body.value as { link?: unknown }).link ?? "")
        : "";
    return yield* startedResponse(account.connectWithLink(link, callback));
  }),
);

export const a1SignInRouteLayer = HttpRouter.add(
  "POST",
  "/api/a1/account/sign-in",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    const account = yield* A1Account;
    const callback = yield* callbackUrl;
    return yield* startedResponse(account.startSignIn(callback));
  }),
);

export const a1OauthCallbackRouteLayer = HttpRouter.add(
  "GET",
  "/api/a1/oauth/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const account = yield* A1Account;
    const url = HttpServerRequest.toURL(request);
    const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
    const page = (success: boolean, detail: string) =>
      HttpServerResponse.text(callbackPage(success, detail), {
        status: success ? 200 : 400,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    const error = params.get("error");
    if (error) {
      return page(
        false,
        error === "access_denied"
          ? "You declined the connection. You can close this tab and try again from AdelisOne."
          : `The platform reported: ${error}.`,
      );
    }
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    if (!code || !state)
      return page(false, "The sign-in link was incomplete. Start again from AdelisOne.");
    const outcome = yield* Effect.promise(() =>
      account
        .completeSignIn(code, state)
        .then(() => undefined)
        .catch((failure: unknown) => failureMessage(failure)),
    );
    return outcome === undefined
      ? page(true, "You can close this tab and return to AdelisOne.")
      : page(false, outcome);
  }),
);

export const a1SignOutRouteLayer = HttpRouter.add(
  "POST",
  "/api/a1/account/sign-out",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    const account = yield* A1Account;
    yield* Effect.promise(() => account.signOut());
    return json(200, { ...account.status() });
  }),
);

export const a1AccountRouteLayers = Layer.mergeAll(
  a1AccountStatusRouteLayer,
  a1ConnectRouteLayer,
  a1SignInRouteLayer,
  a1OauthCallbackRouteLayer,
  a1SignOutRouteLayer,
);
