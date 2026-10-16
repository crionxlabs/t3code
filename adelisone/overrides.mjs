// @ts-check
/**
 * Every change AdelisOne makes to T3 Code, in one place.
 *
 * T3 Code's files stay untouched. These overrides are applied while the app is
 * built (vite.mjs) and while T3's Node scripts load (node/loader.mjs). Each
 * `find` must match T3's current source exactly `count` times (default 1), so
 * a T3 update that changes one of these lines fails loudly instead of silently
 * dropping an AdelisOne change. Run `node --test "adelisone/tests/*.test.mjs"` after merging
 * T3 Code updates to check them all.
 *
 * After those, RENAME changes every remaining "T3 Code" in T3's text to
 * "AdelisOne", so most name changes don't need their own entry.
 */

/**
 * @typedef {{ readonly find: string; readonly replace: string; readonly count?: number }} Replacement
 */

/** Icon files AdelisOne replaces. Ours live at the same paths under adelisone/. */
export const ICON_FILES = [
  "assets/prod/black-ios-1024.png",
  "assets/prod/black-macos-1024.png",
  "assets/prod/black-universal-1024.png",
  "assets/prod/t3-black-web-apple-touch-180.png",
  "assets/prod/t3-black-web-favicon-16x16.png",
  "assets/prod/t3-black-web-favicon-32x32.png",
  "assets/prod/t3-black-web-favicon.ico",
  "assets/prod/t3-black-windows.ico",
  "assets/dev/blueprint-ios-1024.png",
  "assets/dev/blueprint-macos-1024.png",
  "assets/dev/blueprint-universal-1024.png",
  "assets/dev/blueprint-web-apple-touch-180.png",
  "assets/dev/blueprint-web-favicon-16x16.png",
  "assets/dev/blueprint-web-favicon-32x32.png",
  "assets/dev/blueprint-web-favicon.ico",
  "assets/dev/blueprint-windows.ico",
];

/** The web dev server's favicons (apps/web/public), served from our dev icons. */
export const DEV_WEB_ICONS = {
  "/favicon.ico": "assets/dev/blueprint-web-favicon.ico",
  "/favicon-16x16.png": "assets/dev/blueprint-web-favicon-16x16.png",
  "/favicon-32x32.png": "assets/dev/blueprint-web-favicon-32x32.png",
  "/apple-touch-icon.png": "assets/dev/blueprint-web-apple-touch-180.png",
};

/** T3 files replaced whole by an AdelisOne file. */
export const FILE_SWAPS = {
  "apps/web/src/components/T3Wordmark.tsx": "adelisone/web/T3Wordmark.tsx",
};

