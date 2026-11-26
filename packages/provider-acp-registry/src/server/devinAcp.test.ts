import { expect, it } from "@effect/vitest";
import {
  extractMcpToolCallIdentity,
  mergeToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";

import { normalizeDevinToolCall } from "./devinAcp.ts";

it("keeps T3's identity on a Devin MCP call after its titleless completion", () => {
  const title = "Called html_render from t3-code";
  const started = normalizeDevinToolCall({ toolCallId: "call-1", title, data: { title } });
  const completed = mergeToolCallState(started, { toolCallId: "call-1", data: {} });
  expect(completed.title).toBe(title);
  expect(extractMcpToolCallIdentity(completed)).toEqual({ server: "t3-code", tool: "html_render" });
});
