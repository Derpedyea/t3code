import { describe, expect, it, vi } from "vite-plus/test";

describe("zz debug shiki determinism", () => {
  it("compares source vs snippet across fresh module states", async () => {
    const source = "const answer: number = 42;";
    let mismatches = 0;
    for (let i = 0; i < 30; i += 1) {
      vi.resetModules();
      const highlighter = await import("./shikiReviewHighlighter");
      const highlighted = await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme: "dark",
      });
      const snippet = await highlighter.highlightCodeSnippet({
        code: source,
        language: "ts",
        theme: "dark",
      });
      if (JSON.stringify(snippet) !== JSON.stringify(highlighted)) {
        mismatches += 1;
        // eslint-disable-next-line no-console
        console.log(
          `MISMATCH iter ${i}:\nsource=${JSON.stringify(highlighted)}\nsnippet=${JSON.stringify(snippet)}`,
        );
      }
      // Interleave a light-theme call to simulate suite pollution.
      await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme: "light",
      });
    }
    expect(mismatches).toBe(0);
  });
});
