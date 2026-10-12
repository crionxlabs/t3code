/**
 * Starts the full A1 local stack with one command:
 *   - the A1 central service (adelisone-platform): tenant Postgres via docker compose,
 *     then the tenant app (`npm run dev` → next dev on :3000, ngrok tunnel if installed)
 *   - the A1 app (this repo): `node scripts/dev-runner.ts dev` (local server + web)
 *
 * The platform repo is expected as a sibling checkout (../adelisone-platform);
 * override with A1_PLATFORM_DIR. Ctrl-C stops everything that was started.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const platformDir = process.env.A1_PLATFORM_DIR ?? path.resolve(appDir, "..", "adelisone-platform");

if (!existsSync(path.join(platformDir, "apps", "tenant", "package.json"))) {
  console.error(`[dev-all] adelisone-platform not found at ${platformDir} (set A1_PLATFORM_DIR)`);
  process.exit(1);
}

// Postgres first; `up -d` is idempotent, so an already-running db is fine.
// The tenant app's instrumentation hook needs the db at startup, so if the Docker
// daemon is down, start Docker Desktop and wait for it rather than booting broken.
const dockerUp = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
if (!dockerUp() && process.platform === "darwin") {
  console.log("[dev-all] Docker daemon not running — starting Docker Desktop…");
  spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
  const deadline = Date.now() + 60_000;
  while (!dockerUp() && Date.now() < deadline) spawnSync("sleep", ["2"]);
}
const compose = spawnSync("docker", ["compose", "up", "-d", "tenant-db"], {
  cwd: platformDir,
  stdio: "inherit",
});
if (compose.status !== 0) {
  console.warn(
    "[dev-all] docker compose failed — continuing; the central service needs Postgres to work",
  );
}

const children = [];
const prefix = (name, stream, out) => {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
};

const start = (name, cmd, args, cwd) => {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`[dev-all] ${name} exited (${code ?? "signal"}) — shutting down`);
    shutdown(code ?? 0);
  });
  return child;
};

let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// `pnpm dev:a1` opens the desktop (Electron) app; `pnpm dev:a1 web` serves the web UI instead.
const webUi = process.argv[2] === "web";

start("a1-server", "npm", ["run", "dev"], path.join(platformDir, "apps", "tenant"));
// Through pnpm so node_modules/.bin (vp, vite, …) is on the child's PATH.
start("app", "pnpm", [webUi ? "dev" : "dev:desktop"], appDir);

console.log(
  webUi
    ? "[dev-all] central service on http://localhost:3000 — watch the [app] lines for the pairing URL"
    : "[dev-all] central service on http://localhost:3000 — the desktop app opens when its build is ready",
);
