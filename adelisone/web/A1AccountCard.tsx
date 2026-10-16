/**
 * AdelisOne: connect this computer to the server. First time: paste the invite
 * link, which registers the computer and opens the server's sign-in page in the
 * browser. After that, one "Sign in" button. The app's server does the work
 * (adelisone/server/a1/a1Routes.ts); this card polls until it shows as signed in.
 * Shown in the welcome wizard and under Settings → General.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { readDesktopPrimaryBearerToken } from "../../apps/web/src/environments/primary/desktopAuth";
import { ensureLocalApi } from "../../apps/web/src/localApi";
import { Button } from "../../apps/web/src/components/ui/button";
import { Input } from "../../apps/web/src/components/ui/input";

interface AccountStatus {
  readonly registered: boolean;
  readonly signedIn: boolean;
  readonly platformUrl?: string;
  readonly allowedEmailDomains?: ReadonlyArray<string>;
  readonly removed?: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Desktop renders over a custom protocol, so it authenticates HTTP with a
  // bearer token from the desktop bridge; the same-origin browser uses its cookie.
  const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

async function openInBrowser(url: string): Promise<void> {
  if (window.desktopBridge) {
    await ensureLocalApi().shell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

export function useA1Account() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<AccountStatus>("/api/a1/account"));
    } catch {
      setStatus({ registered: false, signedIn: false });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, refresh };
}

export function A1AccountCard({ compact = false }: { readonly compact?: boolean }) {
  const { status, refresh } = useA1Account();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (polling.current !== null) {
      window.clearInterval(polling.current);
      polling.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);
  useEffect(() => {
    if (status?.signedIn) {
      stopPolling();
      setBusy(false);
    }
  }, [status?.signedIn, stopPolling]);

  const start = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      setError(null);
      setBusy(true);
      try {
        const { authorizationUrl } = await api<{ authorizationUrl: string }>(path, {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        });
        await openInBrowser(authorizationUrl);
        stopPolling();
        polling.current = window.setInterval(() => void refresh(), 2000);
        // Give up waiting after a while; the user can click again.
        window.setTimeout(
          () => {
            stopPolling();
            setBusy(false);
          },
          10 * 60 * 1000,
        );
      } catch (failure) {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [refresh, stopPolling],
  );

  const signOut = useCallback(async () => {
    setError(null);
    try {
      await api("/api/a1/account/sign-out", { method: "POST", body: "{}" });
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [refresh]);

  if (status === null) return null;

  if (status.signedIn) {
    const domains = status.allowedEmailDomains ?? [];
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Connected to your server</div>
          <div className="truncate text-xs text-muted-foreground">{status.platformUrl}</div>
          {domains.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              AI accounts must be on {domains.map((d) => `@${d}`).join(", ")}.
            </div>
          ) : null}
        </div>
        <Button variant="outline" size="compact" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  if (status.registered) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Signed out of your server</div>
          <div className="truncate text-xs text-muted-foreground">{status.platformUrl}</div>
        </div>
        <Button onClick={() => void start("/api/a1/account/sign-in")} disabled={busy}>
          {busy ? "Waiting for sign-in…" : "Sign in"}
        </Button>
        {error ? <div className="basis-full text-xs text-destructive">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {status.removed ? (
        <div className="text-sm text-destructive">
          This computer was removed from your server. Ask your owner or manager for a new link.
        </div>
      ) : null}
      {compact ? null : (
        <div className="text-sm text-muted-foreground">
          Paste the invite link you were sent. It connects this computer to your company&rsquo;s
          AdelisOne server, which holds the data, memory, and approvals every conversation uses.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Invite link"
          placeholder="https://yourbusiness.adelisone.com/invite/…"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          className="min-w-56 flex-1"
          disabled={busy}
        />
        <Button
          onClick={() => void start("/api/a1/account/connect", { link })}
          disabled={busy || !link.trim()}
        >
          {busy ? "Waiting for sign-in…" : "Connect"}
        </Button>
      </div>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
