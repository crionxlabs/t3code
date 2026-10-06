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

## Requirements

- macOS, to build and run the Mac app
- Node.js 24.13 or later
- pnpm 11.10.0
- At least one provider CLI, signed in:
  - Claude Code: `claude auth login`
  - Codex: `codex login`

## Run from source

```bash
pnpm install
pnpm dev:desktop
```

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

- [A1 on a T3 Code base: migration plan](https://claude.ai/code/artifact/618d3be2-2a10-4ac6-bf79-91ae7fa94fa8)
- [T3 hosted services left off in AdelisOne](https://claude.ai/code/artifact/017d6809-51cf-4398-8a6c-585d3b9aa92a)
- T3 Code's own docs are in [`docs/`](./docs). They still describe T3 Code.

## License

MIT. T3 Code is copyright T3 Tools Inc. Keep the [`LICENSE`](./LICENSE) file.
