/**
 * AdelisOne: POST /api/a1/import-chats — accepts a claude.ai or ChatGPT data
 * export (conversations.json, or the export zip on hosts with `unzip`) and
 * writes Claude Code session files the app's session importer can scan.
 * Query: ?project=<absolute dir> (default: ~/AdelisOne Imported Chats).
 * Wired into the route table by an overrides.mjs patch on apps/server/src/server.ts.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../../apps/server/src/auth/EnvironmentAuth.ts";
// @ts-expect-error plain-JS module shared with the import converter
import { convertExport, mungeProjectDir } from "../shared/chatExportConvert.mjs";
// @ts-expect-error plain-JS module shared with the import converter
import { readExportEntries, readExportEntriesFromBuffer } from "../shared/readExportJson.mjs";

const resolveClaudeConfigDir = (): string => {
  const fromEnvironment = process.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (fromEnvironment.length > 0) return NodePath.resolve(fromEnvironment);
  return NodePath.join(NodeOS.homedir(), ".claude");
};

type LibraryItem = { id: string; title: string; date: string; content: string; group?: string };
type Library = { memory: LibraryItem[]; artifacts: LibraryItem[]; docs: LibraryItem[] };

const defaultBaseDir = (): string => NodePath.join(NodeOS.homedir(), "AdelisOne Imported");
const libraryPath = (baseDir: string): string => NodePath.join(baseDir, ".a1-library.json");

// Imported Claude projects become real A1 projects, each rooted at its own
// folder here; the client turns these folders into project records.
const importedProjectsBaseDir = (): string =>
  NodePath.join(NodeOS.homedir(), "AdelisOne Imported Projects");

/** A Claude project name reduced to one safe folder segment. */
const safeFolderSegment = (name: string): string =>
  name
    .replace(/[/\\]/g, "-")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .trim() || "Imported";

/** A doc filename reduced to a safe relative path (no traversal, keeps subfolders). */
const safeDocRelPath = (filename: string): string => {
  const parts = filename
    .split(/[/\\]/)
    .map((part) =>
      part
        .replace(/[<>:"|?*\u0000-\u001f]/g, "")
        .replace(/^\.+$/, "")
        .trim(),
    )
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  const rel = parts.join(NodePath.sep);
  return rel.length > 0 ? rel : "document.md";
};

/**
 * Write each imported Claude project's docs into its own folder on disk,
 * grouped by project name (ungrouped docs land in a catch-all "Imported"
 * project). Returns a descriptor per project for the client to create.
 */
const writeImportedProjects = (
  docs: LibraryItem[],
): Array<{ title: string; workspaceRoot: string; files: number }> => {
  const byGroup = new Map<string, LibraryItem[]>();
  for (const doc of docs) {
    const group = (doc.group ?? "").trim() || "Imported";
    const list = byGroup.get(group) ?? [];
    list.push(doc);
    byGroup.set(group, list);
  }
  const base = importedProjectsBaseDir();
  const projects: Array<{ title: string; workspaceRoot: string; files: number }> = [];
  for (const [group, list] of byGroup) {
    const projectRoot = NodePath.join(base, safeFolderSegment(group));
    NodeFS.mkdirSync(projectRoot, { recursive: true });
    const used = new Set<string>();
    let files = 0;
    for (const doc of list) {
      let rel = safeDocRelPath(doc.title);
      if (used.has(rel)) {
        // Two docs that sanitize to the same name: keep both.
        const ext = NodePath.extname(rel);
        rel = `${rel.slice(0, rel.length - ext.length)}-${doc.id.slice(-6)}${ext}`;
      }
      used.add(rel);
      const filePath = NodePath.join(projectRoot, rel);
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, doc.content);
      files += 1;
    }
    projects.push({ title: group, workspaceRoot: projectRoot, files });
  }
  return projects;
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  bmp: "image/bmp",
};

/**
 * Reads image bytes for a ChatGPT asset_pointer off the export folder so the
 * converter can inline them (folder-path import only — the .dat assets aren't
 * part of an upload). The asset id maps to `<folder>/<id>.dat`; the real
 * extension comes from conversation_asset_file_names.json.
 */
const makeAssetResolver = (folderPath: string) => {
  let names: Record<string, string> = {};
  try {
    const raw = NodeFS.readFileSync(
      NodePath.join(folderPath, "conversation_asset_file_names.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") names = parsed as Record<string, string>;
  } catch {
    names = {};
  }
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  return (assetId: string): { mimeType: string; data: string; name: string } | null => {
    const datName = `${assetId}.dat`;
    const filePath = NodePath.join(folderPath, datName);
    if (!NodeFS.existsSync(filePath)) return null;
    const displayName = typeof names[datName] === "string" ? names[datName] : "image";
    const ext = NodePath.extname(displayName).replace(/^\./, "").toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT[ext];
    if (!mimeType) return null;
    let bytes: Buffer;
    try {
      bytes = NodeFS.readFileSync(filePath);
    } catch {
      return null;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
    return { mimeType, data: bytes.toString("base64"), name: displayName };
  };
};

const readLibrary = (baseDir: string): Library => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(libraryPath(baseDir), "utf8"));
    return {
      memory: Array.isArray(parsed.memory) ? parsed.memory : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      docs: Array.isArray(parsed.docs) ? parsed.docs : [],
    };
  } catch {
    return { memory: [], artifacts: [], docs: [] };
  }
};