/** @type {Record<string, ReadonlyArray<Replacement>>} */
export const REPLACEMENTS = {
  // ── Name ──────────────────────────────────────────────────────────────
  "apps/desktop/src/app/DesktopEnvironment.ts": [
    { find: 'const APP_BASE_NAME = "T3 Code";', replace: 'const APP_BASE_NAME = "AdelisOne";' },
    // App ID
    {
      find: 'isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code"',
      replace: 'isDevelopment ? "com.crionx.adelisone.dev" : "com.crionx.adelisone"',
    },
    {
      find: 'linuxWmClass: isDevelopment ? "t3code-dev" : "t3code"',
      replace: 'linuxWmClass: isDevelopment ? "adelisone-dev" : "adelisone"',
    },
  ],
  "apps/web/src/branding.ts": [
    {
      find: 'injectedDesktopAppBranding?.baseName ?? "T3 Code"',
      replace: 'injectedDesktopAppBranding?.baseName ?? "AdelisOne"',
    },
  ],
  "apps/web/index.html": [
    { find: "<title>T3 Code (Alpha)</title>", replace: "<title>AdelisOne (Alpha)</title>" },
    {
      find: 'aria-label="T3 Code splash screen"',
      replace: 'aria-label="AdelisOne splash screen"',
    },
    { find: 'alt="T3 Code" />', replace: 'alt="AdelisOne" />' },
  ],

  // ── App ID (Linux desktop entry) ───────────────────────────────────────
  "apps/desktop/src/app/DesktopEarlyElectronStartup.ts": [
    {
      find: 'isDevelopment ? "com.t3tools.T3Code.Development.desktop" : "com.t3tools.T3Code.desktop"',
      replace:
        'isDevelopment ? "com.crionx.AdelisOne.Development.desktop" : "com.crionx.AdelisOne.desktop"',
    },
    {
      find: 'linuxWmClass: isDevelopment ? "t3code-dev" : "t3code"',
      replace: 'linuxWmClass: isDevelopment ? "adelisone-dev" : "adelisone"',
    },
  ],

  // ── Data folders: ~/.adelisone, never shared with T3 Code ─────────────────
  "apps/desktop/src/app/DesktopStatePaths.ts": [
    {
      find: 'input.joinPath(input.homeDirectory, ".t3")',
      replace: 'input.joinPath(input.homeDirectory, ".adelisone")',
    },
  ],
  "apps/server/src/os-jank.ts": [
    {
      find: 'return join(NodeOS.homedir(), ".t3");',
      replace: 'return join(NodeOS.homedir(), ".adelisone");',
    },
  ],
  "apps/desktop/src/app/DesktopUserData.ts": [
    {
      find: '? { current: "t3code-dev", legacy: "T3 Code (Dev)" }',
      replace: '? { current: "adelisone-dev", legacy: "AdelisOne (Dev)" }',
    },
    {
      find: ': { current: "t3code-v2", legacy: "T3 Code (Alpha)" };',
      replace: ': { current: "adelisone", legacy: "AdelisOne (Alpha)" };',
    },
    {
      find: 'path.join(input.appDataDirectory, "t3code", "Local State")',
      replace: 'path.join(input.appDataDirectory, "adelisone", "Local State")',
    },
  ],

  // ── Icons: read from adelisone/assets ──────────────────────────────────
  "apps/desktop/src/app/DesktopAssets.ts": [
    {
      find: 'environment.path.join(environment.rootDir, "assets", brand, fileName)',
      replace: 'environment.path.join(environment.rootDir, "adelisone", "assets", brand, fileName)',
    },
  ],
  "scripts/lib/brand-assets.ts": ICON_FILES.map((file) => ({
    find: `"${file}"`,
    replace: `"adelisone/${file}"`,
  })),

  // ── Updates come from the AdelisOne fork ───────────────────────────────
  "packages/shared/src/cliRelease.ts": [
    {
      find: 'const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";',
      replace: 'const CLI_RELEASE_REPOSITORY = "crionxlabs/t3code";',
    },
  ],

  // ── Sidebar: the Settled section is labeled Chats ─────────────────────
  "apps/web/src/components/Sidebar.tsx": [
    { find: '? "Settled"', replace: '? "Chats"' },
    {
      find: ": `Settled (${settledThreads.length})`",
      replace: ": `Chats (${settledThreads.length})`",
    },
    { find: 'label="Settled"', replace: 'label="Chats"' },
  ],

  // ── An idle chat is a finished chat, not "Waiting" ─────────────────────
  // In a chat app, an idle thread is a done conversation (your turn), not
  // pending work. Show it as a normal/done row (date) instead of the
  // coding-tool "Waiting" status, so imported chats don't all read as pending.
  "apps/web/src/components/Sidebar.logic.ts": [
    {
      find: '  if (thread.runtime?.status === "idle") {\n    return "waiting";\n  }',
      replace: '  if (thread.runtime?.status === "idle") {\n    return "ready";\n  }',
    },
  ],

  // ── Codex sign-in page: the brand line above the message ───────────────
  "apps/server/src/provider/CodexAuthCallbackPage.ts": [
    {
      find: '<div class="brand"><strong>T3</strong> Code</div>',
      replace: '<div class="brand"><strong>AdelisOne</strong></div>',
    },
  ],

  // ── In-app wordmark ────────────────────────────────────────────────────
  "apps/web/src/components/sidebar/SidebarChrome.tsx": [
    {
      find: '<T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />',
      replace: '<T3Wordmark aria-hidden className="h-[1cap] w-auto shrink-0" />',
    },
    {
      find: "        Code\n      </span>\n    </span>\n  );\n}",
      replace: "        AdelisOne\n      </span>\n    </span>\n  );\n}",
    },
  ],

  // ── Setup wizard: name, and the Connect step as an advanced option ─────
  // Startup popup: ask for the invite link until this computer is connected.
  "apps/web/src/routes/__root.tsx": [
    {
      find: 'import { ConfirmDialogHost } from "../components/ConfirmDialogHost";',
      replace:
        'import { ConfirmDialogHost } from "../components/ConfirmDialogHost";\nimport { A1ConnectDialogHost } from "~adelisone/web/A1ConnectDialog";',
    },
    {
      find: "          <ConfirmDialogHost />\n          <CustomSnoozeDialogHost />\n          <SlowRpcRequestToastCoordinator />",
      replace:
        "          <ConfirmDialogHost />\n          <A1ConnectDialogHost />\n          <CustomSnoozeDialogHost />\n          <SlowRpcRequestToastCoordinator />",
    },
  ],
  "apps/web/src/components/onboarding/WelcomeWizard.tsx": [
    {
      find: 'import { ScrollArea } from "../ui/scroll-area";',
      replace:
        'import { ScrollArea } from "../ui/scroll-area";\nimport { A1AccountCard } from "~adelisone/web/A1AccountCard";',
    },
    {
      find: '      <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(32rem,55dvh)]">\n        <div className="space-y-5 pr-3">\n          {environmentIds.map((environmentId) => (\n            <ConnectedAgentsStep',
      replace:
        '      <div className="mt-5 rounded-lg border border-border p-4">\n        <A1AccountCard />\n      </div>\n      <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(32rem,55dvh)]">\n        <div className="space-y-5 pr-3">\n          {environmentIds.map((environmentId) => (\n            <ConnectedAgentsStep',
    },
    {
      find: '  const [step, setStep] = useState<WizardStep>(resumeEnvironmentId ? "agents" : "connection");',
      replace: [
        "  // AdelisOne: setup starts at Agents on this computer. Choosing other computers",
        "  // is an advanced option, opened from the Agents step. Without a local server",
        "  // (nothing to set up here), the Connect step still comes first.",
        "  const [showConnectStep, setShowConnectStep] = useState(",
        "    () => !resumeEnvironmentId && !localAvailable,",
        "  );",
        '  const [step, setStep] = useState<WizardStep>(showConnectStep ? "connection" : "agents");',
      ].join("\n"),
    },
    {
      find: '  const scans = useProjectScans(step === "import" ? setupIds : NO_ENVIRONMENTS);',
      replace: [
        "  // AdelisOne: until the advanced Connect step chooses computers, set up this one.",
        "  const activeSetupIds =",
        "    setupIds.length > 0",
        "      ? setupIds",
        "      : primaryEnvironment",
        "        ? [primaryEnvironment.environmentId]",
        "        : NO_ENVIRONMENTS;",
        '  const scans = useProjectScans(step === "import" ? activeSetupIds : NO_ENVIRONMENTS);',
      ].join("\n"),
    },
    {
      find: '  const stageIndex = step === "agents" ? 1 : step === "import" ? 2 : 0;',
      replace: [
        "  // With the Connect step hidden, the labels start at Agents.",
        "  const stageOffset = showConnectStep ? 0 : 1;",
        "  const stages = ONBOARDING_STAGES.slice(stageOffset);",
        '  const stageIndex = (step === "agents" ? 1 : step === "import" ? 2 : 0) - stageOffset;',
      ].join("\n"),
    },
    { find: 'title="Set up T3 Code"', replace: 'title="Set up AdelisOne"' },
    {
      find: '<div className="flex items-baseline gap-1.5" role="img" aria-label="T3 Code">',
      replace: '<div className="flex items-baseline gap-1.5" role="img" aria-label="AdelisOne">',
    },
    {
      find: [
        '              <span className="text-2xl font-medium tracking-tight text-muted-foreground">',
        "                Code",
        "              </span>",
      ].join("\n"),
      replace:
        '              <span className="text-2xl font-medium tracking-tight text-foreground">AdelisOne</span>',
    },
    { find: "steps={ONBOARDING_STAGES}", replace: "steps={stages}" },
    {
      find: 'setStep(index === 0 ? "connection" : "agents");',
      replace: 'setStep(index + stageOffset === 0 ? "connection" : "agents");',
    },
    {
      find: '<AgentsStep environmentIds={setupIds} onContinue={() => setStep("import")} />',
      replace: [
        "<AgentsStep",
        "              environmentIds={activeSetupIds}",
        '              onContinue={() => setStep("import")}',
        "              onSetUpOtherComputers={",
        "                showConnectStep",
        "                  ? undefined",
        "                  : () => {",
        "                      setShowConnectStep(true);",
        '                      setStep("connection");',
        "                    }",
        "              }",
        "            />",
      ].join("\n"),
    },
    {
      find: "  onContinue,\n}: {\n  readonly environmentIds: readonly EnvironmentId[];\n  readonly onContinue: () => void;\n}) {",
      replace: [
        "  onContinue,",
        "  onSetUpOtherComputers,",
        "}: {",
        "  readonly environmentIds: readonly EnvironmentId[];",
        "  readonly onContinue: () => void;",
        "  /** AdelisOne: opens the hidden Connect step. Omitted once it is showing. */",
        "  readonly onSetUpOtherComputers?: (() => void) | undefined;",
        "}) {",
      ].join("\n"),
    },
    {
      find: '      </ScrollArea>\n      <div className="mt-6 flex justify-end">\n        <Button autoFocus onClick={onContinue}>',
      replace: [
        "      </ScrollArea>",
        '      <div className="mt-6 flex items-center justify-end gap-3">',
        "        {onSetUpOtherComputers ? (",
        "          <Button",
        '            variant="ghost-muted"',
        '            size="xs"',
        '            className="mr-auto"',
        "            onClick={onSetUpOtherComputers}",
        "          >",
        "            Set up other computers (advanced)",
        "          </Button>",
        "        ) : null}",
        "        <Button autoFocus onClick={onContinue}>",
      ].join("\n"),
    },
  ],

  // ── Dev launcher (macOS dock name, bundle ID, icon) ────────────────────
  "apps/desktop/scripts/electron-launcher.mjs": [
    {
      find: 'const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";',
      replace: 'const APP_DISPLAY_NAME = isDevelopment ? "AdelisOne (Dev)" : "AdelisOne (Alpha)";',
    },
    {
      find: '`com.t3tools.t3code.dev.${devBundleIdSuffix || "local"}`',
      replace: '`com.crionx.adelisone.dev.${devBundleIdSuffix || "local"}`',
    },
    { find: ': "com.t3tools.t3code";', replace: ': "com.crionx.adelisone";' },
    {
      find: '  repoRoot,\n  "assets",\n  "dev",\n  "blueprint-macos-1024.png",',
      replace: '  repoRoot,\n  "adelisone",\n  "assets",\n  "dev",\n  "blueprint-macos-1024.png",',
    },
    {
      find: 'NodePath.join(repoRoot, "assets", "prod", "black-macos-1024.png")',
      replace: 'NodePath.join(repoRoot, "adelisone", "assets", "prod", "black-macos-1024.png")',
    },
  ],

  // ── Packaging (node adelisone/scripts/dist.mjs) ─────────────────────────
  "scripts/build-desktop-artifact.ts": [
    {
      find: 'const DESKTOP_APP_ID = "com.t3tools.t3code";',
      replace: 'const DESKTOP_APP_ID = "com.crionx.adelisone";',
    },
    { find: '? "T3 Code (Nightly)"', replace: '? "AdelisOne (Nightly)"' },
    {
      find: '(desktopPackageJson.productName ?? "T3 Code")',
      replace: '"AdelisOne (Alpha)"',
    },
    {
      find: 'artifactName: "T3-Code-${version}-${arch}.${ext}"',
      replace: 'artifactName: "AdelisOne-${version}-${arch}.${ext}"',
    },
    { find: 'executableName: "t3code",', replace: 'executableName: "adelisone",' },
    { find: 'StartupWMClass: "t3code",', replace: 'StartupWMClass: "adelisone",' },
  ],

  // ── Dev sidebar backdrop ────────────────────────────────────────────────
  // T3's dev builds draw a blueprint grid behind the sidebar header in fixed
  // blues. AdelisOne keeps the dev tell but as a plain gradient built from the
  // selected theme's own colors. The original art stays as dead code below the
  // replacement so this override is one line of anchor.
  "apps/web/src/components/SidebarStageBackdrop.tsx": [
    {
      find: "function DevBlueprintArt({ compact = false }: { compact?: boolean }) {",
      replace:
        'function DevBlueprintArt(_props: { compact?: boolean }) {\n  return (\n    <div\n      aria-hidden\n      className="h-full w-full"\n      style={{\n        background:\n          "linear-gradient(135deg, color-mix(in oklab, var(--primary) 30%, var(--sidebar)), var(--sidebar) 85%)",\n      }}\n    />\n  );\n}\n\nfunction DevBlueprintArtUnused({ compact = false }: { compact?: boolean }) {',
    },
  ],

  // ── Settled-thread banner ────────────────────────────────────────────────
  // "This thread is settled — send a message to unsettle" confuses non-technical
  // users (every imported chat is settled). Drop the settled banner; the snooze
  // banner is unchanged.
  "apps/web/src/components/ChatView.tsx": [
    {
      find: "if (!activeThreadSnoozed && !activeThreadSettled) {",
      replace: "if (!activeThreadSnoozed) {",
    },
  ],

  // ── Imported-chat recency ────────────────────────────────────────────────
  // T3 only imports agent sessions touched in the last 30 days. AdelisOne
  // imports whole claude.ai / ChatGPT histories, which keep their original
  // (often older) dates, so the window is widened to ~100 years.
  "apps/server/src/project/AgentSessionScanner.ts": [
    {
      find: "const RECENT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;",
      replace: "const RECENT_THREAD_WINDOW_MS = 36500 * 24 * 60 * 60 * 1000;",
    },
  ],

  // ── URL scheme ──────────────────────────────────────────────────────────
  // The custom protocol the packaged renderer is served over (shown in the
  // window/devtools title). t3code:// → adelisone://. The scheme is the
  // renderer's origin, so every place that trusts that origin — the server's
  // CORS allowlist and the provider auth-handoff/return validators — must move
  // together, or the renderer can't reach its own server.
  "apps/desktop/src/electron/ElectronProtocol.ts": [
    {
      find: 'const DESKTOP_PRODUCTION_SCHEME = "t3code";',
      replace: 'const DESKTOP_PRODUCTION_SCHEME = "adelisone";',
    },
    {
      find: 'const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";',
      replace: 'const DESKTOP_DEVELOPMENT_SCHEME = "adelisone-dev";',
    },
  ],
  "scripts/build-desktop-artifact.ts": [
    {
      find: 'schemes: ["t3code", "t3code-dev"],',
      replace: 'schemes: ["adelisone", "adelisone-dev"],',
      count: 2,
    },
  ],
  "apps/server/src/http.ts": [
    {
      find: 'const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];',
      replace: 'const DESKTOP_RENDERER_ORIGINS = ["adelisone://app", "adelisone-dev://app"];',
    },
  ],
  "packages/shared/src/codexAuthHandoff.ts": [
    {
      find: 'new URL(`${development ? "t3code-dev" : "t3code"}://auth/codex`)',
      replace: 'new URL(`${development ? "adelisone-dev" : "adelisone"}://auth/codex`)',
    },
    {
      find: 'url.protocol !== (development ? "t3code-dev:" : "t3code:")',
      replace: 'url.protocol !== (development ? "adelisone-dev:" : "adelisone:")',
    },
  ],
  "packages/shared/src/providerAuthReturnUrl.ts": [
    {
      find: 'const desktop = ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";',
      replace:
        'const desktop = ["adelisone:", "adelisone-dev:"].includes(url.protocol) && url.host === "app";',
    },
  ],

  // ── Memory / Artifacts / Projects button (adelisone/web/ImportedLibraryPanel.tsx) ────
  // A sidebar-header button opening the employee's own Memory / Artifacts /
  // Projects views for imported reference content, kept separate from the
  // thread list. "Library" is reserved for the company-wide shared store.
  "apps/web/src/components/sidebar/SidebarThreadHeader.tsx": [
    {
      find: 'import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";',
      replace:
        'import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";\nimport { ImportedLibraryButton } from "~adelisone/web/ImportedLibraryPanel";',
    },
    {
      find: '        <SidebarHeaderIconButton\n          label="New thread"',
      replace:
        '        <ImportedLibraryButton />\n        <SidebarHeaderIconButton\n          label="New thread"',
    },
  ],

  // ── Chat import (adelisone/server/importChatsRoute.ts) ──────────────────
  // Upload route for claude.ai / ChatGPT data exports; the Settings → General
  // row below provides the drag-and-drop UI.
  "apps/server/src/server.ts": [
    {
      find: 'import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";',
      replace:
        'import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";\nimport { a1ImportChatsRouteLayer, a1LibraryRouteLayer, a1LibraryUpdateRouteLayer, a1RelocateSessionRouteLayer } from "~adelisone/server/importChatsRoute.ts";\nimport * as A1Account from "~adelisone/server/a1/A1Account.ts";\nimport { a1AccountRouteLayers } from "~adelisone/server/a1/a1Routes.ts";\nimport { watchProviderAccounts } from "~adelisone/server/a1/A1ProviderPolicy.ts";',
    },
    {
      find: "    attachmentUploadRouteLayer,",
      replace:
        "    attachmentUploadRouteLayer,\n    a1ImportChatsRouteLayer,\n    a1LibraryRouteLayer,\n    a1LibraryUpdateRouteLayer,\n    a1RelocateSessionRouteLayer,\n    a1AccountRouteLayers,",
    },
    {
      // Company AI accounts only: keep each provider's signed-in email current for the turn guard.
      find: "const ProviderInstallationRefreshLive = Layer.effectDiscard(",
      replace:
        "const A1ProviderAccountsLive = Layer.effectDiscard(watchProviderAccounts);\n\nconst ProviderInstallationRefreshLive = Layer.effectDiscard(",
    },
    {
      find: "  ProviderInstallationRefreshLive,\n",
      replace: "  ProviderInstallationRefreshLive,\n  A1ProviderAccountsLive,\n",
    },
    {
      // One account instance shared by the sign-in routes and the MCP bridge.
      // Route handlers resolve their services from the runtime services that
      // back HttpRouter.serve, not from layers provided to the route list, so
      // the account must live with the other runtime dependencies.
      find: "  Layer.provideMerge(ServerLifecycleEvents.layer),\n  Layer.provide(NetService.layer),\n);",
      replace:
        "  Layer.provideMerge(ServerLifecycleEvents.layer),\n  Layer.provideMerge(A1Account.layer.pipe(Layer.provide(ServerSecretStore.layer))),\n  Layer.provide(NetService.layer),\n);",
    },
  ],

  // ── A1 bridge (adelisone/server/a1/) ─────────────────────────────────
  // The business's central service (adelisone-platform) is reached through
  // T3's own `t3-code` MCP server, which every provider adapter already
  // attaches in its native format: its tools and block procedures are
  // registered there after the employee signs in (A1McpRegistration), its
  // standing instructions ride the shared runtime-instructions builder, and
  // the sign-in itself is an OAuth flow served by a1Routes.
  "apps/server/src/mcp/McpHttpServer.ts": [
    {
      find: 'import * as WorktreeMcpService from "./WorktreeMcpService.ts";',
      replace:
        'import * as WorktreeMcpService from "./WorktreeMcpService.ts";\nimport { A1McpRegistrationLive } from "~adelisone/server/a1/A1McpRegistration.ts";',
    },
    {
      find: "export const layer = Layer.mergeAll(\n  PreviewToolkitRegistrationLive,",
      replace:
        "export const layer = Layer.mergeAll(\n  A1McpRegistrationLive,\n  PreviewToolkitRegistrationLive,",
    },
  ],
  "apps/server/src/orchestration-v2/ProviderSessionManager.ts": [
    {
      find: 'import * as McpProviderSession from "../mcp/McpProviderSession.ts";',
      replace:
        'import * as McpProviderSession from "../mcp/McpProviderSession.ts";\nimport { a1AssertProviderAccountAllowed } from "~adelisone/server/a1/A1ProviderPolicy.ts";',
    },
    {
      find: "              Effect.andThen(runtime.startTurn(input)),",
      replace:
        "              Effect.andThen(\n                a1AssertProviderAccountAllowed({\n                  instanceId: runtime.instanceId,\n                  driver: runtime.driver,\n                  threadId: input.threadId,\n                  providerThreadId: input.providerThread.id,\n                  runId: input.runId,\n                }),\n              ),\n              Effect.andThen(runtime.startTurn(input)),",
    },
  ],
  "apps/server/src/orchestration-v2/ProviderFailure.ts": [
    {
      // Show the refusal itself instead of the generic "provider could not start" text.
      find: '        case "ClaudeBackgroundWorkBlocksQueryReplacementError":\n          return stringField(cause, "message");',
      replace:
        '        case "ClaudeBackgroundWorkBlocksQueryReplacementError":\n          return stringField(cause, "message");\n        case "A1ProviderAccountRefused":\n          return stringField(cause, "message");',
    },
  ],
  "apps/server/src/provider/RuntimeInstructions.ts": [
    {
      find: "function toSingleLine(value: string): string {",
      replace:
        'import { a1RuntimeInstructions } from "~adelisone/server/a1/A1Account.ts";\n\n/** AdelisOne: the platform\'s standing instructions (business memory rules, approvals, connection names), fetched at sign-in. */\nfunction a1Instructions(): string {\n  const text = a1RuntimeInstructions();\n  return text ? `\\n\\n<adelisone>\\n${text}\\n</adelisone>` : "";\n}\n\nfunction toSingleLine(value: string): string {',
    },
    {
      find: "${PULL_REQUEST_LINKING_INSTRUCTIONS}`;\n}",
      replace: "${PULL_REQUEST_LINKING_INSTRUCTIONS}${a1Instructions()}`;\n}",
    },
  ],

  // ── Simplified interface (adelisone/web/simplifiedUi.ts) ────────────────
  // AdelisOne serves non-technical users: git vocabulary (branches, source
  // control, submodules) is hidden by default; Settings → General has the
  // toggle. The checkpoint/undo machinery is untouched. The update track is
  // removed outright — AdelisOne has its own release channel.
  "apps/web/src/components/BranchPicker.tsx": [
    {
      find: 'import type { VcsRef } from "@t3tools/contracts";',
      replace:
        'import type { VcsRef } from "@t3tools/contracts";\nimport { useSimplifiedUi } from "~adelisone/simplifiedUi";',
    },
    {
      find: "export function BranchPicker({",
      replace:
        "export function BranchPicker(props: Parameters<typeof BranchPickerInner>[0]) {\n  if (useSimplifiedUi()) return null;\n  return <BranchPickerInner {...props} />;\n}\n\nfunction BranchPickerInner({",
    },
  ],
  "apps/web/src/components/GitActionsControl.tsx": [
    // Commit / Push / Create PR are publishing actions for shared code repos;
    // A1 employees deliver work through MCP approvals, so these have no
    // non-technical translation — the control disappears entirely.
    {
      find: 'import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";',
      replace:
        'import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";\nimport { useSimplifiedUi } from "~adelisone/simplifiedUi";',
    },
    {
      find: "export default function GitActionsControl({",
      replace:
        "export default function GitActionsControl(props: Parameters<typeof GitActionsControlInner>[0]) {\n  if (useSimplifiedUi()) return null;\n  return <GitActionsControlInner {...props} />;\n}\n\nfunction GitActionsControlInner({",
    },
  ],
  "apps/web/src/components/settings/SettingsSidebarNav.tsx": [
    {
      find: "export function SettingsSidebarNav({ pathname }: { pathname: string }) {",
      replace:
        'import { useSimplifiedUi } from "~adelisone/simplifiedUi";\n\nexport function SettingsSidebarNav({ pathname }: { pathname: string }) {\n  const simplifiedUi = useSimplifiedUi();',
    },
    {
      find: '(item) => item.to !== "/settings/projects" || isSettingsOverviewVisible(scopeSearch),',
      replace:
        '(item) =>\n      (item.to !== "/settings/projects" || isSettingsOverviewVisible(scopeSearch)) &&\n      !(simplifiedUi && item.to === "/settings/source-control"),',
    },
  ],
  "apps/web/src/components/Sidebar.tsx": [
    // Non-technical default: the New thread button starts without a project
    // (the scratch/"start without a project" path) instead of dropping new
    // chats into whatever project was last used (e.g. Imported Conversations).
    {
      find: '  usePrimaryEnvironmentId,\n} from "../state/environments";',
      replace:
        '  usePrimaryEnvironmentId,\n} from "../state/environments";\nimport { useScratchProject } from "../hooks/useScratchProject";\nimport { readSimplifiedUi, useSimplifiedUi } from "~adelisone/simplifiedUi";',
    },
    {
      // Hide the "No project" chip on loose chats in simplified mode (claude.ai
      // shows no project label on standalone chats). Real project names stay.
      // Also gate the favicon on projectDisplayName so that when the sidebar is
      // scoped to one project (the row label is nulled out), the favicon drops
      // with it — the project is already named once at the top of the list.
      find: '              {props.project ? (\n                <ProjectFavicon project={props.project} className="size-4 shrink-0" />\n              ) : null}\n              {props.projectDisplayName ? (',
      replace:
        '              {props.project && props.projectDisplayName && !(readSimplifiedUi() && props.projectDisplayName === "No project") ? (\n                <ProjectFavicon project={props.project} className="size-4 shrink-0" />\n              ) : null}\n              {props.projectDisplayName && !(readSimplifiedUi() && props.projectDisplayName === "No project") ? (',
    },
    {
      find: "  const handleNewThreadClick = useCallback(\n    (event?: ReactMouseEvent) => {",
      replace:
        "  const a1Scratch = useScratchProject();\n  const a1Simplified = useSimplifiedUi();\n  const a1PrimaryEnv = usePrimaryEnvironmentId();\n  const handleNewThreadClick = useCallback(\n    (event?: ReactMouseEvent) => {\n      if (a1Simplified) {\n        const a1Env = a1Scratch.scratchEnvironmentId(\n          newThreadContext.defaultProjectRef?.environmentId ?? a1PrimaryEnv,\n        );\n        if (a1Env) {\n          if (isMobile) setOpenMobile(false);\n          void a1Scratch.startScratchThread(a1Env);\n          return;\n        }\n      }",
    },
    {
      find: "    [isMobile, newThreadContext, projectGroups.length, setOpenMobile],",
      replace:
        "    [isMobile, newThreadContext, projectGroups.length, setOpenMobile, a1Scratch, a1Simplified, a1PrimaryEnv],",
    },
    {
      // Compact chat list: in simplified mode every chat is a slim single-line
      // row (title + time), like Claude/ChatGPT. Only a live "working" thread
      // stays a full card so its streaming status stays visible. Upstream T3
      // keeps full cards for active/pinned.
      find: '                        const isCard =\n                          section === "active" || section === "pinned" || section === "working";',
      replace:
        '                        const isCard = readSimplifiedUi()\n                          ? section === "working"\n                          : section === "active" || section === "pinned" || section === "working";',
    },
    {
      // Slim row favicon: drop it when the row has no project label (i.e. the
      // list is scoped to one project), matching the card row's behavior.
      find: '              {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}',
      replace:
        '              {props.project && props.projectDisplayName ? <ProjectFavicon project={props.project} className="size-4" /> : null}',
    },
  ],
  "apps/web/src/components/NoProjectsHero.tsx": [
    // With no projects, auto-start a project-less (scratch) chat so the user
    // lands on a typeable composer — no "Start without a project" click needed.
    {
      find: 'import { useCallback } from "react";',
      replace: 'import { useCallback, useEffect, useRef } from "react";',
    },
    {
      find: 'import { useScratchProject } from "../hooks/useScratchProject";',
      replace:
        'import { useScratchProject } from "../hooks/useScratchProject";\nimport { useSimplifiedUi } from "~adelisone/simplifiedUi";',
    },
    {
      find: "  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);",
      replace:
        "  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);\n  const a1Simplified = useSimplifiedUi();\n  const a1StartedRef = useRef(false);\n  useEffect(() => {\n    if (a1Simplified && scratchTargetEnvironmentId && !a1StartedRef.current) {\n      a1StartedRef.current = true;\n      void startScratchThread(scratchTargetEnvironmentId);\n    }\n  }, [a1Simplified, scratchTargetEnvironmentId, startScratchThread]);",
    },
  ],
  "apps/server/src/project/ManagedProjectFolders.ts": [
    {
      // Always offer project-less (scratch) chats, and put the folder OUTSIDE
      // the data dir. The agent-session importer excludes anything under the
      // data dir, so a scratch folder there can't receive imported chats; a
      // sibling (~/AdelisOne Chats) is importable and still shows as loose.
      find: '      Effect.map((isRepository) =>\n        isRepository ? Option.none<string>() : Option.some(path.resolve(config.baseDir, "scratch")),\n      ),',
      replace:
        '      Effect.map(() => Option.some(path.resolve(config.baseDir, "..", "AdelisOne Chats"))),',
    },
  ],
  "apps/web/src/components/sidebar/SidebarChrome.tsx": [
    // Sidebar brand reads "[mark] Code" (was "T3 Code"); make it say AdelisOne.
    {
      find: "      >\n        Code\n      </span>",
      replace: "      >\n        AdelisOne\n      </span>",
    },
    {
      find: 'import { usePullRequestsSupported } from "../../state/environments";',
      replace:
        'import { usePullRequestsSupported } from "../../state/environments";\nimport { useSimplifiedUi } from "~adelisone/simplifiedUi";',
    },
    {
      find: "  const pullRequestsSupported = usePullRequestsSupported();",
      replace:
        "  const pullRequestsSupported = usePullRequestsSupported();\n  const simplifiedUi = useSimplifiedUi();",
    },
    {
      find: "          {pullRequestsSupported ? (",
      replace: "          {pullRequestsSupported && !simplifiedUi ? (",
    },
  ],
  "apps/web/src/components/settings/ProjectDefaultsSettings.tsx": [
    {
      find: 'import { createModelSelection } from "@t3tools/shared/model";',
      replace:
        'import { createModelSelection } from "@t3tools/shared/model";\nimport { useSimplifiedUi } from "~adelisone/simplifiedUi";',
    },
    {
      find: 'const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);',
      replace:
        'const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);\n  const simplifiedUi = useSimplifiedUi();',
    },
    {
      find: '{workspaceRow}\n          <SettingsRow\n            serverScoped\n            settingKeys={["worktreeSubmodules"]}',
      replace:
        '{workspaceRow}\n          {simplifiedUi ? null : (\n          <SettingsRow\n            serverScoped\n            settingKeys={["worktreeSubmodules"]}',
    },
    {
      find: '          />\n        </>\n      ) : category === "source-control" ? (',
      replace:
        '          />\n          )}\n        </>\n      ) : category === "source-control" ? (',
    },
  ],
  "apps/web/src/components/settings/SettingsPanels.tsx": [
    {
      find: 'import { Switch } from "../ui/switch";',
      replace:
        'import { Switch } from "../ui/switch";\nimport { setSimplifiedUi, useSimplifiedUi } from "~adelisone/simplifiedUi";\nimport { ImportChatsButton } from "~adelisone/web/ImportChatsDialog";\nimport { A1AccountCard } from "~adelisone/web/A1AccountCard";',
    },
    // Update track rows removed (both the desktop and hosted variants).
    { find: "{hasDesktopBridge ? (", replace: "{false && hasDesktopBridge ? (" },
    {
      find: ") : selectedHostedAppChannel ? (",
      replace: ") : false && selectedHostedAppChannel ? (",
    },
    {
      find: "{showNightlyMobileBeta ? <NightlyMobileBetaRow /> : null}",
      replace:
        '<SettingsRow\n        title="AdelisOne account"\n        description="Connects this computer to your company\u2019s AdelisOne server, which holds the data, memory, and approvals every conversation uses."\n      >\n        <A1AccountCard compact />\n      </SettingsRow>\n      <SettingsRow\n        title="Simplified interface"\n        description="Hides developer surfaces such as branches and source control. The undo system keeps running either way."\n        control={\n          <Switch\n            aria-label="Simplified interface"\n            checked={useSimplifiedUi()}\n            onCheckedChange={setSimplifiedUi}\n          />\n        }\n      />\n      <SettingsRow\n        title="Import conversations"\n        description="Bring in past chats from a claude.ai or ChatGPT data export."\n        control={<ImportChatsButton />}\n      />\n      {showNightlyMobileBeta ? <NightlyMobileBetaRow /> : null}',
    },
  ],
};

