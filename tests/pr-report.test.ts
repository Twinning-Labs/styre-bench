import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../orchestrator/types";
import { isSelfReportGap, renderReport } from "../report/render";
import type { ReportMeta } from "../report/render";

/**
 * The reporting half of the `pr_opened` tri-state. See `tests/pr-lookup.test.ts` for the
 * lookup itself and the root cause.
 *
 * The rule under test is the one this codebase already applies to `ticket_fix_overlap`:
 * a measurement that was never taken must leave the numerator AND the denominator. Publishing
 * "0% PR-opened rate" for a run whose PR state we failed to read is the exact defect this
 * whole change exists to delete.
 */
const META: ReportMeta = {
  styreRef: "main @ abc1234",
  dataset: "swe-bench-verified",
  seed: 42,
  runDate: "2026-09-11",
  budgetUsd: 150,
};

function rec(overrides: Partial<TaskRecord> & { instance: string }): TaskRecord {
  return {
    language: "python",
    difficulty: "medium",
    styre_commit: "abc1234",
    cohort: "web-off",
    post_cutoff: false,
    resolved: false,
    pr_opened: false,
    pr_self_reported: false,
    pr_lookup_error: null,
    self_authored_test: null,
    self_test_passed: null,
    ticks: 1,
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
    outcome: "pr-ready",
    status: "",
    exit_code: 0,
    parked: false,
    cost_usd_measured: 1,
    cost_usd_estimated: 0,
    tokens_in: null,
    tokens_out: null,
    evidence_dir: null,
    blind_quality: null,
    ab_preference: null,
    ab_notes: null,
    suspected_leak: false,
    leak_reasons: [],
    taxonomy: "opened-but-unresolved",
    ticket_fix_overlap: { fix_lines: 0, test_lines: 0, sample: [] },
    infra_retries: 0,
    ...overrides,
  };
}

describe("PR-opened rate: an undetermined lookup leaves the denominator", () => {
  test("1 opened + 1 not-opened + 1 undetermined renders 50% (1/2), not 33% (1/3)", () => {
    const { markdown } = renderReport(
      [
        rec({ instance: "a", pr_opened: true, pr_self_reported: true }),
        rec({ instance: "b", pr_opened: false, pr_self_reported: false }),
        rec({
          instance: "c",
          pr_opened: null,
          pr_self_reported: true,
          pr_lookup_error: "HttpError: Not Found",
        }),
      ],
      META,
    );
    const row = markdown.split("\n").find((l) => l.startsWith("| PR-opened rate"));
    expect(row).toContain("50% (1/2)");
    expect(row).not.toContain("1/3");
  });

  test("every lookup undetermined -> n/a, never 0%", () => {
    // THE REGRESSION. This is precisely matrix #1 and #2: the lookup failed on every
    // instance, and the report published a confident zero.
    const { markdown } = renderReport(
      [
        rec({ instance: "a", pr_opened: null, pr_lookup_error: "clone failed" }),
        rec({ instance: "b", pr_opened: null, pr_lookup_error: "clone failed" }),
      ],
      META,
    );
    const row = markdown.split("\n").find((l) => l.startsWith("| PR-opened rate"));
    expect(row).toContain("n/a");
    expect(row).not.toContain("0%");
  });

  test("the undetermined instances and their reasons are named in the validity panel", () => {
    const { markdown } = renderReport(
      [rec({ instance: "django-12325", pr_opened: null, pr_lookup_error: "HttpError: Not Found" })],
      META,
    );
    expect(markdown).toContain("PR state UNDETERMINED");
    expect(markdown).toContain("django-12325");
    expect(markdown).toContain("HttpError: Not Found");
  });
});

describe("self-report gap: tri-state safety", () => {
  /**
   * Tested on the PREDICATE, not through `renderReport`. Every taxonomy that currently
   * carries `resolved: null` (`unscored`) is also in `EXCLUDED_FROM_RESOLVE_DENOM`, so the
   * render path never hands this function a null verdict today and a report-level assertion
   * cannot fail. That makes the guard unreachable, not unnecessary: `resolved` is typed
   * `boolean | null`, and the day a taxonomy carries a null verdict INTO the denominator,
   * `!r.resolved` would silently count a run we never judged as a run we caught lying.
   */
  test("a PR with NO oracle verdict is not a gap — `!resolved` would have counted it", () => {
    expect(isSelfReportGap(rec({ instance: "a", pr_opened: true, resolved: null }))).toBe(false);
  });

  test("a PR with an unresolved verdict IS a gap", () => {
    expect(isSelfReportGap(rec({ instance: "a", pr_opened: true, resolved: false }))).toBe(true);
  });

  test("an undetermined PR lookup is never a gap, whatever the verdict", () => {
    expect(isSelfReportGap(rec({ instance: "a", pr_opened: null, resolved: false }))).toBe(false);
  });
});

describe("PR ground-truth vs self-report disagreement", () => {
  test("styre claims pr-ready but the forge shows no PR -> a loud validity warning", () => {
    const { markdown } = renderReport(
      [rec({ instance: "django-12325", pr_opened: false, pr_self_reported: true })],
      META,
    );
    expect(markdown).toContain("DISAGREE on 1 instance(s)");
    expect(markdown).toContain("django-12325");
    expect(markdown).toContain("styre: PR, forge: no PR");
  });

  test("agreement renders the quiet line, with no warning", () => {
    const { markdown } = renderReport(
      [rec({ instance: "a", pr_opened: true, pr_self_reported: true })],
      META,
    );
    expect(markdown).toContain("agree on every instance");
    expect(markdown).not.toContain("DISAGREE");
  });

  test("a null on either side is not a disagreement (absence cannot disagree)", () => {
    const { markdown } = renderReport(
      [
        rec({ instance: "a", pr_opened: null, pr_self_reported: true }),
        rec({ instance: "b", pr_opened: true, pr_self_reported: null }),
      ],
      META,
    );
    expect(markdown).not.toContain("DISAGREE");
  });
});
