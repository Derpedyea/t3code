import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";

import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import { makeAcpJsonTextGeneration } from "./AcpJsonTextGeneration.ts";

function makeQueuedRuntime(
  input: {
    readonly text?: string;
    readonly stopReason?: EffectAcpSchema.PromptResponse["stopReason"];
  } = {},
): Effect.Effect<AcpSessionRuntime.AcpSessionRuntime["Service"]> {
  return Effect.gen(function* () {
    const promptStarted = yield* Deferred.make<void>();
    const contentEvent = {
      _tag: "ContentDelta",
      streamKind: "assistant_text",
      text: input.text ?? '{"title":"Drain queued ACP text"}',
      rawPayload: { sessionId: "queued-session" },
    } satisfies AcpSessionRuntime.AcpSessionRuntimeEvent;

    return {
      handleElicitation: () => Effect.void,
      handleRequestPermission: () => Effect.void,
      start: () =>
        Effect.succeed({
          sessionId: "queued-session",
          initializeResult: { protocolVersion: 1, agentCapabilities: {} },
          sessionSetupResult: { sessionId: "queued-session" },
          modelConfigId: undefined,
        } as AcpSessionRuntime.AcpSessionRuntimeStartResult),
      getEvents: () =>
        Stream.fromEffect(Deferred.await(promptStarted)).pipe(
          Stream.flatMap(() => Stream.fromIterable([contentEvent])),
        ),
      drainEvents: Effect.gen(function* () {
        for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
          yield* Effect.yieldNow;
        }
      }),
      prompt: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.as({
            stopReason: input.stopReason ?? "end_turn",
          } satisfies EffectAcpSchema.PromptResponse),
        ),
    } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
  });
}

it.effect("drains queued ACP events before decoding generated JSON", () =>
  Effect.gen(function* () {
    const textGeneration = makeAcpJsonTextGeneration({
      traceName: "QueuedAcpTextGeneration",
      requestLabel: "Queued ACP",
      outputLabel: "Queued ACP",
      makeRuntime: () => makeQueuedRuntime(),
      configureSession: () => Effect.void,
    });

    const generated = yield* textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "Name this thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("devin"),
        model: "mock-model",
      },
    });

    assert.equal(generated.title, "Drain queued ACP text");
  }),
);

it.effect("fails before decoding ACP output when stop reason is non-success", () =>
  Effect.gen(function* () {
    const textGeneration = makeAcpJsonTextGeneration({
      traceName: "StoppedAcpTextGeneration",
      requestLabel: "Stopped ACP",
      outputLabel: "Stopped ACP",
      makeRuntime: () =>
        makeQueuedRuntime({
          text: '{"title":"Should not be accepted"}',
          stopReason: "refusal",
        }),
      configureSession: () => Effect.void,
    });

    const result = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "Name this thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("devin"),
          model: "mock-model",
        },
      })
      .pipe(Effect.result);

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.instanceOf(result.failure, TextGenerationError);
      assert.include(
        result.failure.message,
        "Stopped ACP request stopped before completing: refusal",
      );
    }
  }),
);