/**
 * T3 Code's name in the app's text. Every "T3 Code" in T3's source becomes
 * "AdelisOne", including text T3 adds later, so new T3 screens are covered
 * without a new override. Runs after REPLACEMENTS. Test files are left alone.
 */
export const RENAME = {
  find: "T3 Code",
  replace: "AdelisOne",
  /**
   * Text that keeps T3's name, by file. Codex sends this client name with its
   * requests to OpenAI, so it stays the value T3 Code sends.
   * @type {Record<string, ReadonlyArray<string>>}
   */
  keep: {
    "apps/server/src/provider/Layers/CodexProvider.ts": ['name: "T3 Code",', 'title: "T3 Code",'],
  },
};

/**
 * Whether a file gets the T3 Code → AdelisOne rename.
 *
 * @param {string} file Repo-relative path with forward slashes.
 */
export function isRenamed(file) {
  return (
    /^(apps|packages|scripts)\//u.test(file) &&
    /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file) &&
    !/(^|\/)(node_modules|dist|dist-electron)\//u.test(file) &&
    !/\.(test|browser)\.[a-z]+$/u.test(file)
  );
}

/**
 * @param {string} file Repo-relative path with forward slashes.
 * @param {string} source
 * @returns {string}
 */
function rename(file, source) {
  if (!isRenamed(file) || !source.includes(RENAME.find)) return source;
  const keep = RENAME.keep[file] ?? [];
  let output = source;
  keep.forEach((text, index) => {
    output = output.split(text).join(`\u0000adelisone-keep-${index}\u0000`);
  });
  output = output.split(RENAME.find).join(RENAME.replace);
  keep.forEach((text, index) => {
    output = output.split(`\u0000adelisone-keep-${index}\u0000`).join(text);
  });
  return output;
}

