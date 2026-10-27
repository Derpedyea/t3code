import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

function highEffortLevel(efforts: ReadonlyArray<string>, thinking?: boolean) {
  const descriptors: Array<ProviderOptionDescriptor> = [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: efforts.map((id) => ({ id, label: id })),
      currentValue: "high",
    },
  ];
  if (thinking !== undefined) {
    descriptors.push({
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: thinking,
    });
  }
  return buildTraitsTriggerDisplay({
    provider: ProviderDriverKind.make("cursor"),
    descriptors,
    primarySelectDescriptorId: "effort",
    ultrathinkPromptControlled: false,
  }).reasoningLevel;
}

describe("buildTraitsTriggerDisplay reasoningLevel", () => {
  it("reads High the same however the provider orders or trims its efforts", () => {
    const claude = highEffortLevel(["low", "medium", "high", "xhigh", "max"]);
    expect(claude).toBeGreaterThan(0);
    expect(highEffortLevel(["xhigh", "high", "medium", "low"])).toBe(claude);
    expect(highEffortLevel(["high", "max"])).toBe(claude);
  });

  it("reads zero when thinking is switched off", () => {
    expect(highEffortLevel(["low", "high"], false)).toBe(0);
  });
});
