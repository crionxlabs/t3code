// @ts-check
// Node module hook: applies adelisone/overrides.mjs to T3's files as they
// load. Every other module passes through unchanged.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { applyOverrides, hasOverrides } from "../overrides.mjs";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * @param {string} url
 * @param {{ format?: string | null | undefined }} context
 * @param {(url: string, context: any) => Promise<{ format?: string | null | undefined; source?: string | ArrayBuffer | ArrayBufferView | null | undefined }>} nextLoad
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith("file:") || result.source == null) return result;
  const file = NodePath.relative(repoRoot, NodeURL.fileURLToPath(url))
    .split(NodePath.sep)
    .join("/");
  if (!hasOverrides(file)) return result;
  const source =
    typeof result.source === "string"
      ? result.source
      : new TextDecoder().decode(/** @type {ArrayBuffer | ArrayBufferView} */ (result.source));
  const output = applyOverrides(file, source);
  return output === source ? result : { ...result, source: output };
}
