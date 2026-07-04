import {
  type DevinSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
} from "@t3tools/shared/model";

import { buildBooleanOptionDescriptor, buildSelectOptionDescriptor } from "../providerSnapshot.ts";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  findSessionModelConfigOption,
  flattenSessionConfigSelectOptions,
  type AcpSessionConfigSelectOptionValue,
  type AcpSessionModeState,
} from "./AcpRuntimeModel.ts";

const DEVIN_STORED_CREDENTIALS_AUTH_METHOD = "devin-stored-credentials";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath" | "configPath">;

export type DevinAcpReasoningLevel =
  | "standard"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "thinking";

export interface DevinAcpModelVariant {
  readonly exactModelId: string;
  readonly displayName: string;
  readonly baseModelId: string;
  readonly baseModelName: string;
  readonly reasoning?: DevinAcpReasoningLevel;
  readonly fastMode: boolean;
  readonly contextWindow?: string;
}

export interface DevinAcpModelVariantGroup {
  readonly baseModelId: string;
  readonly baseModelName: string;
  readonly variants: ReadonlyArray<DevinAcpModelVariant>;
  readonly currentVariant?: DevinAcpModelVariant;
}

export const DEVIN_REASONING_LEVEL_ORDER: ReadonlyArray<DevinAcpReasoningLevel> = [
  "standard",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
];

export const DEVIN_REASONING_LEVEL_LABELS: Readonly<Record<DevinAcpReasoningLevel, string>> = {
  standard: "Standard",
  none: "No Thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  thinking: "Thinking",
};

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const configPath = devinSettings?.configPath?.trim();
  return {
    command: devinSettings?.binaryPath || "devin",
    args: [...(configPath ? ["--config", configPath] : []), "acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        // Required by the options type but never sent: `skipAuthentication`
        // is set because the Devin CLI reads stored credentials itself.
        authMethodId: DEVIN_STORED_CREDENTIALS_AUTH_METHOD,
        clientCapabilities: {
          elicitation: {
            form: {},
            url: {},
          },
        },
        skipAuthentication: true,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export const discoverDevinModelsViaAcp = (
  devinSettings: DevinAcpRuntimeDevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return buildDevinDiscoveredModelsFromSessionSetup(started.sessionSetupResult);
  }).pipe(Effect.scoped);

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "adaptive";
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? "adaptive";
}

export function devinModelConfigOptionsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<AcpSessionConfigSelectOptionValue> {
  return flattenSessionConfigSelectOptions(
    findSessionModelConfigOption(sessionSetupResult.configOptions),
  );
}

function slugifyDevinBaseModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/gu, "and")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function stripNameSuffix(
  name: string,
  pattern: RegExp,
): { readonly name: string; readonly matched: boolean } {
  const next = name.replace(pattern, "").trim();
  return next === name ? { name, matched: false } : { name: next, matched: true };
}

function parseDevinReasoningSuffix(name: string): {
  readonly baseName: string;
  readonly reasoning: DevinAcpReasoningLevel | undefined;
} {
  const patterns: ReadonlyArray<{
    readonly reasoning: DevinAcpReasoningLevel;
    readonly pattern: RegExp;
  }> = [
    { reasoning: "none", pattern: /\s+No\s+Thinking$/iu },
    { reasoning: "xhigh", pattern: /\s+X[-\s]?High(?:\s+Thinking)?$/iu },
    { reasoning: "minimal", pattern: /\s+Minimal(?:\s+Thinking)?$/iu },
    { reasoning: "low", pattern: /\s+Low(?:\s+Thinking)?$/iu },
    { reasoning: "medium", pattern: /\s+Medium(?:\s+Thinking)?$/iu },
    { reasoning: "high", pattern: /\s+High(?:\s+Thinking)?$/iu },
    { reasoning: "max", pattern: /\s+Max(?:\s+Thinking)?$/iu },
    { reasoning: "thinking", pattern: /\s+Thinking$/iu },
  ];

  for (const entry of patterns) {
    const stripped = stripNameSuffix(name, entry.pattern);
    if (stripped.matched) {
      return { baseName: stripped.name, reasoning: entry.reasoning };
    }
  }
  return { baseName: name.trim(), reasoning: undefined };
}

