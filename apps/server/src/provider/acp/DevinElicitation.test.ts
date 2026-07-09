import { describe, expect, it } from "@effect/vitest";

import { makeDevinElicitationPrompt } from "./DevinElicitation.ts";

describe("makeDevinElicitationPrompt", () => {
  it("disambiguates duplicate enum labels and rejects invalid custom answers", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a scope",
      requestedSchema: {
        type: "object",
        title: "Scope",
        properties: {
          scope: {
            type: "string",
            title: "Scope",
            oneOf: [
              { const: "repo", title: "Repository" },
              { const: "workspace", title: "Repository" },
              { const: "Repository (workspace)", title: "Repository (workspace)" },
            ],
          },
        },
        required: ["scope"],
      },
    });

    expect(prompt.questions[0]?.options.map((option) => option.label)).toEqual([
      "Repository",
      "Repository (workspace)",
      "Repository (workspace) (Repository (workspace))",
    ]);

    const invalid = prompt.makeResponse({ scope: "foobar" });
    expect(invalid).toEqual({ action: { action: "decline" } });

    const valid = prompt.makeResponse({ scope: "Repository (workspace)" });
    expect(valid).toEqual({
      action: {
        action: "accept",
        content: { scope: "workspace" },
      },
    });

    const labelCollision = prompt.makeResponse({
      scope: "Repository (workspace) (Repository (workspace))",
    });
    expect(labelCollision).toEqual({
      action: {
        action: "accept",
        content: { scope: "Repository (workspace)" },
      },
    });
  });

  it("uses const values as labels when Devin stores option descriptions in titles", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "form",
      sessionId: "session-1",
      message: "What would you like Devin to do?",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Task",
            description: "What would you like Devin to do?",
            oneOf: [
              {
                const: "Build a new feature",
                title: "Add new functionality to the project.",
              },
              {
                const: "Research or plan only",
                title: "Explore options without changing files.",
              },
            ],
          },
        },
        required: ["q0"],
      },
      _meta: {
        "cognition.ai/allowOther": true,
      },
    });

    expect(prompt.questions[0]?.options).toEqual([
      {
        label: "Build a new feature",
        description: "Add new functionality to the project.",
      },
      {
        label: "Research or plan only",
        description: "Explore options without changing files.",
      },
    ]);
    expect(prompt.makeResponse({ q0: "Research or plan only" })).toEqual({
      action: {
        action: "accept",
        content: { q0: "Research or plan only" },
      },
    });
    expect(prompt.makeResponse({ q0: "Only inspect the failing file" })).toEqual({
      action: {
        action: "accept",
        content: { q0: "Only inspect the failing file" },
      },
    });
  });

  it("maps selected labels but passes through custom answers when Devin allows Other responses", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "form",
      sessionId: "session-1",
      message: "Which scope?",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Scope",
            description: "Which scope should Devin use?",
            oneOf: [
              { const: "workspace", title: "Workspace" },
              { const: "session", title: "Session" },
            ],
          },
        },
        required: ["q0"],
      },
      _meta: {
        "cognition.ai/allowOther": true,
      },
    });

    expect(prompt.makeResponse({ q0: "Workspace" })).toEqual({
      action: {
        action: "accept",
        content: { q0: "workspace" },
      },
    });
    expect(prompt.makeResponse({ q0: "Only inspect the failing file" })).toEqual({
      action: {
        action: "accept",
        content: { q0: "Only inspect the failing file" },
      },
    });
  });

  it("treats empty numeric answers as missing instead of zero", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "form",
      sessionId: "session-1",
      message: "How many retries?",
      requestedSchema: {
        type: "object",
        title: "Retries",
        properties: {
          retries: {
            type: "integer",
            title: "Retries",
          },
        },
        required: ["retries"],
      },
    });

    expect(prompt.makeResponse({ retries: "" })).toEqual({ action: { action: "decline" } });
    expect(prompt.makeResponse({ retries: "   " })).toEqual({ action: { action: "decline" } });
    expect(prompt.makeResponse({ retries: "2" })).toEqual({
      action: { action: "accept", content: { retries: 2 } },
    });
  });

  it("declines required multi-select answers when any selected value is invalid", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "form",
      sessionId: "session-1",
      message: "Choose permissions",
      requestedSchema: {
        type: "object",
        title: "Permissions",
        properties: {
          permissions: {
            type: "array",
            title: "Permissions",
            items: { type: "string", enum: ["read", "write"] },
          },
        },
        required: ["permissions"],
      },
    });

    expect(prompt.makeResponse({ permissions: ["read", "write"] })).toEqual({
      action: { action: "accept", content: { permissions: ["read", "write"] } },
    });
    expect(prompt.makeResponse({ permissions: ["read", "admin"] })).toEqual({
      action: { action: "decline" },
    });
  });

  it("marks optional form questions and omits unanswered optional values", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "form",
      sessionId: "session-1",
      message: "Choose options",
      requestedSchema: {
        type: "object",
        title: "Options",
        properties: {
          scope: {
            type: "string",
            title: "Scope",
          },
          notes: {
            type: "string",
            title: "Notes",
          },
        },
        required: ["scope"],
      },
    });

    expect(
      prompt.questions.map((question) => ({ id: question.id, required: question.required })),
    ).toEqual([
      { id: "scope", required: true },
      { id: "notes", required: false },
    ]);
    expect(prompt.makeResponse({ scope: "workspace" })).toEqual({
      action: { action: "accept", content: { scope: "workspace" } },
    });
  });

  it("only accepts explicit Done answers for URL elicitation prompts", () => {
    const prompt = makeDevinElicitationPrompt({
      mode: "url",
      sessionId: "session-1",
      elicitationId: "elicitation-1",
      message: "Complete setup",
      url: "https://example.com/setup",
    });

    expect(prompt.makeResponse({ __devin_elicitation_url: "Done" })).toEqual({
      action: { action: "accept" },
    });
    expect(prompt.makeResponse({ __devin_elicitation_url: "Cancel" })).toEqual({
      action: { action: "cancel" },
    });
    expect(prompt.makeResponse({ __devin_elicitation_url: "not done" })).toEqual({
      action: { action: "decline" },
    });
  });
});
