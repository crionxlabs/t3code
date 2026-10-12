// @ts-check
/**
 * Reads every file out of an export input — a .zip (reads each entry), a
 * directory (recurses), or a single file — returning `{ path, content }` for
 * each. claude.ai's export is several category zips plus loose files; hand this
 * all of them and convertExport pairs artifact metadata with its content file.
 * Used by the upload route (adelisone/server/importChatsRoute.ts).
 */
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** @param {Buffer} buffer */
const isZip = (buffer) => buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b;

// Text files we can read as content; everything else (images, binaries) is skipped.
const TEXTUAL = /\.(json|md|markdown|html?|txt|csv)$/i;

/** @param {string} zipPath @returns {Array<{ path: string; content: string }>} */
function readZip(zipPath) {
  const listing = execFileSync("unzip", ["-Z", "-1", zipPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = [];
  for (const raw of listing.split("\n")) {
    const name = raw.trim();
    if (!name || name.endsWith("/") || !TEXTUAL.test(name)) continue;
    try {
      const content = execFileSync("unzip", ["-p", zipPath, name], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024,
      });
      entries.push({ path: name, content });
    } catch {
      // Unreadable entry (encoding, size): skip rather than fail the import.
    }
  }
  return entries;
}

/** @param {string} dir @param {string} [base] @returns {Array<{ path: string; content: string }>} */
function readDir(dir, base = dir) {
  const entries = [];
  for (const name of NodeFS.readdirSync(dir)) {
    const full = NodePath.join(dir, name);
    const stat = NodeFS.statSync(full);
    if (stat.isDirectory()) entries.push(...readDir(full, base));
    else if (TEXTUAL.test(name)) {
      const rel = NodePath.relative(base, full).split(NodePath.sep).join("/");
      entries.push({ path: rel, content: NodeFS.readFileSync(full, "utf8") });
    }
  }
  return entries;
}

/** @param {string} inputPath @returns {Array<{ path: string; content: string }>} */
export function readExportEntries(inputPath) {
  const stat = NodeFS.statSync(inputPath);
  if (stat.isDirectory()) return readDir(inputPath);
  if (inputPath.toLowerCase().endsWith(".zip")) return readZip(inputPath);
  return [{ path: NodePath.basename(inputPath), content: NodeFS.readFileSync(inputPath, "utf8") }];
}

/**
 * Entries from an in-memory upload (a zip, or a single JSON/text file).
 * @param {Buffer} buffer @param {string} tempDir scratch dir for a zip @param {string} [name]
 * @returns {Array<{ path: string; content: string }>}
 */
export function readExportEntriesFromBuffer(buffer, tempDir, name = "upload") {
  if (!isZip(buffer)) return [{ path: name, content: buffer.toString("utf8") }];
  const zipPath = NodePath.join(tempDir, "upload.zip");
  NodeFS.writeFileSync(zipPath, buffer);
  return readZip(zipPath);
}