export function devinReasoningKeyForVariant(variant: DevinAcpModelVariant): DevinAcpReasoningLevel {
  return variant.reasoning ?? "standard";
}

export function devinContextWindowKeyForVariant(variant: DevinAcpModelVariant): string {
  return variant.contextWindow ?? "default";
}

export function parseDevinAcpModelVariant(
  option: AcpSessionConfigSelectOptionValue,
): DevinAcpModelVariant | undefined {
  const exactModelId = option.value.trim();
  let displayName = option.name.trim();
  if (!exactModelId || !displayName) {
    return undefined;
  }

  const fast = stripNameSuffix(displayName, /\s+Fast$/iu);
  displayName = fast.name;
  const context = stripNameSuffix(displayName, /\s+1M$/iu);
  displayName = context.name;
  const { baseName, reasoning } = parseDevinReasoningSuffix(displayName);
  const baseModelName = baseName || option.name.trim() || exactModelId;
  const baseModelId = slugifyDevinBaseModelName(baseModelName) || exactModelId;

  return {
    exactModelId,
    displayName: option.name.trim(),
    baseModelId,
    baseModelName,
    ...(reasoning ? { reasoning } : {}),
    fastMode: fast.matched,
    ...(context.matched ? { contextWindow: "1m" } : {}),
  };
}

export function devinAcpModelVariantsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<DevinAcpModelVariant> {
  return flattenSessionConfigSelectOptions(findSessionModelConfigOption(configOptions))
    .map(parseDevinAcpModelVariant)
    .filter((variant): variant is DevinAcpModelVariant => variant !== undefined);
}

function devinVariantOptionKey(variant: DevinAcpModelVariant): string {
  return [
    devinReasoningKeyForVariant(variant),
    devinContextWindowKeyForVariant(variant),
    variant.fastMode ? "fast" : "normal",
  ].join(":");
}

function ambiguousDevinBaseModelIds(
  variants: ReadonlyArray<DevinAcpModelVariant>,
): ReadonlySet<string> {
  const seenVariantKeys = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  for (const variant of variants) {
    const variantKeys = seenVariantKeys.get(variant.baseModelId) ?? new Set<string>();
    const variantKey = devinVariantOptionKey(variant);
    if (variantKeys.has(variantKey)) {
      ambiguous.add(variant.baseModelId);
    }
    variantKeys.add(variantKey);
    seenVariantKeys.set(variant.baseModelId, variantKeys);
  }
  return ambiguous;
}

export function devinAcpModelVariantGroupsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<DevinAcpModelVariantGroup> {
  const modelConfigOption = findSessionModelConfigOption(configOptions);
  const currentModelId = modelConfigOption?.currentValue?.trim();
  const groups = new Map<
    string,
    { baseModelName: string; variants: Array<DevinAcpModelVariant> }
  >();
  const variants = flattenSessionConfigSelectOptions(modelConfigOption)
    .map(parseDevinAcpModelVariant)
    .filter((variant): variant is DevinAcpModelVariant => variant !== undefined);
  const ambiguousBaseModelIds = ambiguousDevinBaseModelIds(variants);
  for (const variant of variants) {
    const hasAmbiguousBaseModel = ambiguousBaseModelIds.has(variant.baseModelId);
    const groupId = hasAmbiguousBaseModel
      ? resolveDevinAcpBaseModelId(variant.exactModelId)
      : variant.baseModelId;
    const existing = groups.get(groupId);
    if (existing) {
      existing.variants.push(variant);
      continue;
    }
    groups.set(groupId, {
      baseModelName: hasAmbiguousBaseModel
        ? `${variant.displayName} (${variant.exactModelId})`
        : variant.baseModelName,
      variants: [variant],
    });
  }
  return Array.from(groups, ([baseModelId, group]) => {
    const currentVariant = currentModelId
      ? group.variants.find((variant) => variant.exactModelId === currentModelId)
      : undefined;
    return {
      baseModelId,
      baseModelName: group.baseModelName,
      variants: group.variants,
      ...(currentVariant ? { currentVariant } : {}),
    };
  });
}

