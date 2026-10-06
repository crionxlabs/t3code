// @ts-check
// Checks that every AdelisOne override still matches T3 Code's current source.
// Run after merging T3 Code updates: node --test "adelisone/tests/*.test.mjs"
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

import {
  DEV_WEB_ICONS,
  FILE_SWAPS,
  ICON_FILES,
  RENAME,
  REPLACEMENTS,
  applyOverrides,
  applyReplacements,
  isRenamed,
} from "../overrides.mjs";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
/** @param {string} file */
const read = (file) => NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");

NodeTest.describe("replacements", () => {
  for (const file of Object.keys(REPLACEMENTS)) {
    NodeTest.it(`still match T3 Code in ${file}`, () => {
      const source = read(file);
      const changed = applyReplacements(file, source);
      NodeAssert.notEqual(changed, source);
    });
  }

  NodeTest.it("leave nothing of T3's name in the setup wizard header", () => {
    const changed = applyReplacements(
      "apps/web/src/components/onboarding/WelcomeWizard.tsx",
      read("apps/web/src/components/onboarding/WelcomeWizard.tsx"),
    );
    NodeAssert.ok(!changed.includes('"Set up T3 Code"'));
    NodeAssert.ok(changed.includes("Set up other computers (advanced)"));
  });

  NodeTest.it("refuse to apply when T3's code has moved on", () => {
    NodeAssert.throws(
      () => applyReplacements("apps/server/src/os-jank.ts", "nothing to match here"),
      /no longer matches T3 Code/,
    );
  });
});

NodeTest.describe("rename", () => {
  for (const file of [
    "apps/web/src/components/settings/ChatGptWelcomeCoordinator.tsx",
    "apps/server/src/provider/CodexAuthCallbackPage.ts",
    "apps/server/src/provider/CodexChatGptAuth.ts",
    "packages/shared/src/codexAuthCallback.ts",
  ]) {
    NodeTest.it(`leaves no "T3 Code" in ${file}`, () => {
      const source = read(file);
      NodeAssert.ok(source.includes("T3 Code"), `${file} no longer mentions T3 Code`);
      NodeAssert.ok(!applyOverrides(file, source).includes("T3 Code"));
    });
  }

  for (const [file, texts] of Object.entries(RENAME.keep)) {
    NodeTest.it(`keeps T3's name where it must in ${file}`, () => {
      const source = read(file);
      const changed = applyOverrides(file, source);
      for (const text of texts) {
        NodeAssert.ok(source.includes(text), `T3 changed this text: ${text}`);
        NodeAssert.ok(changed.includes(text));
      }
    });
  }

  NodeTest.it("skip test files and AdelisOne's own files", () => {
    NodeAssert.ok(!isRenamed("apps/web/src/branding.test.ts"));
    NodeAssert.ok(!isRenamed("adelisone/overrides.mjs"));
    NodeAssert.ok(!isRenamed("apps/server/node_modules/x/index.js"));
    NodeAssert.ok(isRenamed("apps/web/src/branding.ts"));
  });
});

NodeTest.describe("files", () => {
  for (const [t3File, ours] of Object.entries(FILE_SWAPS)) {
    NodeTest.it(`swap ${t3File} for ${ours}`, () => {
      NodeAssert.ok(
        NodeFS.existsSync(NodePath.join(repoRoot, t3File)),
        `${t3File} is gone from T3`,
      );
      NodeAssert.ok(NodeFS.existsSync(NodePath.join(repoRoot, ours)), `${ours} is missing`);
    });
  }

  NodeTest.it("include every AdelisOne icon", () => {
    for (const file of [...ICON_FILES, ...Object.values(DEV_WEB_ICONS)]) {
      NodeAssert.ok(
        NodeFS.existsSync(NodePath.join(repoRoot, "adelisone", file)),
        `missing ${file}`,
      );
    }
  });
});
