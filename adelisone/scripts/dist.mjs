// @ts-check
// Packages the AdelisOne desktop app: runs T3 Code's packaging script with
// AdelisOne's overrides (app ID, names, icons). Takes the same arguments, for
// example: node adelisone/scripts/dist.mjs --platform mac --target dmg --arch arm64
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const register = NodeURL.pathToFileURL(
  NodePath.join(repoRoot, "adelisone", "node", "register.mjs"),
).href;

// NODE_OPTIONS rather than a flag, so the builds this script starts load the
// overrides too.
const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --import=${register}`.trim();
const result = NodeChildProcess.spawnSync(
  process.execPath,
  ["scripts/build-desktop-artifact.ts", ...process.argv.slice(2)],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: nodeOptions } },
);
process.exit(result.status ?? 1);
