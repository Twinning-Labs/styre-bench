import { describe, expect, test } from "bun:test";
import { abReview, buildAbPrompt, chooseOrder, mapChoiceToPreference } from "../reviewer/ab-review";
import { blindQuality, buildBlindQualityPrompt } from "../reviewer/blind-quality";
import type { ModelClient } from "../reviewer/model-client";

const ISSUE = "widget.compute() raises a KeyError on a negative offset.";

// NOTE: these markers deliberately avoid the forbidden label-neutrality words ("styre",
// "human", "accepted", "gold", "reference") — this fixture content flows verbatim into the
// assembled A/B prompt, so it must not itself trip the label-neutrality assertions below
// (those check the PROMPT TEMPLATE reveals no provenance, not that diff content is scrubbed).
const STYRE_DIFF = [
  "diff --git a/widget/core.py b/widget/core.py",
  "+CANDIDATE_ONE_MARKER_fix_negative_offset",
].join("\n");

const PLAN_DOC_BLOCK = [
  "diff --git a/docs/plans/2026-01-01-fix.md b/docs/plans/2026-01-01-fix.md",
  "+PLAN_DOC_MARKER should never reach the reviewer prompt",
].join("\n");

const STYRE_DIFF_WITH_PLAN = [STYRE_DIFF, PLAN_DOC_BLOCK].join("\n");

const FIX_PATCH = [
  "diff --git a/widget/core.py b/widget/core.py",
  "+CANDIDATE_TWO_MARKER_fix_negative_offset",
].join("\n");

/** Mock ModelClient that records the last prompt it was called with and returns a fixed
 *  response — lets tests assert on prompt assembly without any live model call. */
function makeMockClient(response: string): { client: ModelClient; lastPrompt: () => string } {
  let lastPrompt = "";
  const client: ModelClient = {
    async complete(prompt: string): Promise<string> {
      lastPrompt = prompt;
      return response;
    },
  };
  return { client, lastPrompt: () => lastPrompt };
}

describe("buildBlindQualityPrompt (pure)", () => {
  test("contains the issue and styre's diff", () => {
    const prompt = buildBlindQualityPrompt(ISSUE, STYRE_DIFF);
    expect(prompt).toContain(ISSUE);
    expect(prompt).toContain(STYRE_DIFF);
  });

  test("does NOT contain fixPatch content (structural: the function takes no such input)", () => {
    const prompt = buildBlindQualityPrompt(ISSUE, STYRE_DIFF);
    expect(prompt).not.toContain("CANDIDATE_TWO_MARKER_fix_negative_offset");
    expect(prompt).not.toContain(FIX_PATCH);
  });
});

describe("blindQuality (wiring — mock model client)", () => {
  test("the prompt sent to the model contains the issue + styre diff, and never fixPatch", async () => {
    const { client, lastPrompt } = makeMockClient(
      '{"verdict": "addresses-issue", "notes": "looks right"}',
    );
    const result = await blindQuality(ISSUE, STYRE_DIFF, { client });

    expect(lastPrompt()).toContain(ISSUE);
    expect(lastPrompt()).toContain(STYRE_DIFF);
    expect(lastPrompt()).not.toContain("CANDIDATE_TWO_MARKER_fix_negative_offset");
    expect(result).toEqual({ verdict: "addresses-issue", notes: "looks right" });
  });

  test("falls back to notes=raw text when the model response isn't valid JSON", async () => {
    const { client } = makeMockClient("This looks like a reasonable fix.");
    const result = await blindQuality(ISSUE, STYRE_DIFF, { client });
    expect(result.notes).toBe("This looks like a reasonable fix.");
    expect(typeof result.verdict).toBe("string");
  });
});

// Two instance ids that, at runSeed=1, land on opposite sides of chooseOrder's parity split
// (verified directly against the djb2-hash implementation) -- used below wherever a test
// needs one concrete styre-first case and one concrete human-first case.
const INSTANCE_STYRE_FIRST = "instance-A"; // chooseOrder(_, 1) -> { first: "styre", second: "human" }
const INSTANCE_HUMAN_FIRST = "instance-B"; // chooseOrder(_, 1) -> { first: "human", second: "styre" }
const RUN_SEED = 1;

