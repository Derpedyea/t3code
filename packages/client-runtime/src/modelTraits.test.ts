import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

function effort(values: ReadonlyArray<string>, currentValue: string): ProviderOptionDescriptor {
  return {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: values.map((id) => ({ id, label: id })),
    currentValue,
  };
}

function reasoningLevel(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: ProviderDriverKind.make("cursor"),
    descriptors,
    primarySelectDescriptorId: "effort",
    ultrathinkPromptControlled: false,
  }).reasoningLevel;
}

describe("buildTraitsTriggerDisplay reasoningLevel", () => {
  it("reads an effort the same however the provider orders or trims its list", () => {
    const claude = reasoningLevel([effort(["low", "medium", "high", "xhigh", "max"], "high")]);
    const grok = reasoningLevel([effort(["xhigh", "high", "medium", "low"], "high")]);
    const glm = reasoningLevel([effort(["high", "max"], "high")]);

    expect(claude).toBeGreaterThan(0);
    expect(grok).toBe(claude);
    expect(glm).toBe(claude);
    expect(reasoningLevel([effort(["high", "max"], "max")])).toBeGreaterThan(claude ?? 1);
  });

  it("has no reading for efforts outside the shared scale", () => {
    for (const value of ["ultrathink", "constructor", "deep"]) {
      expect(reasoningLevel([effort(["low", value], value)])).toBeNull();
    }
  });

  it("reads zero when thinking is switched off", () => {
    const thinking = (currentValue: boolean): ProviderOptionDescriptor => ({
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue,
    });

    expect(reasoningLevel([effort(["low", "high"], "high"), thinking(false)])).toBe(0);
    expect(reasoningLevel([thinking(true)])).toBeNull();
  });
});
