import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../orchestrator/types";
import { renderReport } from "../report/render";
import type { ReportMeta } from "../report/render";

/**
 * Hand-built fixture, all field values chosen so the load-bearing arithmetic can be
 * verified by hand (see inline comments). Layout:
 *   r1,r2,r5,r6 -- web-off, resolved
 *   r3          -- web-off, opened-but-unresolved (pr_opened, self-report-gap case)
 *   r4          -- web-off, opened-but-unresolved, pr NOT opened (not a self-report-gap case),
 *                  ab_preference:"invalid" (must be excluded from the A/B denominator)
 *   r7          -- web-off, taxonomy:"dropped-flaky" (excluded from resolve-rate denominator)
 *   r8          -- web-off, taxonomy:"probe", same cell as r4 (python/easy) -> triggers the
 *                  grid's ⚠ marker on that cell, and is ALSO excluded from the denominator
 *   r9          -- web-on, resolved, suspected_leak:true
 *   r10         -- web-on, unresolved, leak_reasons contains "transcript-unavailable"
 *                  (the URL-scan-did-not-run signal)
 *
 * So: records.length === 10, but the resolve-rate denominator (web-off minus
 * dropped-flaky/probe/infra/parked) is exactly r1..r6 -> 6. Resolved among those: r1,r2,r5,r6
 * -> 4. Headline resolve rate must render as "4/6", never "5/8" (would happen if dropped-flaky
 * and probe leaked into the denominator) or "4/10" (would happen if cohort weren't filtered).
 */
function makeRecord(overrides: Partial<TaskRecord> & { instance: string }): TaskRecord {
  return {
    language: "ts",
    difficulty: "easy",
    styre_commit: "deadbeef",
    cohort: "web-off",
    post_cutoff: false,
    resolved: false,
    pr_opened: false,
    self_authored_test: null,
    self_test_passed: null,
    ticks: 5,
    cycle_count: 1,
    escalation_count: 0,
    escalation_reasons: [],
    outcome: "pr-ready",
    status: "ok",
    exit_code: 0,
    parked: false,
    cost_usd: 3,
    tokens_in: 1000,
    tokens_out: 200,
    blind_quality: null,
    ab_preference: null,
    ab_notes: null,
    suspected_leak: false,
    leak_reasons: [],
    taxonomy: "resolved",
    ...overrides,
  };
}

const r1 = makeRecord({
  instance: "r1-resolved-ts-easy",
  language: "ts",
  difficulty: "easy",
  post_cutoff: false,
  resolved: true,
  pr_opened: true,
  taxonomy: "resolved",
  blind_quality: "addresses-issue",
  ab_preference: "A(styre)",
  ticks: 6,
  cycle_count: 1,
  cost_usd: 3.0,
});

const r2 = makeRecord({
  instance: "r2-resolved-ts-medium",
  language: "ts",
  difficulty: "medium",
  post_cutoff: true,
  resolved: true,
  pr_opened: true,
  taxonomy: "resolved",
  blind_quality: "addresses-issue",
  ab_preference: "tie",
  ticks: 8,
  cycle_count: 1,
  cost_usd: 3.5,
});

const r3 = makeRecord({
  instance: "r3-unresolved-python-medium-self-report-gap",
  language: "python",
  difficulty: "medium",
  post_cutoff: true,
  resolved: false,
  pr_opened: true, // pr_opened && !resolved -> counts toward self-report gap
  taxonomy: "opened-but-unresolved",
  // reviewer said "addresses-issue" but oracle disagreed -- a genuine review<->oracle mismatch
  blind_quality: "addresses-issue",
  ab_preference: "B(human)",
  ticks: 14,
  cycle_count: 4,
  escalation_count: 1,
  escalation_reasons: ["verify-red-exhausted"],
  cost_usd: 6.4,
});

const r4 = makeRecord({
  instance: "r4-unresolved-python-easy-no-pr",
  language: "python",
  difficulty: "easy",
  post_cutoff: false,
  resolved: false,
  pr_opened: false, // NOT a self-report-gap case
  taxonomy: "opened-but-unresolved",
  blind_quality: "does-not-address",
  ab_preference: "invalid", // must be EXCLUDED from the A/B denominator
  ticks: 20,
  cycle_count: 5,
  escalation_count: 2,
  escalation_reasons: ["no-progress"],
  cost_usd: 7.0,
});