describe("chooseOrder (pure — (instanceId, runSeed) -> candidate ordering)", () => {
  test("determinism: same instanceId + runSeed always produces the same order", () => {
    expect(chooseOrder("instance-42", 7)).toEqual(chooseOrder("instance-42", 7));
    expect(chooseOrder("instance-42", 7)).toEqual({ first: "human", second: "styre" });
  });

  test("the exact bug scenario: over many distinct instance ids at ONE fixed runSeed " +
    "(the run-global cfg.seed, e.g. the documented default 42), BOTH positions occur " +
    "-- a fixed seed must never pin styre to one side for every instance", () => {
    const runSeed = 42;
    const orders = Array.from({ length: 50 }, (_, i) => chooseOrder(`instance-${i}`, runSeed));
    const styreFirstCount = orders.filter((o) => o.first === "styre").length;
    expect(styreFirstCount).toBeGreaterThan(0);
    expect(styreFirstCount).toBeLessThan(orders.length);
  });

  test("distinct instance ids at the same runSeed can land on opposite sides", () => {
    expect(chooseOrder(INSTANCE_STYRE_FIRST, RUN_SEED)).toEqual({
      first: "styre",
      second: "human",
    });
    expect(chooseOrder(INSTANCE_HUMAN_FIRST, RUN_SEED)).toEqual({
      first: "human",
      second: "styre",
    });
  });
});

describe("mapChoiceToPreference (pure — A/B/tie/invalid choice -> styre/human, independent of position)", () => {
  test("styre-first order: choosing A means styre; choosing B means human", () => {
    const order = chooseOrder(INSTANCE_STYRE_FIRST, RUN_SEED);
    expect(mapChoiceToPreference("A", order)).toBe("A(styre)");
    expect(mapChoiceToPreference("B", order)).toBe("B(human)");
  });

  test("human-first order: choosing A means human; choosing B means styre — same literal choice maps to the OPPOSITE identity", () => {
    const order = chooseOrder(INSTANCE_HUMAN_FIRST, RUN_SEED);
    expect(mapChoiceToPreference("A", order)).toBe("B(human)");
    expect(mapChoiceToPreference("B", order)).toBe("A(styre)");
  });

  test("tie maps to tie regardless of order", () => {
    expect(mapChoiceToPreference("tie", chooseOrder(INSTANCE_STYRE_FIRST, RUN_SEED))).toBe("tie");
    expect(mapChoiceToPreference("tie", chooseOrder(INSTANCE_HUMAN_FIRST, RUN_SEED))).toBe("tie");
  });

  test("invalid passes through unchanged regardless of order (no position to resolve it against)", () => {
    expect(mapChoiceToPreference("invalid", chooseOrder(INSTANCE_STYRE_FIRST, RUN_SEED))).toBe(
      "invalid",
    );
    expect(mapChoiceToPreference("invalid", chooseOrder(INSTANCE_HUMAN_FIRST, RUN_SEED))).toBe(
      "invalid",
    );
  });
});

describe("buildAbPrompt (pure — (instanceId, runSeed)-ordered, label-neutral)", () => {
  test("styre-first instance: candidate A section carries styre's marker, candidate B carries the other diff's marker, in that order", () => {
    const prompt = buildAbPrompt(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_STYRE_FIRST, RUN_SEED);
    const idxA = prompt.indexOf("Candidate A");
    const idxStyreMarker = prompt.indexOf("CANDIDATE_ONE_MARKER");
    const idxB = prompt.indexOf("Candidate B");
    const idxOtherMarker = prompt.indexOf("CANDIDATE_TWO_MARKER");

    expect(idxA).toBeGreaterThan(-1);
    expect(idxStyreMarker).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxStyreMarker);
    expect(idxOtherMarker).toBeGreaterThan(idxB);
  });

  test("human-first instance (same runSeed): the ordering FLIPS — candidate A now carries the other diff's marker, candidate B carries styre's", () => {
    const prompt = buildAbPrompt(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_HUMAN_FIRST, RUN_SEED);
    const idxA = prompt.indexOf("Candidate A");
    const idxOtherMarker = prompt.indexOf("CANDIDATE_TWO_MARKER");
    const idxB = prompt.indexOf("Candidate B");
    const idxStyreMarker = prompt.indexOf("CANDIDATE_ONE_MARKER");

    expect(idxA).toBeGreaterThan(-1);
    expect(idxOtherMarker).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxOtherMarker);
    expect(idxStyreMarker).toBeGreaterThan(idxB);
  });

  test("strips docs/plans/ content out of styre's diff before assembly", () => {
    const prompt = buildAbPrompt(
      ISSUE,
      STYRE_DIFF_WITH_PLAN,
      FIX_PATCH,
      INSTANCE_STYRE_FIRST,
      RUN_SEED,
    );
    expect(prompt).not.toContain("PLAN_DOC_MARKER");
    expect(prompt).not.toContain("docs/plans/");
    // the real fix content must still be present
    expect(prompt).toContain("CANDIDATE_ONE_MARKER");
  });

  test("label-neutrality: the assembled prompt reveals no provenance", () => {
    const styreFirst = buildAbPrompt(
      ISSUE,
      STYRE_DIFF,
      FIX_PATCH,
      INSTANCE_STYRE_FIRST,
      RUN_SEED,
    ).toLowerCase();
    const humanFirst = buildAbPrompt(
      ISSUE,
      STYRE_DIFF,
      FIX_PATCH,
      INSTANCE_HUMAN_FIRST,
      RUN_SEED,
    ).toLowerCase();
    for (const forbidden of ["accepted", "human", "gold", "reference", "styre"]) {
      expect(styreFirst).not.toContain(forbidden);
      expect(humanFirst).not.toContain(forbidden);
    }
  });
});

