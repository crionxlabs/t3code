import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for a move"),
} as ProviderAdapterV2Shape;

const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-move" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

// Seed a project row directly: the guard only reads it back through
// ProjectStore.get, and this keeps the test off the project-create effect path.
const seedProject = (sql: SqlClient.SqlClient, id: string) =>
  sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, default_model_selection_json,
       default_thread_env_mode, auto_pull, favicon_path, project_icon_json,
       scripts_json, created_at, updated_at, deleted_at)
    VALUES (${id}, ${id}, ${`/tmp/${id}`}, NULL, NULL, 0, NULL, NULL, '[]',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
  `;

const createThread = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  projectId: string,
  worktreePath: string | null,
) =>
  orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-thread-${threadId}`),
    threadId,
    projectId: ProjectId.make(projectId),
    title: "Imported chat",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    createdBy: "user",
    creationSource: "web",
  });

it.effect("moves a loose thread into another project", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:move-happy");
    yield* seedProject(sql, "project:dest");
    yield* createThread(orchestrator, threadId, "project:source", null);

    yield* orchestrator.dispatch({
      type: "thread.move",
      commandId: CommandId.make("move-happy"),
      threadId,
      toProjectId: ProjectId.make("project:dest"),
    });

    const shell = yield* projections.getThreadShell(threadId);
    assert.ok(shell);
    assert.equal(shell.projectId, ProjectId.make("project:dest"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects moving a thread into a project that does not exist", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:move-missing");
    yield* createThread(orchestrator, threadId, "project:source", null);

    const exit = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.move",
        commandId: CommandId.make("move-missing"),
        threadId,
        toProjectId: ProjectId.make("project:does-not-exist"),
      }),
    );
    assert.equal(exit._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects moving a thread that has its own worktree", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:move-worktree");
    yield* seedProject(sql, "project:dest2");
    yield* createThread(orchestrator, threadId, "project:source", "/repo/worktree");

    const exit = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.move",
        commandId: CommandId.make("move-worktree"),
        threadId,
        toProjectId: ProjectId.make("project:dest2"),
      }),
    );
    assert.equal(exit._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);
