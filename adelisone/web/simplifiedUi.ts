import { useSyncExternalStore } from "react";

/**
 * AdelisOne: the simplified-interface switch. AdelisOne is for non-technical
 * users, so developer surfaces (branches, source control) are hidden by
 * default; the Settings → General toggle brings them back. Stored per client
 * in localStorage — it only hides UI, the checkpoint/undo machinery always runs.
 */
const KEY = "adelisone.simplifiedUi";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return (localStorage.getItem(KEY) ?? "1") === "1";
  } catch {
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSimplifiedUi(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}

/** Non-reactive read, for render paths that can't add a hook (deep JSX). */
export function readSimplifiedUi(): boolean {
  return read();
}

export function setSimplifiedUi(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // Storage unavailable (private mode); the toggle just won't persist.
  }
  for (const listener of listeners) listener();
}