/** Merge newly converted items into the stored library, deduping by id per bucket. */
const mergeLibrary = (baseDir: string, incoming: Library): void => {
  const current = readLibrary(baseDir);
  for (const bucket of ["memory", "artifacts", "docs"] as const) {
    const seen = new Set(current[bucket].map((item) => item.id));
    for (const item of incoming[bucket]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        current[bucket].push(item);
      }
    }
  }
  NodeFS.mkdirSync(baseDir, { recursive: true });
  NodeFS.writeFileSync(libraryPath(baseDir), JSON.stringify(current));
};

const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const authed = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
    return Option.isSome(session);
  });

/** GET /api/a1/library — returns the imported memory / artifacts / docs for the Library views. */
export const a1LibraryRouteLayer = HttpRouter.add(
  "GET",
  "/api/a1/library",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    try {
      return json(200, readLibrary(defaultBaseDir()) as unknown as Record<string, unknown>);
    } catch {
      return json(200, { memory: [], artifacts: [], docs: [] });
    }
  }),
);

/** POST /api/a1/library/update — edit one Library item's content. Body: { bucket, id, content }. */
export const a1LibraryUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/a1/library/update",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    const chunks = yield* Stream.runCollect(request.stream).pipe(Effect.option);
    if (Option.isNone(chunks)) return json(400, { error: "Could not read the request." });
    const raw = Buffer.concat(Array.from(chunks.value, (c) => Buffer.from(c))).toString("utf8");
    try {
      const { bucket, id, content } = JSON.parse(raw) as {
        bucket: "memory" | "artifacts" | "docs";
        id: string;
        content: string;
      };
      if (!["memory", "artifacts", "docs"].includes(bucket) || typeof id !== "string") {
        return json(400, { error: "Invalid request." });
      }
      const baseDir = defaultBaseDir();
      const library = readLibrary(baseDir);
      const item = library[bucket].find((entry) => entry.id === id);
      if (!item) return json(404, { error: "Item not found." });
      item.content = typeof content === "string" ? content : item.content;
      NodeFS.mkdirSync(baseDir, { recursive: true });
      NodeFS.writeFileSync(libraryPath(baseDir), JSON.stringify(library));
      return json(200, { ok: true });
    } catch (error) {
      return json(400, { error: "Could not save.", detail: String(error) });
    }
  }),
);

/**
 * POST /api/a1/relocate-session — moves an imported chat's transcript from one
 * project folder's Claude Code session store to another, so the chat stays
 * resumable after its thread is moved between projects (an imported session is
 * keyed to its folder). Body: { sessionId, fromWorkspaceRoot, toWorkspaceRoot }.
 */
