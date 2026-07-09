import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { causeErrorTag, errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

function structuralMethod(value: string): string {
  return value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value) ? value : "unknown";
}

function structuralId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(value)
    ? value
    : undefined;
}

function summarizeProtocolResult(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  let action: string | undefined;
  if (typeof record.action === "string") {
    action = record.action;
  } else if (record.action !== null && typeof record.action === "object") {
    const nestedAction = (record.action as Record<string, unknown>).action;
    if (typeof nestedAction === "string") {
      action = nestedAction;
    }
  }
  const content = record.content;
  return {
    ...(action !== undefined ? { resultAction: structuralMethod(action) } : {}),
    ...(content !== null && typeof content === "object"
      ? { contentKeys: Object.keys(content as Record<string, unknown>).sort() }
      : {}),
  };
}

function summarizePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === null) return { valueType: "null" };
  if (typeof payload === "string") {
    return { valueType: "string", byteLength: new TextEncoder().encode(payload).byteLength };
  }
  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }
  if (Array.isArray(payload)) {
    return { valueType: "array", itemCount: payload.length };
  }
  if (typeof payload !== "object") {
    return { valueType: typeof payload };
  }

  try {
    const record = payload as Record<string, unknown>;
    const exit = record.exit;
    const exitRecord =
      exit !== null && typeof exit === "object" ? (exit as Record<string, unknown>) : undefined;
    return {
      valueType: "object",
      fieldCount: Object.keys(record).length,
      ...(typeof record._tag === "string" ? { messageTag: errorTag(record) } : {}),
      ...(typeof record.tag === "string" ? { method: structuralMethod(record.tag) } : {}),
      ...(record._tag === "Exit" && structuralId(record.requestId) !== undefined
        ? { requestId: structuralId(record.requestId) }
        : {}),
      ...(record._tag === "Exit" && typeof exitRecord?._tag === "string"
        ? { exitTag: errorTag(exitRecord) }
        : {}),
      ...(record._tag === "Exit" && exitRecord?._tag === "Success"
        ? summarizeProtocolResult(exitRecord.value)
        : {}),
    };
  } catch {
    return { valueType: "object" };
  }
}

function formatRequestLogPayload(event: AcpSessionRuntime.AcpSessionRequestLogEvent) {
  return {
    method: structuralMethod(event.method),
    status: event.status,
    request: summarizePayload(event.payload),
    ...(event.result !== undefined ? { result: summarizePayload(event.result) } : {}),
    ...(event.cause !== undefined
      ? {
          errorTag: causeErrorTag(event.cause),
          reasonCount: event.cause.reasons.length,
        }
      : {}),
  };
}

function formatProtocolLogPayload(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizePayload(event.payload),
  };
}

export const makeAcpNativeLoggerFactory = Effect.fn("makeAcpNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
  }): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> => {
    const writeNativeAcpLog = (logInput: {
      readonly kind: "request" | "protocol";
      readonly payload: unknown;
    }) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4,
              kind: logInput.kind,
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: logInput.payload,
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native ACP event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      );

    return {
      requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        writeNativeAcpLog({
          kind: "request",
          payload: formatRequestLogPayload(event),
        }),
      ...(input.nativeEventLogger
        ? {
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                writeNativeAcpLog({
                  kind: "protocol",
                  payload: formatProtocolLogPayload(event),
                }),
            } satisfies NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]>,
          }
        : {}),
    };
  };
});
