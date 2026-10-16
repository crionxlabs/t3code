// @ts-check
/**
 * Loads AdelisOne into T3 Code's builds. T3's Vite configs (web, desktop,
 * server) each add `adelisone(...)` to their plugins; that is the only change
 * T3's files need. Everything AdelisOne changes is listed in overrides.mjs.
 *
 * Importing this module also:
 * - turns on bundled dev for the desktop app's dev server (Electron's renderer
 *   proxy fails under unbundled dev), unless T3CODE_BUNDLED_DEV is already set;
 * - registers node/loader.mjs for T3's Node scripts started from these builds
 *   (the dev launcher, the server build), so they get the same overrides.
 *
 * T3's own tests run against T3's unchanged source, so under Vitest this
 * module does nothing.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DEV_WEB_ICONS,
  FILE_SWAPS,
  applyOverrides,
  applyReplacements,
  hasOverrides,
  isAlreadyApplied,
} from "./overrides.mjs";

const underTest = Boolean(process.env.VITEST);

/** Finds the repo root by walking up from the working directory. */
function findRepoRoot() {
  let directory = process.cwd();
  for (;;) {
    if (NodeFS.existsSync(NodePath.join(directory, "adelisone", "overrides.mjs"))) {
      return directory;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) {
      throw new Error("AdelisOne: could not find the repository root (adelisone/overrides.mjs).");
    }
    directory = parent;
  }
}

const repoRoot = findRepoRoot();

if (!underTest) {
  // Desktop dev serves the renderer from 127.0.0.1; browser dev uses localhost.
  const desktopDev = process.env.VITE_DEV_SERVER_URL?.startsWith("http://127.0.0.1") ?? false;
  if (desktopDev && process.env.T3CODE_BUNDLED_DEV === undefined) {
    process.env.T3CODE_BUNDLED_DEV = "1";
  }

  const loaderUrl = NodeURL.pathToFileURL(
    NodePath.join(repoRoot, "adelisone", "node", "register.mjs"),
  ).href;
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (!nodeOptions.includes(loaderUrl)) {
    process.env.NODE_OPTIONS = `${nodeOptions} --import=${loaderUrl}`.trim();
  }
}

/** @param {string} id */
function toRepoRelative(id) {
  const clean = id.replace(/^\0/, "").split("?")[0] ?? "";
  if (!NodePath.isAbsolute(clean)) return undefined;
  // Workspace packages can arrive through node_modules links; use the real path.
  let real;
  try {
    real = NodeFS.realpathSync(clean);
  } catch {
    return undefined;
  }
  const relative = NodePath.relative(repoRoot, real).split(NodePath.sep).join("/");
  return relative.startsWith("..") ? undefined : relative;
}

/** A package import such as "effect/Effect", as opposed to a path or a Node builtin. */
/** @param {string} source */
function isBarePackageImport(source) {
  return (
    !/^(?:[./\\]|\0|~|node:|data:|virtual:|vite\/)/u.test(source) && !NodePath.isAbsolute(source)
  );
}

/** @param {string} id */
function isAdelisoneFile(id) {
  return toRepoRelative(id)?.startsWith("adelisone/") ?? false;
}

/** The file package imports from adelisone/ resolve against. */
/** @param {"web" | "desktop" | "server"} target */
function appPackageJson(target) {
  return NodePath.join(repoRoot, "apps", target, "package.json");
}

/**
 * @param {"web" | "desktop" | "server"} target
 * @returns {any} A Vite plugin; also a valid Rolldown plugin for `vp pack`.
 */
export function adelisone(target) {
  if (underTest) return { name: "adelisone" };

  /** @type {Record<string, string>} */
  const swaps = FILE_SWAPS;

  return {
    name: "adelisone",
    enforce: "pre",

    // Lets override patches import AdelisOne modules ("~adelisone/x" resolves
    // under adelisone/, with adelisone/web/ as a fallback for bare names),
    // keeping A1 code in its own folder.
    /**
     * @param {string} source
     * @param {string | undefined} importer
     */
    resolveId(source, importer) {
      if (source.startsWith("~adelisone/")) {
        const rest = source.slice("~adelisone/".length);
        for (const base of [
          NodePath.join(repoRoot, "adelisone", rest),
          NodePath.join(repoRoot, "adelisone", "web", rest),
        ]) {
          for (const file of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`]) {
            if (NodeFS.existsSync(file) && NodeFS.statSync(file).isFile()) return file;
          }
        }
        return null;
      }
      // adelisone/ sits outside the app packages, so a bare package import
      // (effect, react) from one of its files would be looked up from the repo
      // root, which pnpm leaves empty. Resolve it from the app being built.
      if (importer && isBarePackageImport(source) && isAdelisoneFile(importer)) {
        return this.resolve(source, appPackageJson(target), { skipSelf: true });
      }
      return null;
    },

    // Overrides apply as T3's files are read, before any other plugin (such as
    // the React compiler) reshapes the code. TanStack Router loads parts of a
    // route file again under ?tsr-split and ?tsr-shared; those get the same
    // overrides. Other queries (?raw, ?url, ?worker) pass through.
    /** @param {string} id */
    load(id) {
      const query = id.split("?")[1];
      if (query !== undefined && !/(^|&)tsr-(split|shared)(=|&|$)/u.test(query)) return null;
      const file = toRepoRelative(id);
      if (!file) return null;
      const swap = swaps[file];
      if (swap) return NodeFS.readFileSync(NodePath.join(repoRoot, swap), "utf8");
      if (!hasOverrides(file)) return null;
      const source = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");
      const output = applyOverrides(file, source);
      return output === source ? null : output;
    },

    /** @param {string} html */
    transformIndexHtml(html) {
      const file = "apps/web/index.html";
      if (target !== "web" || isAlreadyApplied(file, html)) return html;
      return applyReplacements(file, html);
    },

    /** @param {{ middlewares: { use: (handler: (req: any, res: any, next: () => void) => void) => void } }} server */
    configureServer(server) {
      if (target !== "web") return;
      /** @type {Record<string, string>} */
      const icons = DEV_WEB_ICONS;
      server.middlewares.use((req, res, next) => {
        const icon = icons[(req.url ?? "").split("?")[0] ?? ""];
        if (!icon) return next();
        res.setHeader("Cache-Control", "no-cache");
        res.end(NodeFS.readFileSync(NodePath.join(repoRoot, "adelisone", icon)));
      });
    },

    /** @param {{ dir?: string }} options */
    writeBundle(options) {
      if (target !== "web" || !options.dir) return;
      for (const [url, icon] of Object.entries(DEV_WEB_ICONS)) {
        const destination = NodePath.join(options.dir, url.slice(1));
        if (NodeFS.existsSync(destination)) {
          NodeFS.copyFileSync(NodePath.join(repoRoot, "adelisone", icon), destination);
        }
      }
    },
  };
}
