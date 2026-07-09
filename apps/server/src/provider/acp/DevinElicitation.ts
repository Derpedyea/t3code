import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

function trimmedString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function optionDescription(label: string, fallback: string | undefined): string {
  return trimmedString(fallback) ?? label;
}

function uniqueOptionLabel(label: string, value: string, seenLabels: Set<string>): string {
  if (!seenLabels.has(label)) {
    seenLabels.add(label);
    return label;
  }
  let suffix = 2;
  let candidate = `${label} (${value})`;
  while (seenLabels.has(candidate)) {
    candidate = `${label} (${value}) #${suffix}`;
    suffix += 1;
  }
  seenLabels.add(candidate);
  return candidate;
}

function enumOptionMaps(entries: ReadonlyArray<EffectAcpSchema.EnumOption>): {
  readonly options: UserInputQuestion["options"];
  readonly valuesByLabel: ReadonlyMap<string, string>;
  readonly allowedValues: ReadonlySet<string>;
} {
  const valuesByLabel = new Map<string, string>();
  const allowedValues = new Set<string>();
  const seenLabels = new Set<string>();
  const options = entries.flatMap((entry) => {
    const value = trimmedString(entry.const);
    const title = trimmedString(entry.title);
    if (!value) {
      return [];
    }
    const constLooksLikeDisplayLabel =
      title !== undefined &&
      title !== value &&
      !/^[a-z0-9_.:-]+$/u.test(value) &&
      (/[.!?]$/u.test(title) || title.length > value.length + 12);
    const baseLabel = constLooksLikeDisplayLabel ? value : (title ?? value);
    if (!baseLabel) {
      return [];
    }
    allowedValues.add(value);
    const label = uniqueOptionLabel(baseLabel, value, seenLabels);
    // Only labels are mapped here; raw values resolve through `allowedValues`
    // so a value that collides with another option's label cannot shadow it.
    valuesByLabel.set(label, value);
    return [
      {
        label,
        description: optionDescription(label, constLooksLikeDisplayLabel ? title : value),
      },
    ];
  });
  return { options, valuesByLabel, allowedValues };
}

function stringEnumOptionMaps(values: ReadonlyArray<string>): {
  readonly options: UserInputQuestion["options"];
  readonly valuesByLabel: ReadonlyMap<string, string>;
  readonly allowedValues: ReadonlySet<string>;
} {
  const valuesByLabel = new Map<string, string>();
  const allowedValues = new Set<string>();
  const seenLabels = new Set<string>();
  const options = values.flatMap((entry) => {
    const value = trimmedString(entry);
    if (!value) {
      return [];
    }
    allowedValues.add(value);
    const label = uniqueOptionLabel(value, value, seenLabels);
    valuesByLabel.set(label, value);
    return [{ label, description: label }];
  });
  return { options, valuesByLabel, allowedValues };
}

function answerStrings(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const value = typeof entry === "string" ? trimmedString(entry) : undefined;
      return value ? [value] : [];
    });
  }
  if (typeof answer !== "string") {
    return [];
  }
  const value = trimmedString(answer);
  return value ? [value] : [];
}

function resolveChoiceValue(
  value: string,
  valuesByLabel: ReadonlyMap<string, string>,
  allowedValues: ReadonlySet<string>,
): string | undefined {
  const mapped = valuesByLabel.get(value);
  if (mapped !== undefined) {
    return mapped;
  }
  return allowedValues.has(value) ? value : undefined;
}

function normalizeStringAnswer(
  answer: unknown,
  valuesByLabel: ReadonlyMap<string, string>,
  allowedValues: ReadonlySet<string>,
  fallback: string | null | undefined,
  allowOther: boolean,
): string | undefined {
  const value = answerStrings(answer)[0] ?? trimmedString(fallback);
  if (!value) {
    return undefined;
  }
  if (allowedValues.size === 0) {
    return value;
  }
  return (
    resolveChoiceValue(value, valuesByLabel, allowedValues) ?? (allowOther ? value : undefined)
  );
}

