const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildNightly,
  latestNightly,
  publishedNightly,
  startWorkflow,
} = require("./sync-fork-nightly.cjs");

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
  const { events, steps } = pipeline({ check: [1, 2, 3, 4] });
  await assert.rejects(buildNightly(steps), /check failed/);
  assert.deepEqual(events, [
    "merge",
    "check",
    "repair",
    "check",
    "repair",
    "check",
    "repair",
    "check",
  ]);
});

test("merge repair does not prevent later CI and packaging repairs", async () => {
  const { events, steps } = pipeline({ merge: [1], check: [1], release: [1] });
  await buildNightly(steps);
  assert.deepEqual(events, [
    "merge",
    "repair",
    "check",
    "repair",
    "check",
    "release",
    "repair",
    "check",
    "release",
  ]);
});

test("only a published release completes a nightly; failed attempts and drafts remain retryable", () => {
  const tag = "v0.0.41-nightly.20260912.1599";
  const release = {
    draft: false,
    published_at: "2026-09-12T13:00:00Z",
    body: `Upstream nightly: \`${tag}\``,
  };
  assert.equal(publishedNightly([], tag), false);
  assert.equal(publishedNightly([{ ...release, draft: true }], tag), false);
  assert.equal(publishedNightly([{ ...release, published_at: null }], tag), false);
  assert.equal(publishedNightly([release], "v0.0.41-nightly.20260912.1576"), false);
  assert.equal(publishedNightly([release], tag), true);
});

test("repaired commits dispatch on distinct refs and wait through delayed run visibility", async () => {
  const refs = [];
  for (const sha of ["old-commit", "repaired-commit"]) {
    let polls = 0;
    const run = await startWorkflow({
      branch: "fork/nightly-123-1",
      sha,
      publish: (ref) => refs.push(ref),
      dispatch: (ref) => assert.equal(ref, refs.at(-1)),
      listRuns: () => (++polls === 1 ? [] : [{ head_sha: sha, id: sha }]),
      sleep: async () => {},
    });
    assert.equal(run.id, sha);
  }
  assert.equal(new Set(refs).size, 2);
});

test("a workflow for a different commit is never accepted", async () => {
  await assert.rejects(
    startWorkflow({
      branch: "fork/nightly-123-1",
      sha: "repaired-commit",
      publish: () => {},
      dispatch: () => {},
      listRuns: () => [{ head_sha: "old-commit" }],
      sleep: async () => {},
    }),
    /did not start/,
  );
});

test("dispatch visibility failures wait for the next schedule without asking AI to change code", async () => {
  const { steps, events } = pipeline();
  steps.check = () =>
    startWorkflow({
      branch: "fork/nightly-123-1",
      sha: "commit",
      publish: () => {},
      dispatch: () => {},
      listRuns: () => [],
      sleep: async () => {},
    });
  await assert.rejects(buildNightly(steps), /did not start/);
  assert.deepEqual(events, ["merge"]);
});
