/**
 * AdelisOne: publishes the central service's tools and block procedures through
 * T3's own `t3-code` MCP server. Every provider adapter already attaches that
 * server in its native format, so this is the one place A1 reaches all of
 * them: current providers and any added later.
 *
 * Tools are fetched from the platform (role-filtered there) and registered on
 * startup when an employee is signed in, and again after each sign-in. Each
 * call is forwarded as that employee; the platform keeps doing the governing.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { A1Account, A1NotSignedIn, A1RequestFailed, type A1Client } from "./A1Account.ts";

interface PlatformTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

interface PlatformPrompt {
  readonly name: string;
  readonly description?: string;
}

interface PlatformContent {
  readonly type: string;
  readonly text?: string;
}

/** Role names the platform serves block procedures under (blocks/README.md). */
const BLOCK_TITLES: Record<string, string> = {
  architect: "Architect — builds tools",
  analyst: "Analyst — answers data questions",
  advisor: "Advisor — assistant with memory",
  librarian: "Librarian — curates business memory",
  curator: "Curator — retires unused tools",
  watchman: "Watchman — instance health",
};

const textResult = (text: string, isError = false) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

const describeFailure = (error: unknown): string =>
  error instanceof A1NotSignedIn
    ? "Not signed in to AdelisOne. Ask the user to sign in under Settings → General."
    : error instanceof A1RequestFailed
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

const callPlatformTool = (client: A1Client, name: string, args: unknown) =>
  Effect.promise(() =>
    client
      .rpc<{ readonly content?: ReadonlyArray<PlatformContent>; readonly isError?: boolean }>(
        "tools/call",
        { name, arguments: args ?? {} },
      )
      .then((result) => {
        const text = (result.content ?? [])
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text as string)
          .join("\n");
        return textResult(text, result.isError === true);
      })
      .catch((error: unknown) => textResult(describeFailure(error), true)),
  );

const getPlatformPrompt = (client: A1Client, name: string) =>
  Effect.promise(() =>
    client
      .rpc<{
        readonly description?: string;
        readonly messages?: ReadonlyArray<{
          readonly role: "user" | "assistant";
          readonly content: PlatformContent;
        }>;
      }>("prompts/get", { name })
      .then(
        (result) =>
          new McpSchema.GetPromptResult({
            ...(result.description === undefined ? {} : { description: result.description }),
            messages: (result.messages ?? []).map((message) => ({
              role: message.role,
              content: { type: "text" as const, text: message.content.text ?? "" },
            })),
          }),
      )
      .catch(
        (error: unknown) =>
          new McpSchema.GetPromptResult({
            messages: [{ role: "user", content: { type: "text", text: describeFailure(error) } }],
          }),
      ),
  );

const register = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const client = yield* A1Account;
  const registeredTools = new Set<string>();
  const registeredPrompts = new Set<string>();

  const sync = Effect.gen(function* () {
    if (!client.signedIn) return;
    const [tools, prompts] = yield* Effect.promise(() =>
      Promise.all([
        client.rpc<{ readonly tools?: ReadonlyArray<PlatformTool> }>("tools/list"),
        client.rpc<{ readonly prompts?: ReadonlyArray<PlatformPrompt> }>("prompts/list"),
      ]),
    );
    for (const tool of tools.tools ?? []) {
      if (registeredTools.has(tool.name)) continue;
      registeredTools.add(tool.name);
      const inputSchema =
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? (tool.inputSchema as McpSchema.ToolJsonSchema)
          : ({ type: "object" } as McpSchema.ToolJsonSchema);
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          description: `AdelisOne (this business's own data platform): ${tool.description ?? ""}`,
          inputSchema,
        }),
        annotations: Context.empty(),
        handle: (payload) => callPlatformTool(client, tool.name, payload),
      });
    }
    for (const prompt of prompts.prompts ?? []) {
      if (registeredPrompts.has(prompt.name)) continue;
      registeredPrompts.add(prompt.name);
      yield* server.addPrompt({
        prompt: new McpSchema.Prompt({
          name: prompt.name,
          ...(BLOCK_TITLES[prompt.name] === undefined ? {} : { title: BLOCK_TITLES[prompt.name] }),
          ...(prompt.description === undefined ? {} : { description: prompt.description }),
          arguments: [],
        }),
        annotations: Context.empty(),
        completions: {},
        handle: () => getPlatformPrompt(client, prompt.name),
      });
    }
    yield* Effect.logInfo("AdelisOne tools registered on the t3-code MCP server", {
      tools: registeredTools.size,
      prompts: registeredPrompts.size,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("AdelisOne tool sync failed", { reason: describeFailure(error) }),
    ),
  );

  yield* sync;
  client.onChange(() => {
    Effect.runFork(sync);
  });
});

export const A1McpRegistrationLive = Layer.effectDiscard(register);