const r5 = makeRecord({
  instance: "r5-resolved-python-hard",
  language: "python",
  difficulty: "hard",
  post_cutoff: false,
  resolved: true,
  pr_opened: true,
  taxonomy: "resolved",
  blind_quality: null,
  ab_preference: null,
  ticks: 7,
  cycle_count: 1,
  cost_usd: 3.2,
});

const r6 = makeRecord({
  instance: "r6-resolved-ts-hard",
  language: "ts",
  difficulty: "hard",
  post_cutoff: true,
  resolved: true,
  pr_opened: true,
  taxonomy: "resolved",
  blind_quality: "addresses-issue",
  ab_preference: "A(styre)",
  ticks: 9,
  cycle_count: 2,
  cost_usd: 4.0,
});

const r7 = makeRecord({
  instance: "r7-dropped-flaky",
  language: "python",
  difficulty: "easy",
  resolved: false,
  pr_opened: false,
  taxonomy: "dropped-flaky", // EXCLUDED from resolve-rate denominator
});

const r8 = makeRecord({
  instance: "r8-probe-python-easy",
  language: "python",
  difficulty: "easy", // same cell as r4 -> triggers grid ⚠
  resolved: false,
  pr_opened: false,
  taxonomy: "probe", // EXCLUDED from resolve-rate denominator
});

const r9 = makeRecord({
  instance: "r9-web-on-suspected-leak",
  language: "ts",
  difficulty: "medium",
  cohort: "web-on",
  post_cutoff: true,
  resolved: true,
  pr_opened: true,
  taxonomy: "resolved",
  suspected_leak: true,
  leak_reasons: ["pr-url-in-transcript"],
});

const r10 = makeRecord({
  instance: "r10-web-on-transcript-unavailable",
  language: "python",
  difficulty: "easy",
  cohort: "web-on",
  post_cutoff: false,
  resolved: false,
  pr_opened: true,
  taxonomy: "opened-but-unresolved",
  suspected_leak: false,
  leak_reasons: ["transcript-unavailable"],
});

const records: TaskRecord[] = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10];

const META: ReportMeta = {
  styreRef: "feat/polyglot-setup @ deadbeef",
  dataset: "Multi-SWE-bench v1 + SWE-bench Verified",
  seed: 42,
  runDate: "2026-07-02",
  budgetUsd: 150,
  spentUsd: 42.5,
};