export const a1RelocateSessionRouteLayer = HttpRouter.add(
  "POST",
  "/api/a1/relocate-session",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* authed(request))) return json(401, { error: "Not authenticated." });
    const chunks = yield* Stream.runCollect(request.stream).pipe(Effect.option);
    if (Option.isNone(chunks)) return json(400, { error: "Could not read the request." });
    const raw = Buffer.concat(Array.from(chunks.value, (c) => Buffer.from(c))).toString("utf8");
    try {
      const { sessionId, fromWorkspaceRoot, toWorkspaceRoot } = JSON.parse(raw) as {
        sessionId: string;
        fromWorkspaceRoot: string;
        toWorkspaceRoot: string;
      };
      if (!sessionId || !fromWorkspaceRoot || !toWorkspaceRoot) {
        return json(400, { error: "Invalid request." });
      }
      if (fromWorkspaceRoot === toWorkspaceRoot) return json(200, { ok: true, moved: false });
      const claudeConfig = resolveClaudeConfigDir();
      const fromPath = NodePath.join(
        claudeConfig,
        "projects",
        mungeProjectDir(fromWorkspaceRoot) as string,
        `${sessionId}.jsonl`,
      );
      // Not an imported/folder-bound session (or already moved): nothing to do.
      if (!NodeFS.existsSync(fromPath)) return json(200, { ok: true, moved: false });
      const toDir = NodePath.join(
        claudeConfig,
        "projects",
        mungeProjectDir(toWorkspaceRoot) as string,
      );
      NodeFS.mkdirSync(toDir, { recursive: true });
      const toPath = NodePath.join(toDir, `${sessionId}.jsonl`);
      // Rewrite each record's cwd so the resumed session matches its new folder.
      const rewritten = NodeFS.readFileSync(fromPath, "utf8")
        .split("\n")
        .map((line) => {
          if (!line.trim()) return line;
          try {
            const record = JSON.parse(line);
            if (record && typeof record === "object" && "cwd" in record) {
              record.cwd = toWorkspaceRoot;
            }
            return JSON.stringify(record);
          } catch {
            return line;
          }
        })
        .join("\n");
      const stat = NodeFS.statSync(fromPath);
      NodeFS.writeFileSync(toPath, rewritten);
      NodeFS.utimesSync(toPath, stat.atime, stat.mtime);
      NodeFS.rmSync(fromPath, { force: true });
      return json(200, { ok: true, moved: true });
    } catch (error) {
      return json(400, { error: "Could not relocate the session.", detail: String(error) });
    }
  }),
);

