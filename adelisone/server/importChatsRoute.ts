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
import { readExportEntriesFromBuffer } from "../shared/readExportJson.mjs";

const resolveClaudeConfigDir = (): string => {
  const fromEnvironment = process.env.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (fromEnvironment.length > 0) return NodePath.resolve(fromEnvironment);
  return NodePath.join(NodeOS.homedir(), ".claude");
};

type LibraryItem = { id: string; title: string; date: string; content: string; group?: string };
type Library = { memory: LibraryItem[]; artifacts: LibraryItem[]; docs: LibraryItem[] };

const defaultBaseDir = (): string => NodePath.join(NodeOS.homedir(), "AdelisOne Imported");
const libraryPath = (baseDir: string): string => NodePath.join(baseDir, ".a1-library.json");

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
    // The client passes the no-project (scratch) folder so imported chats land
    // there and show as loose conversations, not under a named project.
    const requestedConvDir = Option.isSome(url)
      ? (url.value.searchParams.get("convDir") ?? "")
      : "";
    const convDirOverride =
      requestedConvDir.trim().length > 0 && NodePath.isAbsolute(requestedConvDir.trim())
        ? NodePath.resolve(requestedConvDir.trim())
        : null;

    const chunks = yield* Stream.runCollect(request.stream).pipe(Effect.option);
    if (Option.isNone(chunks)) return json(400, { error: "Could not read the upload." });
    const body = Buffer.concat(Array.from(chunks.value, (chunk) => Buffer.from(chunk)));
    if (body.byteLength === 0) return json(400, { error: "The upload was empty." });

    // The conversion is synchronous; a plain try/catch keeps the handler's
    // error channel clean and returns a Response either way.
    try {
      const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "a1-import-"));
      let result: {
        conversationProjectDir: string;
        conversationFiles: Array<{ name: string; content: string; updatedAt: string }>;
        library: { memory: LibraryItem[]; artifacts: LibraryItem[]; docs: LibraryItem[] };
        skipped: number;
        skippedDetails: Array<{ title: string; reason: string }>;
        manifest: boolean;
      };
      try {
        const entries = readExportEntriesFromBuffer(body, scratch) as Array<{
          path: string;
          content: string;
        }>;
        result = convertExport(entries, baseDir, new Date().toISOString(), convDirOverride);
      } finally {
        NodeFS.rmSync(scratch, { recursive: true, force: true });
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

      // Conversations → session files in one project, imported as threads.
      const claudeDir = resolveClaudeConfigDir();
      NodeFS.mkdirSync(result.conversationProjectDir, { recursive: true });
      const sessionsDir = NodePath.join(
        claudeDir,
        "projects",
        mungeProjectDir(result.conversationProjectDir) as string,
      );
      NodeFS.mkdirSync(sessionsDir, { recursive: true });
      for (const file of result.conversationFiles) {
        const filePath = NodePath.join(sessionsDir, file.name);
        NodeFS.writeFileSync(filePath, file.content);
        // Stamp the file with the real date so the thread shows it. The
        // importer's 30-day recency filter is removed by an override
        // (adelisone/overrides.mjs → AgentSessionScanner).
        const updated = new Date(file.updatedAt);
        if (!Number.isNaN(updated.getTime())) NodeFS.utimesSync(filePath, updated, updated);
      }

      // Memory / artifacts / docs → the Library store (merged across uploads).
      mergeLibrary(baseDir, result.library);

      return json(200, {
        written: result.conversationFiles.length,
        conversationProjectDir: result.conversationProjectDir,
        library: {
          memory: result.library.memory.length,
          artifacts: result.library.artifacts.length,
          docs: result.library.docs.length,
        },
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
