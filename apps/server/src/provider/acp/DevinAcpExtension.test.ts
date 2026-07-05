import { describe, expect, it } from "vite-plus/test";

import {
  extractDevinPlanMarkdown,
  extractDevinPlanUpdate,
  makeDevinAskQuestionPrompt,
  methodLooksLikeDevinAskQuestion,
  methodLooksLikeDevinCreatePlan,
  methodLooksLikeDevinUpdateTodos,
  parseDevinAskQuestionPayload,
} from "./DevinAcpExtension.ts";

describe("DevinAcpExtension", () => {
  it("recognizes Devin ask-question extension methods", () => {
    expect(methodLooksLikeDevinAskQuestion("devin/ask_question")).toBe(true);
    expect(methodLooksLikeDevinAskQuestion("_devin/ask_user_question")).toBe(true);
    expect(methodLooksLikeDevinAskQuestion("session/elicitation")).toBe(false);
  });

  it("recognizes Devin plan extension methods", () => {
    expect(methodLooksLikeDevinCreatePlan("devin/create_plan")).toBe(true);
    expect(methodLooksLikeDevinUpdateTodos("devin/update_todos")).toBe(true);
    expect(methodLooksLikeDevinUpdateTodos("_devin/update_plan")).toBe(true);
    expect(methodLooksLikeDevinCreatePlan("devin/ask_question")).toBe(false);
  });

  it("parses question-array payloads and maps labels back to option ids", () => {
    const prompt = makeDevinAskQuestionPrompt({
      toolCallId: "ask-1",
      title: "Need input",
      questions: [
        {
          id: "scope",
          prompt: "Which scope should Devin use?",
          options: [
            { id: "workspace", label: "Workspace", description: "Use the workspace" },
            { id: "session", label: "Session" },
          ],
        },
      ],
    });

    expect(prompt?.questions).toEqual([
      {
        id: "scope",
        header: "Question",
        question: "Which scope should Devin use?",
        multiSelect: false,
        options: [
          { label: "Workspace", description: "Use the workspace" },
          { label: "Session", description: "Session" },
        ],
      },
    ]);
    expect(prompt?.makeResponse({ scope: "Workspace" })).toEqual({
      outcome: "accepted",
      answers: { scope: "workspace" },
    });
  });

  it("accepts wrapped payloads and simpler single-question payloads", () => {
    expect(
      parseDevinAskQuestionPayload({
        method: "devin/ask_question",
        params: {
          question: "Continue?",
          options: ["Yes", "No"],
        },
      }).map((question) => ({ id: question.id, question: question.question })),
    ).toEqual([{ id: "Continue?", question: "Continue?" }]);
  });

  it("extracts proposed plan markdown from direct and structured payloads", () => {
    expect(
      extractDevinPlanMarkdown({
        plan: "# Plan\n\n1. Inspect\n2. Implement",
      }),
    ).toBe("# Plan\n\n1. Inspect\n2. Implement");

    expect(
      extractDevinPlanMarkdown({
        title: "Implementation plan",
        overview: "Tighten Devin callbacks",
        todos: [{ content: "Add parser" }, { content: "Wire adapter" }],
      }),
    ).toBe("# Implementation plan\n\nTighten Devin callbacks\n\n1. Add parser\n\n2. Wire adapter");
  });

  it("extracts plan updates from todo and plan payloads", () => {
    expect(
      extractDevinPlanUpdate({
        overview: "Current work",
        todos: [
          { content: "Inspect state", status: "completed" },
          { title: "Apply fix", status: "in_progress" },
          { text: "Verify", status: "todo" },
          { content: "   " },
        ],
      }),
    ).toEqual({
      explanation: "Current work",
      plan: [
        { step: "Inspect state", status: "completed" },
        { step: "Apply fix", status: "inProgress" },
        { step: "Verify", status: "pending" },
      ],
    });
  });
});