function normalizeDevinReasoningSelection(
  value: string | null | undefined,
): DevinAcpReasoningLevel | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "-");
  switch (normalized) {
    case "standard":
    case "default":
      return "standard";
    case "none":
    case "no-thinking":
      return "none";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "x-high":
    case "extra-high":
      return "xhigh";
    case "max":
      return "max";
    case "thinking":
      return "thinking";
    default:
      return undefined;
  }
}

function modelAliasMatchesDevinBaseModelId(requestedModel: string, baseModelId: string): boolean {
  switch (requestedModel) {
    case "opus":
      return baseModelId.startsWith("claude-opus-");
    case "sonnet":
      return baseModelId.startsWith("claude-sonnet-");
    case "swe":
      return baseModelId.startsWith("swe-");
    case "codex":
      return baseModelId.includes("codex");
    case "gemini":
      return baseModelId.startsWith("gemini-");
    default:
      return false;
  }
}

function modelAliasMatchesDevinGroup(
  requestedModel: string,
  group: DevinAcpModelVariantGroup,
): boolean {
  return modelAliasMatchesDevinBaseModelId(requestedModel, group.baseModelId);
}

export function isDevinAcpModelCoveredByBaseModelIds(input: {
  readonly modelId: string | null | undefined;
  readonly modelName: string | null | undefined;
  readonly baseModelIds: ReadonlySet<string>;
}): boolean {
  const requestedModel = resolveDevinAcpBaseModelId(input.modelId);
  if (
    [...input.baseModelIds].some(
      (baseModelId) =>
        modelAliasMatchesDevinBaseModelId(requestedModel, baseModelId) ||
        modelAliasMatchesDevinBaseModelId(baseModelId, requestedModel),
    )
  ) {
    return true;
  }

  const variant = parseDevinAcpModelVariant({
    value: requestedModel,
    name: input.modelName?.trim() || requestedModel,
  });
  return (
    variant !== undefined &&
    variant.baseModelId !== requestedModel &&
    input.baseModelIds.has(variant.baseModelId)
  );
}

function findDevinVariantGroup(
  groups: ReadonlyArray<DevinAcpModelVariantGroup>,
  model: string,
): DevinAcpModelVariantGroup | undefined {
  const requestedModel = model.trim();
  if (!requestedModel) {
    return undefined;
  }
  return (
    groups.find((group) => group.baseModelId === requestedModel) ??
    groups.find((group) =>
      group.variants.some((variant) => variant.exactModelId === requestedModel),
    ) ??
    findUniqueDevinAliasGroup(groups, requestedModel)
  );
}

