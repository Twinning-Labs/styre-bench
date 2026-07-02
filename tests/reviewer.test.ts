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

describe("chooseOrder (pure — seed -> candidate ordering)", () => {
  test("seed=1 puts styre first (candidate A)", () => {
    expect(chooseOrder(1)).toEqual({ first: "styre", second: "human" });
  });

  test("seed=2 swaps styre to second (candidate B)", () => {
    expect(chooseOrder(2)).toEqual({ first: "human", second: "styre" });
  });
});

describe("mapChoiceToPreference (pure — A/B choice -> styre/human, independent of position)", () => {
  test("seed=1 order: choosing A means styre; choosing B means human", () => {
    const order = chooseOrder(1);
    expect(mapChoiceToPreference("A", order)).toBe("A(styre)");
    expect(mapChoiceToPreference("B", order)).toBe("B(human)");
  });

  test("seed=2 order: choosing A means human; choosing B means styre — same literal choice maps to the OPPOSITE identity", () => {
    const order = chooseOrder(2);
    expect(mapChoiceToPreference("A", order)).toBe("B(human)");
    expect(mapChoiceToPreference("B", order)).toBe("A(styre)");
  });

  test("tie maps to tie regardless of order", () => {
    expect(mapChoiceToPreference("tie", chooseOrder(1))).toBe("tie");
    expect(mapChoiceToPreference("tie", chooseOrder(2))).toBe("tie");
  });
});

describe("buildAbPrompt (pure — seed-ordered, label-neutral)", () => {
  test("seed=1: candidate A section carries styre's marker, candidate B carries the other diff's marker, in that order", () => {
    const prompt = buildAbPrompt(ISSUE, STYRE_DIFF, FIX_PATCH, 1);
    const idxA = prompt.indexOf("Candidate A");
    const idxStyreMarker = prompt.indexOf("CANDIDATE_ONE_MARKER");
    const idxB = prompt.indexOf("Candidate B");
    const idxOtherMarker = prompt.indexOf("CANDIDATE_TWO_MARKER");

    expect(idxA).toBeGreaterThan(-1);
    expect(idxStyreMarker).toBeGreaterThan(idxA);
    expect(idxB).toBeGreaterThan(idxStyreMarker);
    expect(idxOtherMarker).toBeGreaterThan(idxB);
  });

  test("seed=2: the ordering FLIPS — candidate A now carries the other diff's marker, candidate B carries styre's", () => {
    const prompt = buildAbPrompt(ISSUE, STYRE_DIFF, FIX_PATCH, 2);
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
    const prompt = buildAbPrompt(ISSUE, STYRE_DIFF_WITH_PLAN, FIX_PATCH, 1);
    expect(prompt).not.toContain("PLAN_DOC_MARKER");
    expect(prompt).not.toContain("docs/plans/");
    // the real fix content must still be present
    expect(prompt).toContain("CANDIDATE_ONE_MARKER");
  });

  test("label-neutrality: the assembled prompt reveals no provenance", () => {
    const seed1 = buildAbPrompt(ISSUE, STYRE_DIFF, FIX_PATCH, 1).toLowerCase();
    const seed2 = buildAbPrompt(ISSUE, STYRE_DIFF, FIX_PATCH, 2).toLowerCase();
    for (const forbidden of ["accepted", "human", "gold", "reference", "styre"]) {
      expect(seed1).not.toContain(forbidden);
      expect(seed2).not.toContain(forbidden);
    }
  });
});

describe("abReview (wiring — mock model client, both seed orderings)", () => {
  test("seed=1: a fixed 'I prefer candidate A' response resolves to A(styre)", async () => {
    const { client, lastPrompt } = makeMockClient("I prefer candidate A because it's cleaner.");
    const result = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, 1, { client });
    expect(result.preference).toBe("A(styre)");
    expect(lastPrompt()).toContain(ISSUE);
  });

  test("seed=2: the SAME fixed 'I prefer candidate A' response now resolves to B(human) — position flipped, mapping tracks it", async () => {
    const { client } = makeMockClient("I prefer candidate A because it's cleaner.");
    const result = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, 2, { client });
    expect(result.preference).toBe("B(human)");
  });

  test("a tie response maps to tie for either seed", async () => {
    const { client: clientA } = makeMockClient("Honestly it's a tie between the two.");
    const resultSeed1 = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, 1, { client: clientA });
    expect(resultSeed1.preference).toBe("tie");

    const { client: clientB } = makeMockClient("Honestly it's a tie between the two.");
    const resultSeed2 = await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, 2, { client: clientB });
    expect(resultSeed2.preference).toBe("tie");
  });

  test("the prompt sent to the model never reveals provenance (label-neutral end to end)", async () => {
    const { client, lastPrompt } = makeMockClient('{"choice": "A", "notes": "fine"}');
    await abReview(ISSUE, STYRE_DIFF, FIX_PATCH, 1, { client });
    const prompt = lastPrompt().toLowerCase();
    for (const forbidden of ["accepted", "human", "gold", "reference", "styre"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });
});
