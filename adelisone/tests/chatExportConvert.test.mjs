// @ts-check
/**
 * Converter unit tests (adelisone/shared/chatExportConvert.mjs). Synthetic
 * fixtures only — no real export data — covering the behaviours AdelisOne relies
 * on: ChatGPT multimodal text is not dropped, Claude project instructions become
 * a CLAUDE.md, and both conversation formats emit session files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { convertExport } from "../shared/chatExportConvert.mjs";

const NOW = "2026-10-12T00:00:00.000Z";
const CONV_DIR = "/tmp/a1-conv";
const entry = (path, obj) => ({ path, content: JSON.stringify(obj) });

test("ChatGPT multimodal_text keeps its written text (images aside)", () => {
  const convo = {
    id: "chatgpt-1",
    title: "Has an image",
    create_time: 1_700_000_000,
    current_node: "b",
    mapping: {
      a: { id: "a", parent: null, children: ["b"], message: null },
      b: {
        id: "b",
        parent: "a",
        children: [],
        message: {
          author: { role: "user" },
          create_time: 1_700_000_000,
          content: {
            content_type: "multimodal_text",
            parts: [
              { asset_pointer: "file-service://x", content_type: "image_asset_pointer" },
              "text alongside the image",
            ],
          },
        },
      },
    },
  };
  const result = convertExport([entry("conversations-000.json", [convo])], "/tmp/x", NOW, CONV_DIR);
  assert.equal(result.conversationFiles.length, 1);
  assert.match(result.conversationFiles[0].content, /text alongside the image/);
});

test("ChatGPT reasoning (thoughts) is not emitted as a message", () => {
  const convo = {
    id: "chatgpt-2",
    title: "Thinking only",
    create_time: 1_700_000_000,
    current_node: "b",
    mapping: {
      a: { id: "a", parent: null, children: ["b"], message: null },
      b: {
        id: "b",
        parent: "a",
        children: [],
        message: {
          author: { role: "assistant" },
          create_time: 1_700_000_000,
          content: { content_type: "thoughts", thoughts: [{ content: "secret reasoning" }] },
        },
      },
    },
  };
  const result = convertExport([entry("conversations-000.json", [convo])], "/tmp/x", NOW, CONV_DIR);
  assert.equal(result.conversationFiles.length, 0);
});

test("Claude project description + prompt_template become a CLAUDE.md doc", () => {
  const project = {
    uuid: "proj-1",
    name: "MarTech",
    description: "Marketing workspace",
    prompt_template: "Always answer as a CMO.",
    created_at: "2026-01-01T00:00:00Z",
    docs: [{ uuid: "d1", filename: "notes.md", content: "doc body", created_at: "2026-01-02" }],
  };
  const result = convertExport([entry("projects/proj-1.json", project)], "/tmp/x", NOW, CONV_DIR);
  const instructions = result.library.docs.find((d) => d.title === "CLAUDE.md");
  assert.ok(instructions, "expected a CLAUDE.md instructions doc");
  assert.equal(instructions.group, "MarTech");
  assert.match(instructions.content, /Marketing workspace/);
  assert.match(instructions.content, /Always answer as a CMO\./);
  // The knowledge doc is still carried, grouped under the same project.
  assert.ok(result.library.docs.some((d) => d.title === "notes.md" && d.group === "MarTech"));
});

test("a project with no description/instructions gets no CLAUDE.md", () => {
  const project = {
    uuid: "proj-2",
    name: "Bare",
    created_at: "2026-01-01T00:00:00Z",
    docs: [{ uuid: "d2", filename: "a.md", content: "x", created_at: "2026-01-02" }],
  };
  const result = convertExport([entry("projects/proj-2.json", project)], "/tmp/x", NOW, CONV_DIR);
  assert.equal(result.library.docs.filter((d) => d.title === "CLAUDE.md").length, 0);
});

test("ChatGPT multimodal images become inline image blocks via the resolver", () => {
  const convo = {
    id: "chatgpt-img",
    title: "Has image",
    create_time: 1_700_000_000,
    current_node: "b",
    mapping: {
      a: { id: "a", parent: null, children: ["b"], message: null },
      b: {
        id: "b",
        parent: "a",
        children: [],
        message: {
          author: { role: "user" },
          create_time: 1_700_000_000,
          content: {
            content_type: "multimodal_text",
            parts: [
              { asset_pointer: "file-service://file-abc", content_type: "image_asset_pointer" },
              "with text",
            ],
          },
        },
      },
    },
  };
  const resolveAsset = (id) =>
    id === "file-abc" ? { mimeType: "image/png", data: "AAAA", name: "x.png" } : null;
  const result = convertExport(
    [entry("conversations-000.json", [convo])],
    "/tmp/x",
    NOW,
    CONV_DIR,
    resolveAsset,
  );
  assert.equal(result.conversationFiles.length, 1);
  const line = result.conversationFiles[0].content.split("\n").find(Boolean);
  const record = JSON.parse(line);
  const image = record.message.content.find((block) => block.type === "image");
  assert.ok(image, "expected an image content block");
  assert.deepEqual(
    { mimeType: image.mimeType, data: image.data, name: image.name },
    { mimeType: "image/png", data: "AAAA", name: "x.png" },
  );
  assert.ok(
    record.message.content.some(
      (block) => block.type === "text" && block.text.includes("with text"),
    ),
  );
});

test("an image-only ChatGPT message still imports when the resolver supplies the image", () => {
  const convo = {
    id: "img-only",
    title: "img",
    create_time: 1_700_000_000,
    current_node: "b",
    mapping: {
      a: { id: "a", parent: null, children: ["b"], message: null },
      b: {
        id: "b",
        parent: "a",
        children: [],
        message: {
          author: { role: "user" },
          create_time: 1_700_000_000,
          content: {
            content_type: "multimodal_text",
            parts: [
              { asset_pointer: "file-service://file-xyz", content_type: "image_asset_pointer" },
            ],
          },
        },
      },
    },
  };
  const result = convertExport(
    [entry("conversations-000.json", [convo])],
    "/tmp/x",
    NOW,
    CONV_DIR,
    () => ({ mimeType: "image/png", data: "BBBB", name: "only.png" }),
  );
  assert.equal(result.conversationFiles.length, 1);
});

test("claude.ai conversation emits a session file", () => {
  const convo = {
    uuid: "11111111-1111-4111-8111-111111111111",
    name: "Hello",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T01:00:00Z",
    chat_messages: [
      { sender: "human", text: "hi", created_at: "2026-01-01T00:00:00Z" },
      { sender: "assistant", text: "hello back", created_at: "2026-01-01T00:00:10Z" },
    ],
  };
  const result = convertExport([entry("conversations.json", [convo])], "/tmp/x", NOW, CONV_DIR);
  assert.equal(result.conversationFiles.length, 1);
  assert.match(result.conversationFiles[0].content, /hello back/);
});
