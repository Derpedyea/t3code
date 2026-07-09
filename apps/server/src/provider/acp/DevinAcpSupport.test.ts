import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  applyDevinRequestedMode,
  buildDevinDiscoveredModelsFromSessionSetup,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromSessionSetup,
  devinAcpModelVariantGroupsFromConfigOptions,
  isDevinAcpModelCoveredByBaseModelIds,
  resolveDevinAcpDisplayModelId,
  resolveDevinAcpModelSelection,
} from "./DevinAcpSupport.ts";

describe("DevinAcpSupport", () => {
  it("passes the config path as a Devin global flag before the acp subcommand", () => {
    expect(
      buildDevinAcpSpawnInput(
        {
          binaryPath: "devin",
          configPath: " C:\\devin\\test-config.json ",
        },
        "C:\\workspace\\t3code",
      ),
    ).toEqual({
      command: "devin",
      args: ["--config", "C:\\devin\\test-config.json", "acp"],
      cwd: "C:\\workspace\\t3code",
    });
  });

  it("reads the current model from ACP configOptions before unstable model state", () => {
    const response = {
      sessionId: "session-1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "adaptive",
          options: [{ value: "adaptive", name: "Adaptive" }],
        },
      ],
      models: {
        currentModelId: "legacy-model-state",
        availableModels: [{ modelId: "legacy-model-state", name: "Legacy" }],
      },
    } satisfies EffectAcpSchema.NewSessionResponse;

    expect(currentDevinModelIdFromSessionSetup(response)).toBe("adaptive");
  });

  it("groups Devin thinking and speed variants by base model", () => {
    const groups = devinAcpModelVariantGroupsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5-5-high-priority",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ]);

    expect(
      groups.map((group) => ({
        id: group.baseModelId,
        name: group.baseModelName,
        current: group.currentVariant?.exactModelId,
        variants: group.variants.map((variant) => ({
          exact: variant.exactModelId,
          reasoning: variant.reasoning,
          fast: variant.fastMode,
        })),
      })),
    ).toEqual([
      {
        id: "gpt-5-5",
        name: "GPT-5.5",
        current: "gpt-5-5-high-priority",
        variants: [
          { exact: "gpt-5-5-low", reasoning: "low", fast: false },
          { exact: "gpt-5-5-high-priority", reasoning: "high", fast: true },
        ],
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        current: undefined,
        variants: [
          { exact: "MODEL_PRIVATE_2", reasoning: undefined, fast: false },
          { exact: "MODEL_PRIVATE_3", reasoning: "thinking", fast: false },
        ],
      },
    ]);
  });

  it("groups Devin Lightning variants as fast model variants", () => {
    const groups = devinAcpModelVariantGroupsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "swe-1-7-lightning",
        options: [
          { value: "swe-1-7", name: "SWE-1.7" },
          { value: "swe-1-7-lightning", name: "SWE-1.7 Lightning" },
        ],
      },
    ]);

    expect(
      groups.map((group) => ({
        id: group.baseModelId,
        name: group.baseModelName,
        current: group.currentVariant?.exactModelId,
        variants: group.variants.map((variant) => ({
          exact: variant.exactModelId,
          fast: variant.fastMode,
        })),
      })),
    ).toEqual([
      {
        id: "swe-1-7",
        name: "SWE-1.7",
        current: "swe-1-7-lightning",
        variants: [
          { exact: "swe-1-7", fast: false },
          { exact: "swe-1-7-lightning", fast: true },
        ],
      },
    ]);
  });

  it("keeps model options selectable when exact ids collide on the same display variant", () => {
    const groups = devinAcpModelVariantGroupsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "MODEL_PRIVATE_2",
        options: [
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5" },
        ],
      },
    ]);

    expect(
      groups.map((group) => ({
        id: group.baseModelId,
        name: group.baseModelName,
        current: group.currentVariant?.exactModelId,
        variants: group.variants.map((variant) => variant.exactModelId),
      })),
    ).toEqual([
      {
        id: "MODEL_PRIVATE_2",
        name: "Claude Sonnet 4.5 (MODEL_PRIVATE_2)",
        current: "MODEL_PRIVATE_2",
        variants: ["MODEL_PRIVATE_2"],
      },
      {
        id: "MODEL_PRIVATE_3",
        name: "Claude Sonnet 4.5 (MODEL_PRIVATE_3)",
        current: undefined,
        variants: ["MODEL_PRIVATE_3"],
      },
    ]);
  });

  it("keeps custom Devin thinking levels grouped and selectable", () => {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5-5-ultra",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-ultra", name: "GPT-5.5 Ultra Thinking" },
        ],
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    const groups = devinAcpModelVariantGroupsFromConfigOptions(configOptions);
    expect(
      groups.map((group) => ({
        id: group.baseModelId,
        name: group.baseModelName,
        current: group.currentVariant?.exactModelId,
        variants: group.variants.map((variant) => ({
          exact: variant.exactModelId,
          reasoning: variant.reasoning,
          label: variant.reasoningLabel,
        })),
      })),
    ).toEqual([
      {
        id: "gpt-5-5",
        name: "GPT-5.5",
        current: "gpt-5-5-ultra",
        variants: [
          { exact: "gpt-5-5-low", reasoning: "low", label: undefined },
          { exact: "gpt-5-5-ultra", reasoning: "ultra", label: "Ultra" },
        ],
      },
    ]);

    const models = buildDevinDiscoveredModelsFromSessionSetup({
      sessionId: "session-1",
      configOptions,
    } satisfies EffectAcpSchema.NewSessionResponse);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoning",
        label: "Thinking",
        type: "select",
        currentValue: "ultra",
        options: [
          { id: "low", label: "Low" },
          { id: "ultra", label: "Ultra", isDefault: true },
        ],
      },
    ]);

    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "gpt-5-5",
        selections: [{ id: "reasoning", value: "ultra" }],
      }),
    ).toBe("gpt-5-5-ultra");
  });

  it("resolves Devin base model options back to exact ACP model ids", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "adaptive",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-high", name: "GPT-5.5 High Thinking" },
          { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ];

    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "gpt-5-5",
        selections: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: true },
        ],
      }),
    ).toBe("gpt-5-5-high-priority");
    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "claude-sonnet-4-5",
        selections: [{ id: "reasoning", value: "thinking" }],
      }),
    ).toBe("MODEL_PRIVATE_3");
  });

  it("resolves base model selections to the ACP current variant when no options are supplied", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5-5-high-priority",
        options: [
          { value: "gpt-5-5-low", name: "GPT-5.5 Low Thinking" },
          { value: "gpt-5-5-high-priority", name: "GPT-5.5 High Thinking Fast" },
        ],
      },
    ];

    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "gpt-5-5",
        selections: [],
      }),
    ).toBe("gpt-5-5-high-priority");
  });

  it("does not arbitrarily resolve ambiguous built-in model aliases", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-sonnet-4",
        options: [
          { value: "claude-sonnet-4", name: "Claude Sonnet 4" },
          { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        ],
      },
    ];

    expect(
      resolveDevinAcpModelSelection({
        configOptions,
        model: "sonnet",
        selections: [],
      }),
    ).toBe("sonnet");
  });

  it("maps exact private ACP model ids to grouped display ids", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "MODEL_PRIVATE_2",
        options: [
          { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
          { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
        ],
      },
    ];

    expect(resolveDevinAcpDisplayModelId(configOptions, "MODEL_PRIVATE_2")).toBe(
      "claude-sonnet-4-5",
    );
  });

  it("derives discovered model slugs from display names when ACP model ids are opaque", () => {
    const models = buildDevinDiscoveredModelsFromSessionSetup({
      sessionId: "session-1",
      configOptions: [],
      models: {
        currentModelId: "MODEL_PRIVATE_3",
        availableModels: [{ modelId: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" }],
      },
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(models).toMatchObject([
      {
        slug: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
    ]);
  });

  it("treats built-in Devin aliases as covering previous discovered concrete slugs", () => {
    expect(
      isDevinAcpModelCoveredByBaseModelIds({
        modelId: "claude-sonnet-4-5",
        modelName: "Claude Sonnet 4.5",
        baseModelIds: new Set(["sonnet"]),
      }),
    ).toBe(true);
  });

  it.effect("switches Devin models through ACP set_config_option", () =>
    Effect.gen(function* () {
      const modelCalls: Array<string> = [];
      const runtime = {
        setModel: (modelId: string) =>
          Effect.sync(() => {
            modelCalls.push(modelId);
          }),
      };

      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "swe-1-6",
        mapError: (cause) => cause.message,
      });

      expect(modelCalls).toEqual(["swe-1-6"]);
      expect(result).toBe("swe-1-6");
    }),
  );

  it.effect("maps Devin model switch failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unsupported model");
      const runtime = {
        setModel: (_modelId: string) => Effect.fail(failure),
      };

      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: "adaptive",
          requestedModelId: "swe-1-6",
          mapError: (cause) => cause.message,
        }),
      );

      expect(error).toBe(failure.message);
    }),
  );

  it.effect("switches normal requested mode to Devin ask mode", () =>
    Effect.gen(function* () {
      const modeCalls: Array<string> = [];
      const runtime = {
        getModeState: Effect.succeed({
          currentModeId: "plan",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "plan", name: "Plan" },
            { id: "bypass", name: "Bypass" },
          ],
        }),
        setMode: (modeId: string) =>
          Effect.sync(() => {
            modeCalls.push(modeId);
            return {};
          }),
      };

      yield* applyDevinRequestedMode({
        runtime,
        runtimeMode: "approval-required",
        interactionMode: undefined,
        mapError: (cause) => cause.message,
      });

      expect(modeCalls).toEqual(["ask"]);
    }),
  );

  it.effect("maps app plan mode to Devin plan mode", () =>
    Effect.gen(function* () {
      const modeCalls: Array<string> = [];
      const runtime = {
        getModeState: Effect.succeed({
          currentModeId: "ask",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "plan", name: "Plan" },
            { id: "architect-mode", name: "Architect Mode" },
            { id: "code", name: "Code" },
          ],
        }),
        setMode: (modeId: string) =>
          Effect.sync(() => {
            modeCalls.push(modeId);
            return {};
          }),
      };

      yield* applyDevinRequestedMode({
        runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
        mapError: (cause) => cause.message,
      });

      expect(modeCalls).toEqual(["plan"]);
    }),
  );

  it.effect("maps full-access runtime mode to Devin bypass mode", () =>
    Effect.gen(function* () {
      const modeCalls: Array<string> = [];
      const runtime = {
        getModeState: Effect.succeed({
          currentModeId: "ask",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "plan", name: "Plan" },
            { id: "bypass", name: "Bypass Permissions" },
            { id: "coding-mode", name: "Code Mode" },
          ],
        }),
        setMode: (modeId: string) =>
          Effect.sync(() => {
            modeCalls.push(modeId);
            return {};
          }),
      };

      yield* applyDevinRequestedMode({
        runtime,
        runtimeMode: "full-access",
        interactionMode: undefined,
        mapError: (cause) => cause.message,
      });

      expect(modeCalls).toEqual(["bypass"]);
    }),
  );
});