function findUniqueDevinAliasGroup(
  groups: ReadonlyArray<DevinAcpModelVariantGroup>,
  requestedModel: string,
): DevinAcpModelVariantGroup | undefined {
  const matches = groups.filter((group) => modelAliasMatchesDevinGroup(requestedModel, group));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Every filter below is guarded by a `.some(...)` check against a non-empty
 * variant list, so `candidates` always stays non-empty.
 */
function selectPreferredDevinVariant(input: {
  readonly group: DevinAcpModelVariantGroup;
  readonly requestedExactModelId: string | undefined;
  readonly requestedReasoning: DevinAcpReasoningLevel | undefined;
  readonly requestedFastMode: boolean | undefined;
  readonly requestedContextWindow: string | undefined;
}): DevinAcpModelVariant {
  const exactRequested =
    input.group.variants.find((variant) => variant.exactModelId === input.requestedExactModelId) ??
    input.group.currentVariant;
  let candidates = input.group.variants;

  const desiredReasoning =
    input.requestedReasoning ??
    (exactRequested ? devinReasoningKeyForVariant(exactRequested) : undefined);
  if (
    desiredReasoning &&
    candidates.some((variant) => devinReasoningKeyForVariant(variant) === desiredReasoning)
  ) {
    candidates = candidates.filter(
      (variant) => devinReasoningKeyForVariant(variant) === desiredReasoning,
    );
  }

  const desiredContext =
    input.requestedContextWindow ??
    (exactRequested ? devinContextWindowKeyForVariant(exactRequested) : undefined);
  if (
    desiredContext &&
    candidates.some((variant) => devinContextWindowKeyForVariant(variant) === desiredContext)
  ) {
    candidates = candidates.filter(
      (variant) => devinContextWindowKeyForVariant(variant) === desiredContext,
    );
  }

  const desiredFastMode =
    input.requestedFastMode ?? (exactRequested ? exactRequested.fastMode : undefined);
  if (
    typeof desiredFastMode === "boolean" &&
    candidates.some((variant) => variant.fastMode === desiredFastMode)
  ) {
    candidates = candidates.filter((variant) => variant.fastMode === desiredFastMode);
  } else if (candidates.some((variant) => !variant.fastMode)) {
    candidates = candidates.filter((variant) => !variant.fastMode);
  }

  return candidates[0]!;
}

export function resolveDevinAcpModelSelection(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): string {
  const rawRequestedModel = input.model?.trim();
  const requestedModel = resolveDevinAcpBaseModelId(input.model);
  const groups = devinAcpModelVariantGroupsFromConfigOptions(input.configOptions);
  const group =
    (rawRequestedModel ? findDevinVariantGroup(groups, rawRequestedModel) : undefined) ??
    findDevinVariantGroup(groups, requestedModel);
  if (!group) {
    return requestedModel;
  }

  return selectPreferredDevinVariant({
    group,
    requestedExactModelId: rawRequestedModel ?? requestedModel,
    requestedReasoning: normalizeDevinReasoningSelection(
      getProviderOptionStringSelectionValue(input.selections, "reasoning"),
    ),
    requestedFastMode: getProviderOptionBooleanSelectionValue(input.selections, "fastMode"),
    requestedContextWindow: getProviderOptionStringSelectionValue(
      input.selections,
      "contextWindow",
    ),
  }).exactModelId;
}

export function resolveDevinAcpDisplayModelId(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  model: string | null | undefined,
): string {
  const groups = devinAcpModelVariantGroupsFromConfigOptions(configOptions);
  const rawModel = model?.trim();
  if (rawModel) {
    const exactGroup = groups.find((group) =>
      group.variants.some((variant) => variant.exactModelId === rawModel),
    );
    if (exactGroup) {
      return exactGroup.baseModelId;
    }
  }
  const resolvedModel = resolveDevinAcpBaseModelId(model);
  const group = findDevinVariantGroup(groups, resolvedModel);
  return group?.baseModelId ?? resolvedModel;
}

export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const configModelId = findSessionModelConfigOption(
    sessionSetupResult.configOptions,
  )?.currentValue;
  return configModelId?.trim() || sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

function normalizeModeToken(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, "-");
}

function findModeId(
  modeState: AcpSessionModeState | undefined,
  aliases: ReadonlyArray<string>,
): string | undefined {
  if (!modeState) {
    return undefined;
  }
  const normalizedAliases = new Set(aliases.map(normalizeModeToken));
  for (const mode of modeState.availableModes) {
    const id = normalizeModeToken(mode.id);
    const name = normalizeModeToken(mode.name);
    if (normalizedAliases.has(id) || normalizedAliases.has(name)) {
      return mode.id;
    }
  }
  return undefined;
}

