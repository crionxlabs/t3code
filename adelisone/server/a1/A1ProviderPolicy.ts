/**
 * AdelisOne: company AI accounts only. The business lists the email domains its
 * AI accounts live on (Settings → AI Provider on the platform); the app learns the
 * list at sign-in. Before any turn starts, the account the provider is signed in
 * with is checked against it, and an outside account is refused with a plain
 * message. One check for every provider, at the one place every turn passes.
 *
 * Providers that can't say which account they use (API keys, local models)
 * carry no email, so they pass; the check applies where identity is known.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { ProviderAdapterTurnStartError } from "../../../apps/server/src/orchestration-v2/ProviderAdapter.ts";
import * as ProviderRegistry from "../../../apps/server/src/provider/Services/ProviderRegistry.ts";
import { a1AllowedEmailDomains } from "./A1Account.ts";

/** Signed-in account email by provider instance, kept current from the registry stream. */
const accountEmails = new Map<string, string>();

export function rememberProviderAccounts(providers: ReadonlyArray<ServerProvider>): void {
  for (const provider of providers) {
    const email = provider.auth.email?.trim().toLowerCase();
    if (email) accountEmails.set(provider.instanceId, email);
    else accountEmails.delete(provider.instanceId);
  }
}

/** The reason an account is refused, or undefined when it may be used. */
export function providerAccountRefusal(
  email: string | undefined,
  domains: ReadonlyArray<string> = a1AllowedEmailDomains(),
): string | undefined {
  if (!email || domains.length === 0) return undefined;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const allowed = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (allowed) return undefined;
  const list = domains.map((d) => `@${d}`).join(", ");
  return `This AI account (${email}) is a personal account. Your business only allows company AI accounts (${list}). Sign in to the provider with your work account under Settings → Agents.`;
}

export class A1ProviderAccountRefused extends Error {
  readonly _tag = "A1ProviderAccountRefused";
}

/** Fails the turn before it reaches the provider when its account is outside the company. */
export const a1AssertProviderAccountAllowed = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly runId: RunId;
}): Effect.Effect<void, ProviderAdapterTurnStartError> => {
  const refusal = providerAccountRefusal(accountEmails.get(input.instanceId));
  return refusal === undefined
    ? Effect.void
    : Effect.fail(
        new ProviderAdapterTurnStartError({
          driver: input.driver,
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          runId: input.runId,
          cause: new A1ProviderAccountRefused(refusal),
        }),
      );
};

/** Keeps the account map current for as long as the server runs. */
export const watchProviderAccounts = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  rememberProviderAccounts(yield* providers.getProviders);
  yield* providers.streamChanges.pipe(
    Stream.runForEach((snapshot) => Effect.sync(() => rememberProviderAccounts(snapshot))),
    Effect.forkScoped,
  );
});
