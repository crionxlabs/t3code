// @ts-check
/**
 * Converts a claude.ai or ChatGPT data export into Claude Code session JSONL
 * files that AdelisOne's session importer can scan. Everything in the export is
 * brought in as a viewable thread: conversations, project knowledge docs,
 * Claude memory (profile, per-project, memory files), and artifacts/pages.
 * Used by the upload route (adelisone/server/importChatsRoute.ts). Text only;
 * images and tool output in conversations are skipped.
 */

/** @param {unknown} value @returns {string} */
const text = (value) => (typeof value === "string" ? value : "");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The session importer only accepts Claude sessions whose id is a UUID (it
 * treats them as resumable Claude Code sessions). A UUID seed is reused; any
 * other seed is hashed into a stable UUID so re-imports map to the same thread.
 * @param {string} seed @returns {string}
 */
function toSessionUuid(seed) {
  if (UUID_RE.test(seed)) return seed.toLowerCase();
  let hex = "";
  for (let k = 0; hex.length < 32; k++) {
    let v = (0x811c9dc5 ^ (k * 0x01000193)) >>> 0;
    for (let i = 0; i < seed.length; i++) {
      v ^= seed.charCodeAt(i);
      v = Math.imul(v, 0x01000193) >>> 0;
    }
    hex += v.toString(16).padStart(8, "0");
  }
  hex = hex.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** @param {string | number | undefined | null} value @param {string} fallback */
function toIso(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

// ── conversation shapes ─────────────────────────────────────────────────────

/** @param {any} value @returns {"claude" | "chatgpt" | null} */
function conversationKind(value) {
  if (value && typeof value === "object") {
    if (Array.isArray(value.chat_messages)) return "claude";
    if (value.mapping && typeof value.mapping === "object") return "chatgpt";
  }
  return null;
}

/** @param {unknown} parsed @returns {Array<{ kind: "claude" | "chatgpt"; conversation: any }>} */
function collectConversations(parsed) {
  const found = [];
  const visit = (/** @type {any} */ value) => {
    const kind = conversationKind(value);
    if (kind) return void found.push({ kind, conversation: value });
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object" && Array.isArray(value.conversations))
      for (const item of value.conversations) visit(item);
  };
  visit(parsed);
  return found;
}

/** claude.ai conversation → thread. @param {any} conversation @param {string} fallbackDate */
function fromClaudeAi(conversation, fallbackDate) {
  const createdAt = toIso(conversation.created_at, fallbackDate);
  const messages = [];
  for (const message of conversation.chat_messages ?? []) {
    const role =
      message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    let body = text(message.text);
    if (!body && Array.isArray(message.content)) {
      body = message.content
        .map((/** @type {any} */ b) => (b?.type === "text" ? text(b.text) : ""))
        .filter(Boolean)
        .join("\n\n");
    }
    if (!body.trim()) continue;
    messages.push({ role, text: body, createdAt: toIso(message.created_at, createdAt) });
  }
  return {
    seed: text(conversation.uuid) || null,
    title: text(conversation.name) || "Imported claude.ai chat",
    createdAt,
    updatedAt: toIso(conversation.updated_at, createdAt),
    messages,
  };
}

/** ChatGPT conversation (mapping tree) → thread. @param {any} conversation @param {string} fallbackDate */
function fromChatGpt(conversation, fallbackDate) {
  const mapping = conversation.mapping ?? {};
  const chain = [];
  let nodeId = text(conversation.current_node) || null;
  if (!nodeId) {
    const roots = Object.values(mapping).filter((/** @type {any} */ n) => n.parent == null);
    let cursor = /** @type {any} */ (roots[0]);
    while (cursor) {
      chain.unshift(cursor.id);
      cursor = mapping[cursor.children?.at(-1) ?? ""];
    }
  } else {
    while (nodeId && mapping[nodeId]) {
      chain.unshift(nodeId);
      nodeId = mapping[nodeId].parent;
    }
  }
  const fallbackTime = toIso(conversation.create_time, fallbackDate);
  const messages = [];
  for (const id of chain) {
    const message = mapping[id]?.message;
    if (!message) continue;
    const role = message.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (message.metadata?.is_visually_hidden_from_conversation === true) continue;
    const content = message.content;
    let body = "";
    if (content?.content_type === "text" && Array.isArray(content.parts))
      body = content.parts.filter((/** @type {unknown} */ p) => typeof p === "string").join("\n\n");
    if (!body.trim()) continue;
    messages.push({ role, text: body, createdAt: toIso(message.create_time, fallbackTime) });
  }
  return {
    seed: text(conversation.conversation_id) || text(conversation.id) || null,
    title: text(conversation.title) || "Imported ChatGPT chat",
    createdAt: fallbackTime,
    updatedAt: toIso(conversation.update_time, fallbackTime),
    messages,
  };
}

// ── emit ────────────────────────────────────────────────────────────────────

/** @param {any} thread @param {string} projectDir @param {Set<string>} seen */
function emit(thread, projectDir, seen) {
  if (!thread || thread.messages.length === 0) return null;
  const sessionId = toSessionUuid(thread.seed || `${thread.title}-${thread.createdAt}`);
  if (seen.has(sessionId)) return null;
  seen.add(sessionId);
  const lines = thread.messages.map((/** @type {any} */ m, /** @type {number} */ i) =>
    JSON.stringify({
      type: m.role,
      sessionId,
      cwd: projectDir,
      ...(i === 0 ? { aiTitle: thread.title } : {}),
      timestamp: m.createdAt,
      message: { role: m.role, content: [{ type: "text", text: m.text }] },
    }),
  );
  return {
    name: `${sessionId}.jsonl`,
    content: lines.join("\n") + "\n",
    updatedAt: thread.updatedAt,
  };
}

/**
 * Convert a whole export. Conversations become Claude Code session files (one
 * "Imported Conversations" project, imported as threads). Memory, artifacts, and
 * project docs are NOT threads — they're returned as `library` items (reference
 * content) for the A1 Library views. Entries are `{ path, content }` for every
 * file in the dropped zip(s) or folder, so artifacts pair with their content file.
 * @param {ReadonlyArray<{ path: string; content: string }>} entries
 * @param {string} baseDir absolute folder the Library store lives under
 * @param {string} nowIso fallback date for content that carries none
 * @param {string | null} [convDir] absolute folder conversations attach to (the
 *   no-project scratch folder); defaults to baseDir/"Imported Conversations"
 * @returns {{
 *   conversationProjectDir: string;
 *   conversationFiles: Array<{ name: string; content: string; updatedAt: string }>;
 *   library: { memory: LibraryItem[]; artifacts: LibraryItem[]; docs: LibraryItem[] };
 *   skipped: number;
 *   skippedDetails: Array<{ title: string; reason: string }>;
 *   manifest: boolean;
 * }}
 * @typedef {{ id: string; title: string; date: string; content: string; group?: string }} LibraryItem
 */
export function convertExport(entries, baseDir, nowIso, convDir = null) {
  // Conversations only convert when a target folder (the no-project scratch
  // folder) is given, so they never land in a named "Imported" project.
  const conversationProjectDir = convDir;
  const conversationFiles = [];
  const convSeen = new Set();
  /** @type {{ memory: any[]; artifacts: any[]; docs: any[] }} */
  const library = { memory: [], artifacts: [], docs: [] };
  const libSeen = new Set();
  /** @type {Array<{ title: string; reason: string }>} */
  const skippedDetails = [];
  let manifest = false;

  const contentByPath = new Map(entries.map((e) => [e.path, e.content]));

  const addLib = (
    /** @type {"memory" | "artifacts" | "docs"} */ bucket,
    /** @type {string} */ id,
    /** @type {string} */ title,
    /** @type {string} */ date,
    /** @type {string} */ content,
    /** @type {string | undefined} */ group,
  ) => {
    if (!content || !content.trim()) {
      skippedDetails.push({ title, reason: `Empty ${bucket}` });
      return;
    }
    const key = `${bucket}:${id}`;
    if (libSeen.has(key)) return;
    libSeen.add(key);
    library[bucket].push({ id, title, date, content, ...(group ? { group } : {}) });
  };

  for (const entry of entries) {
    const path = entry.path;
    const lower = path.toLowerCase();
    if (!lower.endsWith(".json")) continue;

    let parsed;
    try {
      parsed = JSON.parse(entry.content);
    } catch {
      continue;
    }

    if (parsed && typeof parsed === "object" && Array.isArray(parsed.data_files)) {
      manifest = true;
      continue;
    }

    // Artifact → library (content from its sibling file).
    if (
      parsed &&
      parsed.kind &&
      Array.isArray(parsed.versions) &&
      lower.endsWith("artifact.json")
    ) {
      const dir = path.slice(0, path.lastIndexOf("/") + 1);
      const active =
        parsed.versions.find((/** @type {any} */ v) => v.id === parsed.active_version) ??
        parsed.versions.at(-1) ??
        {};
      let body =
        contentByPath.get(`${dir}page.md`) ??
        contentByPath.get(`${dir}versions/${active.id}.html`) ??
        "";
      if (!body) {
        for (const [p, c] of contentByPath) {
          if (p.startsWith(dir) && (p.endsWith(".md") || p.endsWith(".html"))) {
            body = c;
            break;
          }
        }
      }
      const title = text(active?.title) || `Artifact ${text(parsed.id).slice(0, 8)}`;
      addLib(
        "artifacts",
        `artifact-${text(parsed.id)}`,
        title,
        toIso(active?.created_at, nowIso),
        text(body),
      );
      continue;
    }

    // Project docs → library (grouped by project name).
    if (
      parsed &&
      Array.isArray(parsed.docs) &&
      parsed.name !== undefined &&
      !parsed.chat_messages
    ) {
      const name = text(parsed.name) || `Claude ${text(parsed.uuid).slice(0, 8)}`;
      for (const doc of parsed.docs) {
        addLib(
          "docs",
          text(doc.uuid) || `${parsed.uuid}-${doc.filename}`,
          text(doc.filename) || "document",
          toIso(doc.created_at, nowIso),
          text(doc.content),
          name,
        );
      }
      continue;
    }

    // Memory → library (profile, per-project, memory files).
    if (
      parsed &&
      (parsed.conversations_memory !== undefined ||
        Array.isArray(parsed.memory_files) ||
        parsed.project_memories !== undefined)
    ) {
      const acct = text(parsed.account_uuid) || "account";
      addLib(
        "memory",
        `memory-${acct}-work`,
        "Work context",
        nowIso,
        text(parsed.conversations_memory),
      );
      if (parsed.project_memories && typeof parsed.project_memories === "object") {
        for (const [puid, value] of Object.entries(parsed.project_memories)) {
          addLib(
            "memory",
            `memory-${acct}-proj-${puid}`,
            `Project memory ${String(puid).slice(0, 8)}`,
            nowIso,
            text(value),
          );
        }
      }
      for (const file of parsed.memory_files ?? []) {
        addLib(
          "memory",
          `memory-file-${text(file.path)}`,
          text(file.path) || "file",
          toIso(file.updated_at, nowIso),
          text(file.content),
        );
      }
      continue;
    }

    // Conversations → session files (threads). Skipped entirely without a
    // target folder, so no fallback "Imported" project is ever created.
    if (!conversationProjectDir) continue;
    for (const { kind, conversation } of collectConversations(parsed)) {
      const thread =
        kind === "claude" ? fromClaudeAi(conversation, nowIso) : fromChatGpt(conversation, nowIso);
      if (!thread || thread.messages.length === 0) {
        skippedDetails.push({
          title: thread?.title ?? "(untitled)",
          reason: "No text messages (empty, or only images/attachments/tool output)",
        });
        continue;
      }
      const file = emit(thread, conversationProjectDir, convSeen);
      if (file) conversationFiles.push(file);
    }
  }

  return {
    conversationProjectDir,
    conversationFiles,
    library,
    skipped: skippedDetails.length,
    skippedDetails,
    manifest,
  };
}

/** Claude Code names each project directory after the cwd with separators dashed. @param {string} projectDir */
export function mungeProjectDir(projectDir) {
  return projectDir.replaceAll(/[/\\.]/g, "-");
}