/**
 * Applies every AdelisOne change to one T3 file: its REPLACEMENTS, then the
 * rename. Returns the source unchanged when nothing applies.
 *
 * @param {string} file Repo-relative path with forward slashes.
 * @param {string} source
 * @returns {string}
 */
export function applyOverrides(file, source) {
  return rename(file, applyReplacements(file, source));
}

/**
 * Whether applyOverrides can change a file, checked before reading it.
 *
 * @param {string} file Repo-relative path with forward slashes.
 */
export function hasOverrides(file) {
  return Boolean(REPLACEMENTS[file]) || isRenamed(file);
}

/**
 * True when `source` already carries every override for `file`. Bundlers can
 * hand the same file over twice (for example, a route split into chunks), and
 * the second pass must not count as a mismatch.
 *
 * @param {string} file Repo-relative path with forward slashes.
 * @param {string} source
 * @returns {boolean}
 */
export function isAlreadyApplied(file, source) {
  const entries = REPLACEMENTS[file];
  if (!entries) return false;
  return entries.every(({ find, replace }) => !source.includes(find) && source.includes(replace));
}

/**
 * Applies the overrides for one T3 file. Throws when a `find` no longer
 * matches T3's source the expected number of times.
 *
 * @param {string} file Repo-relative path with forward slashes.
 * @param {string} source
 * @returns {string}
 */
export function applyReplacements(file, source) {
  const entries = REPLACEMENTS[file];
  if (!entries) return source;
  let output = source;
  for (const { find, replace, count = 1 } of entries) {
    const found = output.split(find).length - 1;
    if (found !== count) {
      throw new Error(
        `AdelisOne override no longer matches T3 Code in ${file}: expected ${count} match(es), found ${found}.\n` +
          `Looking for:\n${find}\n` +
          "Update adelisone/overrides.mjs to match T3's new code.",
      );
    }
    output = output.split(find).join(replace);
  }
  return output;
}
