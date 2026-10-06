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

  // ── Sidebar: the Settled section is labeled Projects ──────────────────
  "apps/web/src/components/Sidebar.tsx": [
    { find: '? "Settled"', replace: '? "Projects"' },
    {
      find: ": `Settled (${settledThreads.length})`",
      replace: ": `Projects (${settledThreads.length})`",
    },
    { find: 'label="Settled"', replace: 'label="Projects"' },
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
  "apps/web/src/components/onboarding/WelcomeWizard.tsx": [
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
