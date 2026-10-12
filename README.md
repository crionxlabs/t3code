# AdelisOne app

The AdelisOne desktop app. Each employee installs it on their own computer. It runs AI work through the employee's own Claude Code or Codex sign-in, so usage counts against their subscription, not API credits. Business systems are reached only through the AdelisOne central service.

This repository is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT license). AdelisOne changes stay small and separate, so updates from T3 Code merge cleanly.

## Status

Step 1 of the migration plan, the rebrand, is done:

| Area                 | AdelisOne value                                    |
| -------------------- | -------------------------------------------------- |
| App name             | AdelisOne (Alpha); dev builds show AdelisOne (Dev) |
| App ID               | `com.crionx.adelisone`                             |
| Data folder          | `~/.adelisone`                                     |
| Icons                | AdelisOne mark in `assets/prod` and `assets/dev`   |
| Command-line updates | Releases from `crionxlabs/t3code`                  |

Still T3-branded:

- The in-app T3 logo (`apps/web/src/components/T3Wordmark.tsx`), some messages, and macOS permission prompts.
- The `t3` command and background service name, which change with the install script.
- The `t3code://` link scheme.
- Internal names: `@t3tools/*` packages and `T3CODE_*` settings. These stay on purpose to keep merges clean.

There's no AdelisOne installer yet. The install script is a later step.

## A1 agents

A1 ships six agents: Architect, Analyst, Advisor, Librarian, Curator, and Watchman. Each is a procedure, not a process: an `AGENT.md` and `CONTEXT.md` pair that defines the role and the context it works with.

They are split between the two sides of the system:

- **Defined centrally.** The agent definitions live in the A1 central service (the `blocks/*` folder of the `adelisone-platform` repository, not this one). The central service serves them over MCP as prompts, alongside role-filtered read tools and request tools for gated writes.
- **Run locally.** This app runs the agent loop on the employee's computer, through their own Claude Code or Codex sign-in. Invoking an A1 agent loads its block as an MCP prompt into that local session. There is no server-side agent loop.

Business systems stay behind the central service: connector credentials live in its vault, so an agent on a laptop can only reach them through A1's MCP tools, which check the employee's role, log reads, and queue writes for approval.

Details are in the [migration plan](<../adelisone-platform/docs/A1 on a T3 Code base migration plan.md>), kept in the `adelisone-platform` repository.

## Requirements

- macOS, to build and run the Mac app
- Node.js 24.13 or later
- pnpm 11.10.0
- At least one provider CLI, signed in:
  - Claude Code: `claude auth login`
  - Codex: `codex login`

## Run from source

Install dependencies once:

```bash
pnpm install
```

Then pick the surface to run:

| Command            | What starts                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:desktop` | The Mac (Electron) app, with the server bundled in                                                                                 |
| `pnpm dev`         | The server plus the web app, used from a browser                                                                                   |
| `pnpm dev:server`  | The server only, for connecting a separate client                                                                                  |
| `pnpm dev:web`     | The web app only, against a server you started yourself                                                                            |
| `pnpm dev:a1`      | Everything: the A1 central service (from the sibling `adelisone-platform` checkout, with its Postgres) plus the Mac (Electron) app |
| `pnpm dev:a1 web`  | Everything, but serving the web UI for a browser instead of opening the desktop app                                                |

The desktop app is the product; `pnpm dev` is the fastest way to work on the UI, since the desktop app wraps the same web app.

AdelisOne is for non-technical users, so git surfaces (the branch picker, Source Control settings, submodule options) are hidden by default — Settings → General → "Simplified interface" brings them back for development. The checkpoint/undo machinery runs either way. The update track selector is removed; AdelisOne has its own release channel.

Settings → General also has "Import conversations": upload a claude.ai or ChatGPT data export (drag and drop the zip) and finish in the /welcome Import step.

For browser modes, wait for the `[dev-runner]` line in the output. It shows the real ports (they shift if occupied) and a pairing URL with a one-time token. Open that full URL, not the bare `localhost` address, or the app stops at the "Pair with this environment" screen. If the token is already used, mint a new one with `node apps/server/src/bin.ts pair`.

Dev state is kept apart from an installed app's `~/.adelisone` data: in a git worktree it goes to that worktree's gitignored `.t3` folder, and otherwise to `~/.t3` (override with `--home-dir` or `T3CODE_HOME`). The `[dev-runner]` line prints the directory in use as `baseDir`.

### Full stack: `pnpm dev:a1`

`pnpm dev:a1` (`adelisone/scripts/dev-all.mjs`) runs the whole A1 architecture locally — the central service and the app — for work that needs both, like the MCP integration. It:

1. Starts Docker Desktop if it isn't running, then the platform's Postgres container.
2. Starts the central service from the sibling `adelisone-platform` checkout (Next.js on `localhost:3000`, plus an HTTPS tunnel for MCP when ngrok is installed).
3. Starts this repo's Mac (Electron) app, which opens on its own — no pairing needed, since the app owns its bundled server. With the `web` argument (`pnpm dev:a1 web`) it serves the web UI instead; watch the `[app]` lines for the pairing URL.

Output is prefixed `[a1-server]` and `[app]`; Ctrl-C stops everything. It expects `adelisone-platform` next to this repo — set `A1_PLATFORM_DIR` if it lives elsewhere. Requirements beyond this repo's: Docker Desktop, and the platform checkout with its `apps/tenant/.env` filled in.

To check your changes:

```bash
pnpm typecheck
pnpm test
```

Signing and notarization for Mac release builds aren't set up yet.

## Updates from T3 Code

| Remote     | Repository          |
| ---------- | ------------------- |
| `origin`   | `crionxlabs/t3code` |
| `upstream` | `pingdotgg/t3code`  |

To bring in T3 Code updates:

```bash
git fetch upstream
git merge upstream/main
```

- Put new AdelisOne code in its own packages.
- Keep edits to T3 Code's files small.
- If `README.md` conflicts, keep this version.

## T3 hosted services

The T3 Connect relay, `app.t3.codes`, and T3's Clerk sign-in are off. Don't copy `.env.example` to `.env`, because that connects the app to T3's production services.

## Project docs

- [A1 on a T3 Code base: migration plan](<../adelisone-platform/docs/A1 on a T3 Code base migration plan.md>) — the canonical plan, in the `adelisone-platform` repository
- [T3 hosted services left off in AdelisOne](https://claude.ai/code/artifact/017d6809-51cf-4398-8a6c-585d3b9aa92a)
- T3 Code's own docs are in [`docs/`](./docs). They still describe T3 Code.

## License

MIT. T3 Code is copyright T3 Tools Inc. Keep the [`LICENSE`](./LICENSE) file.
