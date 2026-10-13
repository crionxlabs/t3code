// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
        Layer.succeed(ServerConfig.ServerConfig, {
          attachmentsDir: "/tmp/a1-test-attachments",
        } as never),
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
      // Imported chats arrive active (in the main list), not pre-settled.
      settledOverride: "active",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(testLayer));
});

it.effect("imports inline images as chat attachments and writes their bytes", () => {
  const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "a1-attach-test-"));
  // A 1x1 PNG.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const claudeSessionId = "11111111-1111-4111-8111-111111111111";
  const imageThreadId = ThreadId.make(`import:${providerInstanceId}:${claudeSessionId}`);
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "claudeAgent",
          providerInstanceId,
          providerSessionId: claudeSessionId,
          filePath: "/tmp/with-image.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "claudeAgent",
          providerInstanceId,
          providerSessionId: claudeSessionId,
          title: "With image",
          model: null,
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            {
              role: "user",
              text: "look at this",
              createdAt: "2026-09-01T10:00:00.000Z",
              attachments: [{ mimeType: "image/png", data: pngBase64, name: "shot.png" }],
            },
          ],
        },
      }),
  });
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: imageThreadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({ threadId: imageThreadId }),
                ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
        Layer.succeed(ServerConfig.ServerConfig, { attachmentsDir } as never),
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importRecentAgentThreads({ projectId });
    const messageEvent = writes[0]?.find((event) => event.type === "message.updated");
    const attachments =
      messageEvent?.type === "message.updated" ? messageEvent.payload.attachments : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      name: "shot.png",
    });
    // The bytes were written into the attachment store.
    const files = NodeFS.readdirSync(attachmentsDir);
    expect(files).toHaveLength(1);
    expect(NodeFS.statSync(NodePath.join(attachmentsDir, files[0]!)).size).toBeGreaterThan(0);
  }).pipe(Effect.provide(testLayer));
});

it("re-homes an already-imported chat into the project it's imported into", () => {
  const moves: Array<{ readonly type: string; readonly toProjectId?: unknown }> = [];
  const otherProjectId = ProjectId.make("agent-session-import-other-project");
  const claudeSessionId = "22222222-2222-4222-8222-222222222222";
  const rehomeThreadId = ThreadId.make(`import:${providerInstanceId}:${claudeSessionId}`);
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "claudeAgent",
          providerInstanceId,
          providerSessionId: claudeSessionId,
          filePath: "/tmp/rehome.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "claudeAgent",
          providerInstanceId,
          providerSessionId: claudeSessionId,
          title: "Re-home",
          model: null,
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [{ role: "user", text: "hi", createdAt: "2026-09-01T10:00:00.000Z" }],
        },
      }),
  });
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          // The chat already exists under a different project, imported earlier.
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: rehomeThreadId, projectId: otherProjectId, historyOrigin: "v1_import" },
            } as never),
          dispatch: ((command: { type: string }) =>
            Effect.sync(() => {
              moves.push(command);
              return [];
            })) as never,
        }),
        Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([] as never) }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: () => Effect.void,
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
        Layer.succeed(ServerConfig.ServerConfig, {
          attachmentsDir: "/tmp/a1-test-attachments",
        } as never),
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.importRecentAgentThreads({ projectId });
    expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
    // It moved the existing thread to the target project instead of erroring.
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "thread.move", toProjectId: projectId });
  }).pipe(Effect.provide(testLayer));
});
