// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const mockDevinEnvironments = new Map<string, NodeJS.ProcessEnv>();

async function makeMockDevinWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-devin");
  mockDevinEnvironments.set(wrapperPath, extraEnv ?? {});
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDevinAdapter>[1]) =>
  Effect.gen(function* () {
    const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const extraEnvironment = mockDevinEnvironments.get(binaryPath);
    const environment =
      extraEnvironment || options?.environment
        ? { ...extraEnvironment, ...options?.environment }
        : undefined;
    const adapterOptions = {
      ...options,
      ...(environment ? { environment } : {}),
    } satisfies Parameters<typeof makeDevinAdapter>[1];
    const mockSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
      ...realSpawner,
      spawn: (command) => {
        if (command._tag === "StandardCommand" && command.command === binaryPath) {
          return realSpawner.spawn(
            ChildProcess.make(mockAgentCommand, [mockAgentPath, ...command.args], command.options),
          );
        }
        return realSpawner.spawn(command);
      },
    });

    return yield* makeDevinAdapter(decodeDevinSettings({ binaryPath }), adapterOptions).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
    );
  }).pipe(Effect.orDie);

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "composer-2" },
      });

      assert.equal(session.provider, "devin");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello devin",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps Devin thought chunks to reasoning text deltas", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-thought-chunks");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_AGENT_THOUGHT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "think briefly",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const deltas = runtimeEvents.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => ({
          streamKind: event.payload.streamKind,
          delta: event.payload.delta,
        })),
        [
          { streamKind: "reasoning_text", delta: "thinking from mock" },
          { streamKind: "assistant_text", delta: "hello from mock" },
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("enriches sparse Devin permission requests from tool-call updates", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-sparse-permission");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_SPARSE_PERMISSION_TOOL_CALL: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "request.opened") {
          return Deferred.succeed(requestOpened, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "read package metadata", attachments: [] })
        .pipe(Effect.forkChild);

      const opened = yield* Deferred.await(requestOpened);
      assert.equal(opened.payload.requestType, "exec_command_approval");
      assert.equal(opened.payload.detail, "cat server/package.json");

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );

      yield* Deferred.await(turnCompleted);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces Devin plan-exit permissions as proposed plans and dynamic approvals", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-plan-exit-permission");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_DEVIN_PLAN_EXIT_PERMISSION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const proposed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.proposed.completed" }>>();
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "turn.proposed.completed") {
          return Deferred.succeed(proposed, event).pipe(Effect.ignore);
        }
        if (event.type === "request.opened") {
          return Deferred.succeed(requestOpened, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "make a plan",
          attachments: [],
          interactionMode: "plan",
        })
        .pipe(Effect.forkChild);

      const proposedEvent = yield* Deferred.await(proposed);
      assert.equal(proposedEvent.raw?.method, "session/update");
      assert.include(proposedEvent.payload.planMarkdown, "probe-output.txt");
      assert.include(proposedEvent.payload.planMarkdown, "verify it contains exactly `hello`");

      const opened = yield* Deferred.await(requestOpened);
      assert.equal(opened.payload.requestType, "dynamic_tool_call");
      assert.equal(opened.payload.detail, "Exit plan mode");

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "decline",
      );

      yield* Deferred.await(turnCompleted);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps full-access and plan turns onto Devin bypass and plan modes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-plan-mode-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mode-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeValues = requests.flatMap((entry) => {
        const params = entry.params as Record<string, unknown> | undefined;
        return entry.method === "session/set_config_option" && params?.configId === "mode"
          ? [String(params.value)]
          : [];
      });

      assert.deepStrictEqual(modeValues, ["bypass", "plan"]);
    }),
  );

  it.effect("reports discovered models from real ACP session startup", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-session-model-discovery");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const discovered = yield* Deferred.make<ReadonlyArray<ServerProviderModel>>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        onSessionModelsDiscovered: (models) =>
          Deferred.succeed(discovered, models).pipe(Effect.asVoid),
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const models = yield* Deferred.await(discovered);
      assert.includeMembers(
        models.map((model) => model.slug),
        ["auto", "composer-2", "codex-5-3"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles ACP session elicitation requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-session-elicitation");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_ELICITATION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask for Devin options", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.raw?.method, "session/elicitation");
      assert.deepEqual(
        requestedEvent.payload.questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          required: question.required,
          multiSelect: question.multiSelect,
        })),
        [
          {
            id: "scope",
            question: "Which scope should Devin use?",
            options: ["Workspace", "Session"],
            required: true,
            multiSelect: false,
          },
          {
            id: "fast",
            question: "Use fast mode?",
            options: ["Yes", "No"],
            required: true,
            multiSelect: false,
          },
          {
            id: "notes",
            question: "Any extra notes?",
            options: [],
            required: true,
            multiSelect: false,
          },
        ],
      );

      const invalidError = yield* Effect.flip(
        adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requestedEvent.requestId)),
          {
            scope: "Workspace",
            fast: "Yes",
          },
        ),
      );
      assert.equal(invalidError._tag, "ProviderAdapterRequestError");
      if (invalidError._tag === "ProviderAdapterRequestError") {
        assert.equal(
          invalidError.detail,
          "Invalid Devin elicitation response: missing required answers.",
        );
      }

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          scope: "Workspace",
          fast: "Yes",
          notes: "Keep it focused",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        scope: "Workspace",
        fast: "Yes",
        notes: "Keep it focused",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles Devin private elicitation requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-private-elicitation");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_DEVIN_PRIVATE_ELICITATION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const continued =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "content.delta" }>>();
      const turnCompleted = yield* Deferred.make<void>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (
          event.type === "content.delta" &&
          event.payload.delta.includes("Devin received the answer and continued")
        ) {
          return Deferred.succeed(continued, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask one Devin question", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.raw?.method, "_session/elicitation");
      assert.deepEqual(
        requestedEvent.payload.questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          required: question.required,
          multiSelect: question.multiSelect,
        })),
        [
          {
            id: "q0",
            question: "What would you like Devin to do?",
            options: ["Build a new feature", "Research or plan only"],
            required: true,
            multiSelect: false,
          },
        ],
      );

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          q0: "Research or plan only",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        q0: "Research or plan only",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      const continuedEvent = yield* Deferred.await(continued);
      assert.equal(continuedEvent.payload.streamKind, "assistant_text");
      yield* Deferred.await(turnCompleted);
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles Devin ask-question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-ask-question-extension");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_DEVIN_ASK_QUESTION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.raw?.method, "devin/ask_question");
      assert.deepEqual(
        requestedEvent.payload.questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multiSelect: question.multiSelect,
        })),
        [
          {
            id: "scope",
            question: "Which scope should Devin use?",
            options: ["Workspace", "Session"],
            multiSelect: false,
          },
        ],
      );

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          scope: "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        scope: "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles Devin create-plan extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-create-plan-extension");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_DEVIN_CREATE_PLAN: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const proposed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.proposed.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        return event.type === "turn.proposed.completed"
          ? Deferred.succeed(proposed, event).pipe(Effect.ignore)
          : Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "propose a plan", attachments: [] })
        .pipe(Effect.forkChild);

      const proposedEvent = yield* Deferred.await(proposed);
      assert.equal(proposedEvent.raw?.method, "devin/create_plan");
      assert.include(proposedEvent.payload.planMarkdown, "# Devin plan");
      assert.include(proposedEvent.payload.planMarkdown, "Inspect Devin ACP callbacks");
      assert.isDefined(proposedEvent.turnId);
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles Devin todo update extension notifications", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-update-todos-extension");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_DEVIN_UPDATE_TODOS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const planUpdated =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.plan.updated" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        return event.type === "turn.plan.updated"
          ? Deferred.succeed(planUpdated, event).pipe(Effect.ignore)
          : Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "update todos", attachments: [] })
        .pipe(Effect.forkChild);

      const planUpdatedEvent = yield* Deferred.await(planUpdated);
      assert.equal(planUpdatedEvent.raw?.method, "devin/update_todos");
      assert.deepEqual(planUpdatedEvent.payload, {
        explanation: "Devin progress",
        plan: [
          { step: "Inspect Devin ACP callbacks", status: "completed" },
          { step: "Implement the missing callback", status: "inProgress" },
          { step: "Verify behavior", status: "pending" },
        ],
      });
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("accepts URL elicitation completion notifications", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-url-elicitation-complete");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_URL_ELICITATION_COMPLETE: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "complete URL elicitation",
        attachments: [],
      });

      assert.isDefined(turn.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves an existing session when a restart fails after ACP start", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-preserve-session-on-restart-failure");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_FAIL_MODEL_CONFIG_OPTION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const firstSession = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const restartError = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "composer-2" },
        }),
      );
      const sessions = yield* adapter.listSessions();
      const preserved = sessions.find((session) => String(session.threadId) === String(threadId));

      assert.equal(restartError._tag, "ProviderAdapterRequestError");
      assert.deepEqual(preserved?.resumeCursor, firstSession.resumeCursor);
      assert.equal(preserved?.status, "ready");

      yield* adapter.stopSession(threadId);
    }),
  );
});