export function applyDevinRequestedMode<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getModeState" | "setMode"
  >;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const aliases =
    input.interactionMode === "plan"
      ? ["plan"]
      : input.runtimeMode === "full-access"
        ? ["bypass", "bypass-permissions", "bypasspermissions", "danger-full-access"]
        : input.runtimeMode === "auto-accept-edits"
          ? ["accept-edits", "acceptedits", "accept-edits-mode"]
          : ["ask", "normal", "default"];

  return input.runtime.getModeState.pipe(
    Effect.flatMap((modeState) => {
      const modeId = findModeId(modeState, aliases);
      return modeId ? input.runtime.setMode(modeId).pipe(Effect.asVoid) : Effect.void;
    }),
    Effect.mapError(input.mapError),
  );
}

function buildDevinDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const variant = parseDevinAcpModelVariant({
        value: model.modelId,
        name: model.name,
      });
      const slug = variant?.baseModelId ?? resolveDevinAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: (variant?.baseModelName ?? model.name.trim()) || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

function uniqueSortedDevinReasoningLevels(group: DevinAcpModelVariantGroup) {
  const levels = new Set(group.variants.map(devinReasoningKeyForVariant));
  return DEVIN_REASONING_LEVEL_ORDER.filter((level) => levels.has(level));
}

function buildDevinCapabilitiesForVariantGroup(group: DevinAcpModelVariantGroup) {
  const defaultVariant = group.currentVariant ?? group.variants[0];
  const reasoningLevels = uniqueSortedDevinReasoningLevels(group);
  const contextWindows = Array.from(new Set(group.variants.map(devinContextWindowKeyForVariant)));
  const hasFastVariants = group.variants.some((variant) => variant.fastMode);
  const hasNormalSpeedVariants = group.variants.some((variant) => !variant.fastMode);

  const optionDescriptors = [
    ...(reasoningLevels.length > 1 && defaultVariant
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: "Thinking",
            options: reasoningLevels.map((level) => ({
              value: level,
              label: DEVIN_REASONING_LEVEL_LABELS[level],
              ...(devinReasoningKeyForVariant(defaultVariant) === level ? { isDefault: true } : {}),
            })),
          }),
        ]
      : []),
    ...(contextWindows.length > 1 && defaultVariant
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: "Context Window",
            options: contextWindows
              .sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)))
              .map((contextWindow) => ({
                value: contextWindow,
                label: contextWindow === "default" ? "Default" : contextWindow.toUpperCase(),
                ...(devinContextWindowKeyForVariant(defaultVariant) === contextWindow
                  ? { isDefault: true }
                  : {}),
              })),
          }),
        ]
      : []),
    ...(hasFastVariants && hasNormalSpeedVariants
      ? [
          buildBooleanOptionDescriptor({
            id: "fastMode",
            label: "Fast Mode",
            currentValue: defaultVariant?.fastMode === true,
          }),
        ]
      : []),
  ];

  return createModelCapabilities({ optionDescriptors });
}

function buildDevinDiscoveredModelsFromConfigOptions(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const groups = devinAcpModelVariantGroupsFromConfigOptions(sessionSetupResult.configOptions);
  if (groups.length > 0) {
    return groups
      .map((group): ServerProviderModel | undefined => {
        const slug = group.baseModelId.trim();
        if (!slug || seen.has(slug)) {
          return undefined;
        }
        seen.add(slug);
        return {
          slug,
          name: group.baseModelName.trim() || slug,
          isCustom: false,
          capabilities: buildDevinCapabilitiesForVariantGroup(group),
        };
      })
      .filter((model): model is ServerProviderModel => model !== undefined);
  }

  return devinModelConfigOptionsFromSessionSetup(sessionSetupResult)
    .map((option): ServerProviderModel | undefined => {
      const slug = option.value.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: option.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export function buildDevinDiscoveredModelsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<ServerProviderModel> {
  const configModels = buildDevinDiscoveredModelsFromConfigOptions(sessionSetupResult);
  return configModels.length > 0
    ? configModels
    : buildDevinDiscoveredModelsFromSessionModelState(sessionSetupResult.models);
}