describe("abReview (wiring — mock model client, both position orderings)", () => {
  test("styre-first instance: a fixed 'I prefer candidate A' response resolves to A(styre)", async () => {
    const { client, lastPrompt } = makeMockClient("I prefer candidate A because it's cleaner.");
    const result = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_STYRE_FIRST, RUN_SEED, {
      client,
    });
    expect(result.preference).toBe("A(styre)");
    expect(lastPrompt()).toContain(ISSUE);
  });

  test("human-first instance (same runSeed): the SAME fixed 'I prefer candidate A' response now resolves to B(human) — position flipped, mapping tracks it", async () => {
    const { client } = makeMockClient("I prefer candidate A because it's cleaner.");
    const result = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_HUMAN_FIRST, RUN_SEED, {
      client,
    });
    expect(result.preference).toBe("B(human)");
  });

  test("a genuine tie JSON response maps to tie for either position ordering", async () => {
    const { client: clientA } = makeMockClient('{"choice": "tie", "notes": "evenly matched"}');
    const resultStyreFirst = await abReview(
      ISSUE,
      STYRE_DIFF,
      FIX_PATCH,
      INSTANCE_STYRE_FIRST,
      RUN_SEED,
      { client: clientA },
    );
    expect(resultStyreFirst.preference).toBe("tie");

    const { client: clientB } = makeMockClient("Honestly it's a tie between the two.");
    const resultHumanFirst = await abReview(
      ISSUE,
      STYRE_DIFF,
      FIX_PATCH,
      INSTANCE_HUMAN_FIRST,
      RUN_SEED,
      { client: clientB },
    );
    expect(resultHumanFirst.preference).toBe("tie");
  });

  test("an empty response resolves to 'invalid', NOT 'tie' — no signal is not the same as a genuine tie", async () => {
    const { client } = makeMockClient("");
    const result = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_STYRE_FIRST, RUN_SEED, {
      client,
    });
    expect(result.preference).toBe("invalid");
  });

  test("ambiguous free text mentioning BOTH candidates resolves to 'invalid', not a guessed earliest-mention winner", async () => {
    // Regression for the fallback inversion: "Candidate A is worse than Candidate B" mentions
    // "candidate a" first but is clearly not a preference for A -- must not silently resolve to A.
    const { client } = makeMockClient(
      "Candidate A is worse than Candidate B on every dimension I checked.",
    );
    const result = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_STYRE_FIRST, RUN_SEED, {
      client,
    });
    expect(result.preference).toBe("invalid");
  });

  test("the prompt sent to the model never reveals provenance (label-neutral end to end)", async () => {
    const { client, lastPrompt } = makeMockClient('{"choice": "A", "notes": "fine"}');
    await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, INSTANCE_STYRE_FIRST, RUN_SEED, { client });
    const prompt = lastPrompt().toLowerCase();
    for (const forbidden of ["accepted", "human", "gold", "reference", "styre"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });
});