export const a1ImportChatsRouteLayer = HttpRouter.add(
  "POST",
  "/api/a1/import-chats",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const authenticated = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(authenticated)) {
      return json(401, { error: "Not authenticated." });
    }

    const url = HttpServerRequest.toURL(request);
    const requestedBase = Option.isSome(url) ? (url.value.searchParams.get("base") ?? "") : "";
    const baseDir =
      requestedBase.trim().length > 0 && NodePath.isAbsolute(requestedBase.trim())
        ? NodePath.resolve(requestedBase.trim())
        : NodePath.join(NodeOS.homedir(), "AdelisOne Imported");
    // Conversations are bucketed by source provider so Claude and ChatGPT chats
    // stay distinguishable; each bucket becomes its own project, and a chat
    // graduates to a normal loose chat once it's continued in AdelisOne.
    const chatsBase = NodePath.join(NodeOS.homedir(), "AdelisOne Imported Chats");
    const convDirs = {
      claude: NodePath.join(chatsBase, "Claude"),
      chatgpt: NodePath.join(chatsBase, "ChatGPT"),
    };
    const providerLabel: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT" };

    // Folder-path import (?path=): read the export straight off disk so large
    // exports (ChatGPT's multi-hundred-MB zip/folder) never ride an HTTP body.
    const requestedPath = Option.isSome(url) ? (url.value.searchParams.get("path") ?? "") : "";
    const folderPath =
      requestedPath.trim().length > 0 && NodePath.isAbsolute(requestedPath.trim())
        ? NodePath.resolve(requestedPath.trim())
        : null;

    let body = Buffer.alloc(0);
    if (!folderPath) {
      const chunks = yield* Stream.runCollect(request.stream).pipe(Effect.option);
      if (Option.isNone(chunks)) return json(400, { error: "Could not read the upload." });
      body = Buffer.concat(Array.from(chunks.value, (chunk) => Buffer.from(chunk)));
      if (body.byteLength === 0) return json(400, { error: "The upload was empty." });
    } else if (!NodeFS.existsSync(folderPath)) {
      return json(400, { error: `That path does not exist on this machine: ${folderPath}` });
    }

    // The conversion is synchronous; a plain try/catch keeps the handler's
    // error channel clean and returns a Response either way.
    try {
      let result: {
        conversationFiles: Array<{
          name: string;
          content: string;
          updatedAt: string;
          convDir: string;
          provider: "claude" | "chatgpt";
        }>;
        library: { memory: LibraryItem[]; artifacts: LibraryItem[]; docs: LibraryItem[] };
        skipped: number;
        skippedDetails: Array<{ title: string; reason: string }>;
        manifest: boolean;
      };
      if (folderPath) {
        const entries = readExportEntries(folderPath) as Array<{ path: string; content: string }>;
        result = convertExport(
          entries,
          baseDir,
          new Date().toISOString(),
          convDirs,
          makeAssetResolver(folderPath),
        );
      } else {
        const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "a1-import-"));
        try {
          const entries = readExportEntriesFromBuffer(body, scratch) as Array<{
            path: string;
            content: string;
          }>;
          result = convertExport(entries, baseDir, new Date().toISOString(), convDirs);
        } finally {
          NodeFS.rmSync(scratch, { recursive: true, force: true });
        }
      }

      const hasAny =
        result.conversationFiles.length > 0 ||
        result.library.memory.length +
          result.library.artifacts.length +
          result.library.docs.length >
          0;
      if (result.manifest && !hasAny) {
        return json(422, {
          error:
            "That's the export manifest (the list of download links), not the data. Download the files it lists — the conversations zip especially — and upload those.",
        });
      }

      // Conversations → session files, one bucket folder per provider; each
      // becomes a project the client creates below.
      const claudeConfig = resolveClaudeConfigDir();
      const bucketByRoot = new Map<
        string,
        { provider: string; workspaceRoot: string; count: number }
      >();
      const sessionsDirByRoot = new Map<string, string>();
      for (const file of result.conversationFiles) {
        const workspaceRoot = file.convDir;
        let sessionsDir = sessionsDirByRoot.get(workspaceRoot);
        if (sessionsDir === undefined) {
          NodeFS.mkdirSync(workspaceRoot, { recursive: true });
          sessionsDir = NodePath.join(
            claudeConfig,
            "projects",
            mungeProjectDir(workspaceRoot) as string,
          );
          NodeFS.mkdirSync(sessionsDir, { recursive: true });
          sessionsDirByRoot.set(workspaceRoot, sessionsDir);
        }
        const filePath = NodePath.join(sessionsDir, file.name);
        NodeFS.writeFileSync(filePath, file.content);
        // Stamp the file with the real date so the thread shows it. The
        // importer's 30-day recency filter is removed by an override
        // (adelisone/overrides.mjs → AgentSessionScanner).
        const updated = new Date(file.updatedAt);
        if (!Number.isNaN(updated.getTime())) NodeFS.utimesSync(filePath, updated, updated);
        const bucket = bucketByRoot.get(workspaceRoot) ?? {
          provider: providerLabel[file.provider] ?? "Imported",
          workspaceRoot,
          count: 0,
        };
        bucket.count += 1;
        bucketByRoot.set(workspaceRoot, bucket);
      }
      const conversationBuckets = Array.from(bucketByRoot.values());

      // Project docs → real A1 project folders on disk (the client creates the
      // project records). Memory / artifacts → the Library store (merged across
      // uploads); docs are no longer kept there.
      const importedProjects = writeImportedProjects(result.library.docs);
      mergeLibrary(baseDir, {
        memory: result.library.memory,
        artifacts: result.library.artifacts,
        docs: [],
      });

      return json(200, {
        written: result.conversationFiles.length,
        conversationBuckets,
        library: {
          memory: result.library.memory.length,
          artifacts: result.library.artifacts.length,
        },
        importedProjects,
        skipped: result.skipped,
        skippedDetails: result.skippedDetails,
      });
    } catch (error) {
      return json(422, {
        error:
          "Could not convert that file. Upload an export zip (or conversations.json) from a claude.ai or ChatGPT data export.",
        detail: String(error),
      });
    }
  }),
);