function normalizeStringArrayAnswer(
  answer: unknown,
  valuesByLabel: ReadonlyMap<string, string>,
  allowedValues: ReadonlySet<string>,
  fallback: ReadonlyArray<string> | null | undefined,
  allowOther: boolean,
): ReadonlyArray<string> | undefined {
  const values = Array.isArray(answer)
    ? answerStrings(answer)
    : typeof answer === "string"
      ? answer
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : (fallback ?? []).flatMap((entry) => {
          const value = trimmedString(entry);
          return value ? [value] : [];
        });
  if (values.length === 0) {
    return undefined;
  }
  if (allowedValues.size === 0) {
    return values;
  }
  const normalized: Array<string> = [];
  for (const value of values) {
    const resolved = resolveChoiceValue(value, valuesByLabel, allowedValues);
    if (!resolved && !allowOther) {
      return undefined;
    }
    normalized.push(resolved ?? value);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNumberAnswer(
  answer: unknown,
  fallback: number | null | undefined,
  integer: boolean,
): number | undefined {
  // An empty string is "no answer" and must fall back to the default instead
  // of Number("") === 0.
  const trimmedAnswer = typeof answer === "string" ? trimmedString(answer) : undefined;
  const value =
    typeof answer === "number"
      ? answer
      : trimmedAnswer !== undefined
        ? Number(trimmedAnswer)
        : fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (integer && !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

function normalizeBooleanAnswer(
  answer: unknown,
  fallback: boolean | null | undefined,
): boolean | undefined {
  if (typeof answer === "boolean") {
    return answer;
  }
  if (typeof answer === "string") {
    const normalized = answer.trim().toLowerCase();
    if (normalized === "yes" || normalized === "true") {
      return true;
    }
    if (normalized === "no" || normalized === "false") {
      return false;
    }
  }
  return typeof fallback === "boolean" ? fallback : undefined;
}

interface DevinElicitationQuestionMapping {
  readonly id: string;
  readonly question: UserInputQuestion;
  readonly toContentValue: (answer: unknown) => EffectAcpSchema.ElicitationContentValue | undefined;
}

export interface DevinElicitationPrompt {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly makeResponse: (answers: ProviderUserInputAnswers) => EffectAcpSchema.ElicitationResponse;
}

function devinElicitationAllowsOther(request: EffectAcpSchema.ElicitationRequest): boolean {
  const meta = request._meta;
  return typeof meta === "object" && meta !== null && meta["cognition.ai/allowOther"] === true;
}

function makeDevinElicitationQuestion(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
  id: string,
  property: EffectAcpSchema.ElicitationPropertySchema,
  required: boolean,
): DevinElicitationQuestionMapping | undefined {
  const schema = request.requestedSchema;
  const header = trimmedString(schema.title) ?? "Question";
  const title = trimmedString(property.title) ?? id;
  const question = trimmedString(property.description) ?? title;
  const allowOther = devinElicitationAllowsOther(request);

  switch (property.type) {
    case "string": {
      const mappedOptions =
        property.oneOf && property.oneOf.length > 0
          ? enumOptionMaps(property.oneOf)
          : property.enum && property.enum.length > 0
            ? stringEnumOptionMaps(property.enum)
            : {
                options: [],
                valuesByLabel: new Map<string, string>(),
                allowedValues: new Set<string>(),
              };
      return {
        id,
        question: {
          id,
          header,
          question,
          options: mappedOptions.options,
          required,
          multiSelect: false,
        },
        toContentValue: (answer) =>
          normalizeStringAnswer(
            answer,
            mappedOptions.valuesByLabel,
            mappedOptions.allowedValues,
            property.default,
            allowOther,
          ),
      };
    }
    case "number":
    case "integer":
      return {
        id,
        question: {
          id,
          header,
          question,
          options: [],
          required,
          multiSelect: false,
        },
        toContentValue: (answer) =>
          normalizeNumberAnswer(answer, property.default, property.type === "integer"),
      };
    case "boolean":
      return {
        id,
        question: {
          id,
          header,
          question,
          options: [
            { label: "Yes", description: "True" },
            { label: "No", description: "False" },
          ],
          required,
          multiSelect: false,
        },
        toContentValue: (answer) => normalizeBooleanAnswer(answer, property.default),
      };
    case "array": {
      const mappedOptions =
        "anyOf" in property.items
          ? enumOptionMaps(property.items.anyOf)
          : stringEnumOptionMaps(property.items.enum);
      return {
        id,
        question: {
          id,
          header,
          question,
          options: mappedOptions.options,
          required,
          multiSelect: true,
        },
        toContentValue: (answer) =>
          normalizeStringArrayAnswer(
            answer,
            mappedOptions.valuesByLabel,
            mappedOptions.allowedValues,
            property.default,
            allowOther,
          ),
      };
    }
  }
}

function makeDevinFormElicitationPrompt(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
): DevinElicitationPrompt {
  const properties = request.requestedSchema.properties ?? {};
  const required = new Set(request.requestedSchema.required ?? []);
  const mappings = Object.entries(properties).flatMap(([id, property]) => {
    const mapping = makeDevinElicitationQuestion(request, id, property, required.has(id));
    return mapping ? [mapping] : [];
  });

  if (mappings.length === 0) {
    const id = "__devin_elicitation_continue";
    const question = {
      id,
      header: trimmedString(request.requestedSchema.title) ?? "Question",
      question: trimmedString(request.message) ?? "Continue?",
      options: [{ label: "Continue", description: "Continue" }],
      required: true,
      multiSelect: false,
    } satisfies UserInputQuestion;
    return {
      questions: [question],
      makeResponse: () => ({ action: { action: "accept" } }),
    };
  }

  return {
    questions: mappings.map((mapping) => mapping.question),
    makeResponse: (answers) => {
      const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
      for (const mapping of mappings) {
        const value = mapping.toContentValue(answers[mapping.id]);
        if (value === undefined) {
          if (required.has(mapping.id)) {
            return { action: { action: "decline" } };
          }
          continue;
        }
        content[mapping.id] = value;
      }
      return {
        action: {
          action: "accept",
          ...(Object.keys(content).length > 0 ? { content } : {}),
        },
      };
    },
  };
}

function makeDevinUrlElicitationPrompt(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "url" }>,
): DevinElicitationPrompt {
  const id = "__devin_elicitation_url";
  return {
    questions: [
      {
        id,
        header: "Devin",
        question: `${request.message}\n${request.url}`,
        options: [
          { label: "Done", description: "Continue after completing the request" },
          { label: "Cancel", description: "Cancel this request" },
        ],
        required: true,
        multiSelect: false,
      },
    ],
    makeResponse: (answers) => {
      const answer = normalizeStringAnswer(answers[id], new Map(), new Set(), undefined, true);
      if (answer === "Done") {
        return { action: { action: "accept" } };
      }
      if (answer === "Cancel") {
        return { action: { action: "cancel" } };
      }
      return { action: { action: "decline" } };
    },
  };
}

export function makeDevinElicitationPrompt(
  request: EffectAcpSchema.ElicitationRequest,
): DevinElicitationPrompt {
  return request.mode === "form"
    ? makeDevinFormElicitationPrompt(request)
    : makeDevinUrlElicitationPrompt(request);
}