describe("renderReport", () => {
  test("headline resolve rate excludes dropped-flaky/probe/infra/parked from the denominator", () => {
    const { markdown } = renderReport(records, META);
    // 6 valid web-off records (r1,r2,r3,r4,r5,r6), 4 resolved (r1,r2,r5,r6) -> "4/6", never
    // "5/8" (dropped-flaky+probe leaking in) or anything over records.length (10).
    expect(markdown).toContain("4/6");
    expect(markdown).not.toContain("4/8");
    expect(markdown).not.toContain("5/8");
  });

  test("self-report gap % uses the same hygiene-filtered denominator", () => {
    const { markdown } = renderReport(records, META);
    // only r3 is pr_opened && !resolved within the 6-record denominator -> 1/6
    expect(markdown).toContain("1/6");
  });

  test("PR-opened rate over the same denominator", () => {
    const { markdown } = renderReport(records, META);
    // pr_opened among r1..r6: r1,r2,r3,r5,r6 -> 5/6
    expect(markdown).toContain("5/6");
  });

  test("resolve grid has a row per language present in the web-off cohort", () => {
    const { markdown } = renderReport(records, META);
    expect(markdown).toContain("ts");
    expect(markdown).toContain("python");
  });

  test("grid marks the python/easy cell with ⚠ (it has a probe finding)", () => {
    const { markdown } = renderReport(records, META);
    // Anchor on the grid section's own `##` heading (not the bare "Resolve rate" substring,
    // which also matches the unrelated "Resolve rate (oracle)" row in the Headline table).
    const gridSection = markdown.slice(markdown.indexOf("## Resolve rate — language × difficulty"));
    expect(gridSection).toContain("⚠");
  });

  test("A/B preference distribution excludes the invalid record (r4) from the denominator", () => {
    const { markdown } = renderReport(records, META);
    // ab_preference across the fixture: r1 A(styre), r2 tie, r3 B(human), r4 invalid, r5 null,
    // r6 A(styre), r7/r8/r9/r10 null (default). Eligible (non-null, non-invalid) -> r1,r2,r3,r6 = 4.
    //   styre: r1,r6 -> 2/4 = 50%
    //   human: r3    -> 1/4 = 25%
    //   tie:   r2    -> 1/4 = 25%
    // Only r4 has ab_preference === "invalid" -> excludedCount = 1.
    // This asserts the ACTUAL A/B numerator/denominator strings, so it fails if the invalid
    // record (r4) re-enters the denominator (which would render "n=5" and shift every %).
    const section = markdown.slice(markdown.indexOf("## Judgment quality"));
    expect(section).toContain("n=4");
    expect(section).toContain("1 excluded as invalid/unparsed");
    expect(section).toContain("styre 50% (2/4)");
    expect(section).toContain("human 25% (1/4)");
    expect(section).toContain("tie 25% (1/4)");
  });

  test("gold-divergence renders ONLY as 'provisional (uncalibrated)', never a bare number", () => {
    const { markdown } = renderReport(records, META);
    expect(markdown).toContain("provisional (uncalibrated)");
    // must not render e.g. "Gold-divergence: 6/17" or "Gold-divergence: 35%"
    expect(markdown).not.toMatch(/Gold-divergence:\s*\d/i);
  });

  test("failure taxonomy histogram counts sum to records.length", () => {
    const { markdown } = renderReport(records, META);
    const taxonomyHeading = /## Failure taxonomy \((\d+)\)/.exec(markdown);
    expect(taxonomyHeading).not.toBeNull();
    expect(Number(taxonomyHeading?.[1])).toBe(records.length);

    // Extract every "<bucket> <count>" token after the heading and sum the counts.
    const section = markdown.slice(markdown.indexOf("## Failure taxonomy"));
    const line = section.split("\n")[2] ?? ""; // heading, blank line, then the histogram line
    const counts = [...line.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
    const sum = counts.reduce((a, b) => a + b, 0);
    expect(sum).toBe(records.length);
  });

  test("validity panel reports the web-on suspected-leak count", () => {
    const { markdown } = renderReport(records, META);
    const panel = markdown.slice(markdown.indexOf("## Validity panel"));
    expect(panel).toContain("1/2"); // 1 of 2 web-on records suspected-leak
  });

  test("validity panel states the URL-scan did NOT run when transcript-unavailable is present", () => {
    const { markdown } = renderReport(records, META);
    const panel = markdown.slice(markdown.indexOf("## Validity panel"));
    expect(panel).toMatch(/did NOT run/i);
    expect(panel).toContain("transcript-unavailable");
  });

  test("validity panel reports the flaky-dropped count", () => {
    const { markdown } = renderReport(records, META);
    const panel = markdown.slice(markdown.indexOf("## Validity panel"));
    expect(panel).toContain("1"); // r7 is the sole dropped-flaky record
    expect(panel).toMatch(/flaky/i);
  });

  test("JSON output round-trips records", () => {
    const { json } = renderReport(records, META);
    expect(json).toEqual(records);
  });

  test("a report with no web-on records states there is no web-on data, never a divide-by-zero artifact", () => {
    const webOffOnly = records.filter((r) => r.cohort === "web-off");
    const { markdown } = renderReport(webOffOnly, META);
    expect(markdown).not.toContain("NaN");
    expect(markdown).not.toContain("Infinity");
  });

  test("loop economics: median/p90 ticks and median cost per resolved/unresolved group, plus review<->oracle agreement", () => {
    // Dedicated fixture, isolated from `records` above, built purely so the loop-economics
    // stats (render.ts:211-270, previously uncovered) can be hand-verified. All web-off and
    // hygiene-eligible (taxonomy not in EXCLUDED_FROM_RESOLVE_DENOM), split resolved/unresolved
    // exactly as renderLoopEconomics does.
    //
    // percentile() in render.ts uses nearest-rank (ceil), not linear interpolation:
    //   idx = min(len-1, max(0, ceil((p/100)*len) - 1))
    //
    // resolved group: ticks sorted = [1,2,3,4,5,6,7,8,9,100]  (n=10)
    //   median = avg(s[4],s[5]) = avg(5,6)   = 5.5
    //   p90:    idx = ceil(0.9*10)-1 = 8  -> s[8] = 9      (distinct from median 5.5 and max 100)
    //   cost sorted = [1,2,3,4,5,6,7,8,9,100] (an outlier, deliberately NOT symmetric, so
    //   median != mean and the test can distinguish the two) -> median cost = avg(5,6) = 5.5,
    //   mean cost = (45+100)/10 = 14.5 -> asserting "$5.50" only passes under median.
    //
    // unresolved group: ticks sorted = [10,20,30,40,50,60,70,80,90,1000]  (n=10)
    //   median = avg(s[4],s[5]) = avg(50,60) = 55
    //   p90:    idx = ceil(0.9*10)-1 = 8  -> s[8] = 90     (distinct from median 55 and max 1000)
    //   cost sorted = [11,12,13,14,15,16,17,18,19,200] (outlier again) -> median cost =
    //   avg(15,16) = 15.5, mean cost = (135+200)/10 = 33.5 -> asserting "$15.50" only passes
    //   under median.
    //
    // NOTE: render.ts's "cost / instance (med)" row is a MEDIAN, not a mean (see fmt2(median(...))
    // at render.ts:238) -- asserting the median-cost value here, matching the actual grouping.
    //
    // review<->oracle agreement: only 4 records (of the 20) carry a non-null blind_quality;
    // the rest are null and excluded from `reviewed`, per renderJudgmentQuality's own filter.
    //   res-rev-0:   blind_quality "addresses-issue" (predicts resolved=true), resolved=true  -> match
    //   res-rev-1:   blind_quality "addresses-issue" (predicts resolved=true), resolved=true  -> match
    //   unres-rev-0: blind_quality "addresses-issue" (predicts resolved=true), resolved=false -> mismatch
    //   unres-rev-1: blind_quality "does-not-address" (predicts resolved=false), resolved=false -> match
    //   -> reviewed n=4, matches=3 -> ratio 3/4 = 0.75 -> "0.75" / "75%"
    const resolvedTicks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const resolvedCosts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const unresolvedTicks = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
    const unresolvedCosts = [11, 12, 13, 14, 15, 16, 17, 18, 19, 200];

    const resolvedBlindQuality: (string | null)[] = [
      "addresses-issue",
      "addresses-issue",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const unresolvedBlindQuality: (string | null)[] = [
      "addresses-issue",
      "does-not-address",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];

    const resolvedRecords = resolvedTicks.map((ticks, i) =>
      makeRecord({
        instance: `le-resolved-${i}`,
        language: "ts",
        difficulty: "medium",
        cohort: "web-off",
        resolved: true,
        pr_opened: true,
        taxonomy: "resolved",
        ticks,
        cost_usd: resolvedCosts[i] ?? 0,
        blind_quality: resolvedBlindQuality[i] ?? null,
      }),
    );
    const unresolvedRecords = unresolvedTicks.map((ticks, i) =>
      makeRecord({
        instance: `le-unresolved-${i}`,
        language: "python",
        difficulty: "medium",
        cohort: "web-off",
        resolved: false,
        pr_opened: false,
        taxonomy: "opened-but-unresolved",
        ticks,
        cost_usd: unresolvedCosts[i] ?? 0,
        blind_quality: unresolvedBlindQuality[i] ?? null,
      }),
    );

    const { markdown } = renderReport([...resolvedRecords, ...unresolvedRecords], META);

    const econSection = markdown.slice(
      markdown.indexOf("## Loop economics"),
      markdown.indexOf("## Judgment quality"),
    );
    expect(econSection).toContain("5.5 / 9.0"); // resolved: median 5.5, p90 9.0
    expect(econSection).toContain("55.0 / 90.0"); // unresolved: median 55.0, p90 90.0
    expect(econSection).toContain("$5.50"); // resolved median cost
    expect(econSection).toContain("$15.50"); // unresolved median cost

    const judgmentSection = markdown.slice(markdown.indexOf("## Judgment quality"));
    expect(judgmentSection).toContain(
      "Review↔oracle agreement: 0.75 (blind reviewer predicts ground truth 75% of the time, n=4)",
    );
  });
});
