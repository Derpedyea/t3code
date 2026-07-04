import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";

import {
  type AcpAdapterPendingUserInputResolution,
  makeAcpThreadLock,
  respondToAcpPermissionRequest,
  respondToAcpUserInput,
  selectPermissionOptionId,
  settlePendingAcpUserInputsAsCancelled,
} from "./AcpAdapterRuntime.ts";

describe("AcpAdapterRuntime", () => {
  it("falls back to allow_once for acceptForSession when allow_always is unavailable", () => {
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1" },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
    } satisfies EffectAcpSchema.RequestPermissionRequest;

    expect(selectPermissionOptionId(request, "acceptForSession")).toBe("allow-once");
  });

  it.effect("allows stopped thread locks to be marked for deletion", () =>
    Effect.gen(function* () {
      const threadLock = yield* makeAcpThreadLock();
      const events: Array<string> = [];

      yield* threadLock.withThreadLock(
        "thread-1",
        Effect.gen(function* () {
          events.push("first");
          yield* threadLock.deleteThreadLock("thread-1");
        }),
      );
      yield* threadLock.withThreadLock(
        "thread-1",
        Effect.sync(() => {
          events.push("second");
        }),
      );

      expect(events).toEqual(["first", "second"]);
    }),
  );

  it.effect("rejects duplicate ACP permission responses", () =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.make("permission-1");
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      const pendingApprovals = new Map([[requestId, { decision }]]);

      yield* respondToAcpPermissionRequest({
        provider: ProviderDriverKind.make("devin"),
        requestId,
        decision: "accept",
        pendingApprovals,
      });
      const error = yield* Effect.flip(
        respondToAcpPermissionRequest({
          provider: ProviderDriverKind.make("devin"),
          requestId,
          decision: "decline",
          pendingApprovals,
        }),
      );

      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.detail).toContain("Unknown pending approval request");
    }),
  );

  it.effect("rejects stale ACP user-input responses after cancellation", () =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.make("user-input-1");
      const resolution = yield* Deferred.make<AcpAdapterPendingUserInputResolution<string>>();
      const pendingUserInputs = new Map([
        [
          requestId,
          {
            resolution,
            makeResponse: (answers: ProviderUserInputAnswers) => String(answers["scope"]),
          },
        ],
      ]);

      yield* settlePendingAcpUserInputsAsCancelled(pendingUserInputs);
      const error = yield* Effect.flip(
        respondToAcpUserInput({
          provider: ProviderDriverKind.make("devin"),
          method: "session/elicitation",
          requestId,
          answers: { scope: "Workspace" },
          pendingUserInputs,
        }),
      );

      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.detail).toContain("no longer awaiting a response");
    }),
  );
});
