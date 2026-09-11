const assert = require("node:assert/strict");
const test = require("node:test");
const { buildNightly, latestNightly } = require("./sync-fork-nightly.cjs");

test("follows publication time and ignores drafts, stable releases, and invalid tags", () => {
  const nightly = {
    tag_name: "v0.0.41-nightly.20260911.1551",
    published_at: "2026-09-11T16:07:27Z",
    draft: false,
  };
  assert.equal(
    latestNightly([
      { ...nightly, tag_name: "v0.0.42", published_at: "2026-09-11T18:00:00Z" },
      { ...nightly, tag_name: "v0.0.42-nightly.20260911.1552", draft: true },
      {
        ...nightly,
        tag_name: "v0.0.41-nightly.20260911.1547",
        published_at: "2026-09-11T14:32:37Z",
      },
      { ...nightly, tag_name: "../../untrusted-ref", published_at: "2026-09-11T19:00:00Z" },
      nightly,
    ]),
    nightly,
  );
  assert.equal(latestNightly([]), undefined);
});

function pipeline(failures = {}) {
  const events = [];
  const calls = new Map();
  const steps = Object.fromEntries(
    ["merge", "repair", "check", "release"].map((name) => [
      name,
      async () => {
        events.push(name);
        const count = (calls.get(name) ?? 0) + 1;
        calls.set(name, count);
        if (failures[name]?.includes(count)) throw new Error(`${name} failed`);
      },
    ]),
  );
  return { events, steps };
}

test("passing updates publish without starting an agent", async () => {
  const { events, steps } = pipeline();
  await buildNightly(steps);
  assert.deepEqual(events, ["merge", "check", "release"]);
});

test("merge conflicts receive one repair before CI and publication", async () => {
  const { events, steps } = pipeline({ merge: [1] });
  await buildNightly(steps);
  assert.deepEqual(events, ["merge", "repair", "check", "release"]);
});

test("a CI failure is repaired and checked again before any release", async () => {
  const { events, steps } = pipeline({ check: [1] });
  await buildNightly(steps);
  assert.deepEqual(events, ["merge", "check", "repair", "check", "release"]);
});

test("packaging repairs must pass CI again", async () => {
  const { events, steps } = pipeline({ release: [1] });
  await buildNightly(steps);
  assert.deepEqual(events, ["merge", "check", "release", "repair", "check", "release"]);
});

test("a failed repair stops without publishing or retrying the agent", async () => {
  const { events, steps } = pipeline({ check: [1], repair: [1] });
  await assert.rejects(buildNightly(steps), /repair failed/);
  assert.deepEqual(events, ["merge", "check", "repair"]);
});

test("a persistent check failure never reaches publication", async () => {
  const { events, steps } = pipeline({ check: [1, 2] });
  await assert.rejects(buildNightly(steps), /check failed/);
  assert.deepEqual(events, ["merge", "check", "repair", "check"]);
});

test("repair budget is shared across merge, checks, and packaging", async () => {
  const { events, steps } = pipeline({ merge: [1], release: [1] });
  await assert.rejects(buildNightly(steps), /release failed/);
  assert.deepEqual(events, ["merge", "repair", "check", "release"]);
});
