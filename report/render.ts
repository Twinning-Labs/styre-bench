import { z } from "zod";
import type { Difficulty, TaskRecord } from "../orchestrator/types";
import {
  hasOracleVerdict,
  measurePopulation,
  normalizeReportRecord,
  wasSubmitted,
} from "./measurement";

/** Run-level metadata for the report header — NOT derived from `records` (styre commit,
 * dataset, sampling seed, budget, run date are properties of the run, not of any task). */
export const ReportMetaSchema = z.object({
  styreRef: z.string().min(1),
  dataset: z.string().min(1),
  seed: z.number().int(),
  runDate: z.string().min(1),
  budgetUsd: z.number().finite().nonnegative(),
  spentUsd: z.number().finite().nonnegative().optional(),
  skippedCount: z.number().int().nonnegative().optional(),
  title: z.string().min(1).optional(),
});
export type ReportMeta = z.infer<typeof ReportMetaSchema>;

export interface RenderReportResult {
  markdown: string;
  json: TaskRecord[];
  metrics: {
    webOff: ReturnType<typeof measurePopulation>;
    webOn: ReturnType<typeof measurePopulation>;
  };
}

const OVERLAP_SUBSET_LABEL = "Resolve rate — zero measured ticket/patch overlap";
const inResolveDenom = hasOracleVerdict;

function resolvedCount(rs: TaskRecord[]): number {
  return rs.filter((r) => r.resolved).length;
}

/** Zero lexical matches under the recorded rule; neither presence nor absence proves exposure. */
function hasZeroMeasuredOverlap(r: TaskRecord): boolean {
  const o = r.ticket_fix_overlap;
  return o != null && o.fix_lines === 0 && o.test_lines === 0;
}

/** true iff `r` counts toward the "self-report gap": styre opened a PR (self-reported
 * success) but the oracle says it did not actually resolve the issue.
 *
 * Both halves are compared EXPLICITLY against their booleans. `pr_opened` and `resolved` are
 * each tri-state, and `!r.resolved` would fold an unmeasured `null` verdict into the gap
 * numerator — counting a run we never scored as a run we caught lying. */
export function isSelfReportGap(r: TaskRecord): boolean {
  return r.pr_opened === true && r.resolved === false;
}

/** true iff `r` has a PR-opened verdict at all. A `null` means the forge lookup could not
 * find out, and such a record must leave BOTH the numerator and the denominator of the
 * PR-opened rate — the same rule `hasZeroMeasuredOverlap` applies to an unmeasured overlap. Folding
 * it in is exactly the bug that published a 0% PR-opened rate for a run that opened a PR. */
function hasPrVerdict(r: TaskRecord): boolean {
  return typeof r.pr_opened === "boolean";
}

/**
 * true iff the forge and styre's own telemetry DISAGREE about whether a PR exists.
 *
 * This is a validity check on the bench itself, not on styre. `pr_opened` is ground truth
 * (CLAUDE.md move 5); `pr_self_reported` is the claim. When a run reports `pr-ready` and the
 * forge shows no pull request, one of the two readers is broken and no metric built on either
 * can be trusted until we know which. Records where either side is `null` are excluded — an
 * absent reading cannot disagree with anything.
 */
export function isPrReportDisagreement(r: TaskRecord): boolean {
  return r.pr_opened !== null && r.pr_self_reported !== null && r.pr_opened !== r.pr_self_reported;
}

function pctNum(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

function pctStr(n: number, d: number): string {
  return d === 0 ? "n/a" : `${pctNum(n, d)}%`;
}

/** "NN% (n/d)" — the absolute-value cell used for the web-off (headline) and
 * post-cutoff-only columns. */
function absCell(n: number, d: number): string {
  return d === 0 ? "n/a (0/0)" : `${pctStr(n, d)} (${n}/${d})`;
}

/** "NN% (+Xpp)" — the web-on column: the absolute web-on rate plus its delta, in
 * percentage points, off the web-off headline rate. Renders a no-data notice rather than a
 * NaN/Infinity artifact when the run had no web-on cohort at all. */
function deltaCell(offN: number, offD: number, onN: number, onD: number): string {
  if (onD === 0) return "n/a (no web-on data)";
  if (offD === 0) return `${absCell(onN, onD)} (Δ n/a: no measured web-off baseline)`;
  const offPct = pctNum(offN, offD);
  const onPct = pctNum(onN, onD);
  const delta = onPct - offPct;
  const sign = delta >= 0 ? "+" : "";
  return `${onPct}% (${sign}${delta}pp)`;
}

function sortedNums(nums: number[]): number[] {
  return [...nums].sort((a, b) => a - b);
}

function median(nums: number[]): number {
  if (nums.length === 0) return Number.NaN;
  const s = sortedNums(nums);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) {
    return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  }
  return s[mid] ?? 0;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return Number.NaN;
  const s = sortedNums(nums);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx] ?? 0;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return Number.NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt1(n: number): string {
  return Number.isNaN(n) ? "n/a" : n.toFixed(1);
}

function fmt2(n: number): string {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------------------

function renderHeadline(records: TaskRecord[], meta: ReportMeta): string {
  const webOffAll = records.filter((r) => r.cohort === "web-off");
  const webOnAll = records.filter((r) => r.cohort === "web-on");
  const webOff = webOffAll.filter(inResolveDenom);
  const webOn = webOnAll.filter(inResolveDenom);
  const postCutoff = webOff.filter((r) => r.post_cutoff === true);

  const resolvedOff = resolvedCount(webOff);
  const resolvedOn = resolvedCount(webOn);
  const resolvedPost = resolvedCount(postCutoff);

  // Lexical subset only: zero matches does not establish absence of solution information.
  const cleanOff = webOff.filter(hasZeroMeasuredOverlap);
  const cleanOn = webOn.filter(hasZeroMeasuredOverlap);
  const cleanPost = postCutoff.filter(hasZeroMeasuredOverlap);
  const resolvedCleanOff = resolvedCount(cleanOff);
  const resolvedCleanOn = resolvedCount(cleanOn);
  const resolvedCleanPost = resolvedCount(cleanPost);

  const gapOff = webOff.filter(isSelfReportGap).length;
  const gapOn = webOn.filter(isSelfReportGap).length;
  const gapPost = postCutoff.filter(isSelfReportGap).length;

  // Denominator hygiene, second axis: on top of the taxonomy filter already applied to
  // `webOff`, a record whose PR state was never determined leaves this rate entirely.
  const prDenomOff = webOffAll.filter(hasPrVerdict);
  const prDenomOn = webOnAll.filter(hasPrVerdict);
  const prDenomPost = webOffAll.filter((r) => r.post_cutoff === true).filter(hasPrVerdict);
  const prOff = prDenomOff.filter((r) => r.pr_opened === true).length;
  const prOn = prDenomOn.filter((r) => r.pr_opened === true).length;
  const prPost = prDenomPost.filter((r) => r.pr_opened === true).length;

  const cohortLabel =
    webOnAll.length > 0 ? "web-OFF (headline) + web-on delta" : "web-OFF (headline)";

  const lines: string[] = [];
  lines.push(`# ${meta.title ?? "Styre-Bench Report"}`);
  lines.push("");
  lines.push(`styre: ${meta.styreRef} · dataset: ${meta.dataset} · seed: ${meta.seed}`);
  const profiles = [
    ...new Set(
      records
        .flatMap((r) => [
          r.oracle_profile,
          r.controls?.oracle_profile,
          ...(r.controls?.gold_runs ?? []).map((g) => g.oracle_profile),
        ])
        .flatMap((p) =>
          p ? [`${p.id} (positive timeout floor ${p.minimum_timeout_ms / 1000}s)`] : [],
        ),
    ),
  ];
  if (profiles.length > 0) {
    lines.push(
      `oracle profile: ${profiles.join(", ")} — serial dedicated host; compare only like-profile runs`,
    );
  }
  const budgetStr =
    meta.spentUsd !== undefined
      ? `$${fmt2(meta.spentUsd)} / $${fmt2(meta.budgetUsd)}`
      : `$${fmt2(meta.budgetUsd)}`;
  lines.push(
    `run: ${meta.runDate} · instances: ${records.length} · cohort: ${cohortLabel} · budget: ${budgetStr}`,
  );
  if (meta.skippedCount !== undefined && meta.skippedCount > 0) {
    lines.push(
      `**⚠ ${meta.skippedCount} instance(s) skipped — run budget-truncated (runBudgetUsd kill-switch tripped before every selected instance started).**`,
    );
  }
  lines.push("");
  lines.push("## Headline");
  lines.push("| metric | web-off (headline) | web-on (Δ) | post-cutoff only |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Resolve rate (oracle) | ${absCell(resolvedOff, webOff.length)} | ${deltaCell(resolvedOff, webOff.length, resolvedOn, webOn.length)} | ${absCell(resolvedPost, postCutoff.length)} |`,
  );
  lines.push(
    `| ${OVERLAP_SUBSET_LABEL} | ${absCell(resolvedCleanOff, cleanOff.length)} | ${deltaCell(resolvedCleanOff, cleanOff.length, resolvedCleanOn, cleanOn.length)} | ${absCell(resolvedCleanPost, cleanPost.length)} |`,
  );
  lines.push(
    `| Self-report gap (opened-unresolved) | ${absCell(gapOff, webOff.filter(hasPrVerdict).length)} | ${deltaCell(gapOff, webOff.filter(hasPrVerdict).length, gapOn, webOn.filter(hasPrVerdict).length)} | ${absCell(gapPost, postCutoff.filter(hasPrVerdict).length)} |`,
  );
  lines.push(
    `| PR-opened rate | ${absCell(prOff, prDenomOff.length)} | ${deltaCell(prOff, prDenomOff.length, prOn, prDenomOn.length)} | ${absCell(prPost, prDenomPost.length)} |`,
  );
  lines.push("");

  lines.push(
    "Oracle rates use only measured candidate verdicts; PR rates use all known PR states. The opened-unresolved rate uses records with both observations. Zero overlap is a lexical subset, not proof that tickets contain no solution.",
  );
  lines.push("");
  for (const cohort of ["web-off", "web-on"] as const) {
    const rs = records.filter((r) => r.cohort === cohort);
    if (!rs.length) continue;
    const m = measurePopulation(rs);
    lines.push(
      `- ${cohort} coverage: ${m.recorded} recorded · ${m.qualified} control-qualified · ${m.submitted} submitted · ${m.oracleResolved.denominator} measured candidate verdicts · ${m.qualificationUnknown} qualification unknown.`,
    );
    lines.push(
      `- ${cohort} confirmed ticket-to-PR delivery / control-qualified runs: ${absCell(m.confirmedDelivery.numerator, m.confirmedDelivery.denominator)}. Requires both an opened PR and an oracle-resolved patch; unmeasured runs are not confirmed successes.`,
    );
  }
  lines.push("");

  // Unknown scores can be candidate-caused. Show bounds over the original
  // submitted attempts so exclusion cannot silently inflate the headline.
  for (const cohort of ["web-off", "web-on"] as const) {
    const cohortRecords = records.filter((r) => r.cohort === cohort);
    // Attempt membership cannot depend on the scoring outcome. Include submitted
    // parked runs whether they return a boolean or an unknown. Taxonomy fallback
    // recognizes older records written before explicit submission provenance.
    const submitted = cohortRecords.filter(wasSubmitted);
    const measured = submitted.filter((r) => r.resolved !== null);
    const unknown = submitted.filter((r) => r.resolved === null);
    if (unknown.length === 0) continue;
    const total = measured.length + unknown.length;
    const successes = resolvedCount(measured);
    lines.push(
      `**${cohort}: ${unknown.length} submitted candidate(s) have no oracle verdict (origin unknown). ` +
        `The measured-only rate is incomplete. Resolve bounds across ${total} submitted attempts: ` +
        `${pctStr(successes, total)}–${pctStr(successes + unknown.length, total)}.**`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Resolve grid — language x difficulty (web-off cohort)
// ---------------------------------------------------------------------------------------

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

function gridCell(cellAll: TaskRecord[]): string {
  const denom = cellAll.filter(inResolveDenom);
  const flagged = cellAll.some((r) => r.taxonomy === "probe" || r.taxonomy === "collect-error");
  const base = denom.length === 0 ? "-" : `${resolvedCount(denom)}/${denom.length}`;
  return flagged ? `${base} ⚠` : base;
}

function renderGrid(records: TaskRecord[]): string {
  const webOff = records.filter((r) => r.cohort === "web-off");
  const languages = [...new Set(webOff.map((r) => r.language))].sort();

  const lines: string[] = [];
  lines.push("## Resolve rate — language × difficulty (web-off)");
  lines.push("| lang | Easy | Medium | Hard | cell |");
  lines.push("|---|---|---|---|---|");

  for (const lang of languages) {
    const langAll = webOff.filter((r) => r.language === lang);
    const cells = DIFFICULTIES.map((d) => gridCell(langAll.filter((r) => r.difficulty === d)));
    const langDenom = langAll.filter(inResolveDenom);
    const cellPct = pctStr(resolvedCount(langDenom), langDenom.length);
    lines.push(`| ${lang} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cellPct} |`);
  }

  // by-difficulty roll-up row, across all languages
  const byDiff = DIFFICULTIES.map((d) => {
    const denom = webOff.filter((r) => r.difficulty === d).filter(inResolveDenom);
    return pctStr(resolvedCount(denom), denom.length);
  });
  lines.push(`| by-diff | ${byDiff[0]} | ${byDiff[1]} | ${byDiff[2]} | |`);
  lines.push("");
  lines.push(
    "⚠ marks a cell containing a `probe` finding (an explicitly recorded `styre setup` failure — read as detector-coverage, not loop performance) or a `collect-error` (artifacts the rig could not read under its contract; evidence kept for offline scoring); both are excluded from the N/total shown.",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Loop economics — resolved vs unresolved (web-off, hygiene-filtered)
// ---------------------------------------------------------------------------------------

function renderLoopEconomics(records: TaskRecord[]): string {
  const denom = records.filter((r) => r.cohort === "web-off").filter(inResolveDenom);
  const resolved = denom.filter((r) => r.resolved);
  const unresolved = denom.filter((r) => !r.resolved);

  const group = (rs: TaskRecord[]) => ({
    ticks: rs.map((r) => r.ticks),
    loopbacks: rs.map((r) => r.cycle_count),
    escalations: rs.map((r) => r.escalation_count),
    // ENG-390: measured cost only. An unmeasured run contributes NOTHING to the median
    // rather than a zero or an estimate — a guess must never be rendered as a measurement.
    cost: rs.map((r) => r.cost_usd_measured).filter((c): c is number => c !== null),
    costUnknown: rs.filter((r) => r.cost_usd_measured === null).length,
  });
  const gr = group(resolved);
  const gu = group(unresolved);

  const lines: string[] = [];
  lines.push("## Loop economics (web-off)");
  lines.push("| metric | resolved | unresolved |");
  lines.push("|---|---|---|");
  lines.push(
    `| ticks (median / p90) | ${fmt1(median(gr.ticks))} / ${fmt1(percentile(gr.ticks, 90))} | ${fmt1(median(gu.ticks))} / ${fmt1(percentile(gu.ticks, 90))} |`,
  );
  lines.push(
    `| loopbacks (median) | ${fmt1(median(gr.loopbacks))} | ${fmt1(median(gu.loopbacks))} |`,
  );
  lines.push(
    `| escalations / run | ${fmt1(mean(gr.escalations))} | ${fmt1(mean(gu.escalations))} |`,
  );
  const costCell = (g: { cost: number[]; costUnknown: number }): string =>
    g.cost.length === 0 ? "unknown" : `$${fmt2(median(g.cost))}`;
  lines.push(`| cost / instance (med) | ${costCell(gr)} | ${costCell(gu)} |`);
  const unknownTotal = gr.costUnknown + gu.costUnknown;
  if (unknownTotal > 0) {
    lines.push(
      `> ⚠ ${unknownTotal} instance(s) reported NO measurable cost — excluded from the median above, not counted as $0.`,
    );
  }

  const reasonCounts = new Map<string, number>();
  for (const r of denom) {
    for (const reason of r.escalation_reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} (${count})`)
    .join(", ");
  lines.push(`top escalation reasons: ${topReasons.length > 0 ? topReasons : "none"}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Judgment quality
// ---------------------------------------------------------------------------------------

const AB_EXCLUDED = new Set<TaskRecord["ab_preference"]>(["invalid", null]);

/** Whether a blind-quality verdict predicts the oracle will call the instance resolved.
 * Only `"addresses-issue"` predicts resolved=true. Recognized negative/partial labels
 * predict false; unparsed and unknown labels provide no prediction. This
 * mapping is this renderer's own scoring convention (§8 does not pin one down), documented
 * here so it's auditable rather than implicit. */
function blindQualityPredictsResolved(verdict: string): boolean | null {
  if (verdict === "addresses-issue") return true;
  if (
    ["partial", "addresses-issue-partial", "does-not-address", "test-gaming-suspected"].includes(
      verdict,
    )
  )
    return false;
  return null;
}

function renderJudgmentQuality(records: TaskRecord[]): string {
  const lines: string[] = [];
  lines.push("## Judgment quality");

  // resolved !== null excludes "unscored" (SMOKE=2 Option-B) records: review<->oracle
  // AGREEMENT requires an oracle verdict to agree/disagree WITH, so a record with no verdict
  // must not silently count as a mismatch (its blind_quality still shows up elsewhere — the
  // A/B section below, and the raw JSON export — since a blind-quality REVIEW itself doesn't
  // need an oracle verdict to have run).
  const reviewed = records.filter(
    (r): r is TaskRecord & { blind_quality: string } =>
      r.blind_quality !== null &&
      hasOracleVerdict(r) &&
      blindQualityPredictsResolved(r.blind_quality) !== null,
  );
  const agreementMatches = reviewed.filter(
    (r) => blindQualityPredictsResolved(r.blind_quality) === r.resolved,
  ).length;
  if (reviewed.length > 0) {
    lines.push(
      `- Review↔oracle agreement: ${fmt2(agreementMatches / reviewed.length)} (blind reviewer predicts ground truth ${pctStr(agreementMatches, reviewed.length)} of the time, n=${reviewed.length})`,
    );
  } else {
    lines.push("- Review↔oracle agreement: n/a (no comparable parsed review and oracle verdict)");
  }

  const abEligible = records.filter((r) => !AB_EXCLUDED.has(r.ab_preference));
  const excludedCount = records.filter((r) => r.ab_preference === "invalid").length;
  if (abEligible.length > 0) {
    const styreCount = abEligible.filter((r) => r.ab_preference === "A(styre)").length;
    const humanCount = abEligible.filter((r) => r.ab_preference === "B(human)").length;
    const tieCount = abEligible.filter((r) => r.ab_preference === "tie").length;
    lines.push(
      `- A/B gold preference (n=${abEligible.length}, ${excludedCount} excluded as invalid/unparsed): ` +
        `styre ${absCell(styreCount, abEligible.length)} · human ${absCell(humanCount, abEligible.length)} · tie ${absCell(tieCount, abEligible.length)}`,
    );
  } else {
    lines.push(
      `- A/B gold preference: n/a (no valid A/B reviews; ${excludedCount} excluded as invalid/unparsed)`,
    );
  }

  // Gold-divergence: per design §7, the A/B reviewer is uncalibrated (no human-label kappa
  // established yet) — publishing a rate here would risk training styre to mimic fix_patch.
  // This line is INTENTIONALLY never a number.
  lines.push(
    "- Gold-divergence: provisional (uncalibrated) — calibration harness deferred (design §7); no rate published until inter-rater agreement (κ) against human labels is established.",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Failure taxonomy histogram
// ---------------------------------------------------------------------------------------

// NOTE: no "suspected-leak" entry here — no code ever sets `taxonomy: "suspected-leak"` (leak
// detection sets the separate `suspected_leak: boolean` / `leak_reasons: string[]` fields, not
// `taxonomy`). Web-off suspected-leaks are surfaced via the validity panel's leak count
// (`renderValidityPanel`'s `leak_count`), not this histogram — keep it correct rather than
// carrying a dead bucket that would always render 0.
const TAXONOMY_ORDER = [
  "resolved",
  "opened-but-unresolved",
  "unresolved-pr-unconfirmed",
  "pr-undelivered",
  "loop-exhausted",
  "probe",
  "collect-error",
  "parked",
  "infra",
  "dropped-gold-unresolved",
  "dropped-base-passes",
  "dropped-base-unstable",
  "dropped-base-unmeasured",
  "dropped-controls-unmeasured",
  "oracle-unmeasured",
  "dropped-flaky",
  "unscored",
];

function renderTaxonomy(records: TaskRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) {
    counts.set(r.taxonomy, (counts.get(r.taxonomy) ?? 0) + 1);
  }
  const orderedKeys = [
    ...TAXONOMY_ORDER.filter((k) => counts.has(k)),
    ...[...counts.keys()].filter((k) => !TAXONOMY_ORDER.includes(k)).sort(),
  ];
  const line = orderedKeys.map((k) => `${k} ${counts.get(k)}`).join(" · ");

  return [`## Failure taxonomy (${records.length})`, "", line, ""].join("\n");
}

// ---------------------------------------------------------------------------------------
// Validity panel
// ---------------------------------------------------------------------------------------

function renderValidityPanel(records: TaskRecord[]): string {
  const webOffDenom = records.filter((r) => r.cohort === "web-off").filter(inResolveDenom);

  const preCutoff = webOffDenom.filter((r) => r.post_cutoff === false);
  const postCutoff = webOffDenom.filter((r) => r.post_cutoff === true);
  const preRate = pctStr(resolvedCount(preCutoff), preCutoff.length);
  const postRate = pctStr(resolvedCount(postCutoff), postCutoff.length);

  // ENG-413: report WHY instances were dropped, not one number that calls them all flaky.
  const goldUnresolved = records.filter((r) => r.taxonomy === "dropped-gold-unresolved").length;
  const basePasses = records.filter((r) => r.taxonomy === "dropped-base-passes").length;
  const baseUnstable = records.filter((r) => r.taxonomy === "dropped-base-unstable").length;
  const flakyDropped = records.filter((r) => r.taxonomy === "dropped-flaky").length;
  const unmeasuredControls = records.filter(
    (r) => r.taxonomy === "dropped-base-unmeasured" || r.taxonomy === "dropped-controls-unmeasured",
  ).length;
  const totalDropped =
    goldUnresolved + basePasses + baseUnstable + flakyDropped + unmeasuredControls;

  // Bench-validity, not styre-performance: see `isPrReportDisagreement`. Counted over ALL
  // records, not just the resolve denominator — a reader that is broken on a dropped instance
  // is broken on a scored one too, and we want to hear about it at the first occurrence.
  const prDisagree = records.filter(isPrReportDisagreement);
  const prUnknown = records.filter((r) => r.pr_opened === null);

  const lines: string[] = [];
  lines.push("## Validity panel");
  for (const cohort of ["web-off", "web-on"] as const) {
    const rs = records.filter((r) => r.cohort === cohort);
    const assessed = rs.filter((r) => r.leak_check?.status === "completed");
    const flagged = rs.filter((r) => r.suspected_leak === true);
    lines.push(
      `- ${cohort} heuristic flags: ${flagged.length} recorded; ${assessed.length}/${rs.length} detector assessments explicitly completed. Flags are uncalibrated observations, not proof of solution retrieval or exposure.`,
    );
    const retrospective = assessed.filter(
      (r) => r.leak_check?.status === "completed" && r.leak_check.scope === "transcript-only",
    );
    if (retrospective.length)
      lines.push(
        `- ${cohort}: ${retrospective.length} assessments are retrospective transcript-only scans of retained artifacts. They do not establish original scan completion, complete run capture, or successful network retrieval. Original assessments remain in prior_leak_assessment and the source report.`,
      );
    for (const r of flagged)
      lines.push(
        `- Heuristic observation: ${r.instance} — ${r.leak_reasons.join(", ") || "legacy flag without recorded reason"}.`,
      );
    const counts = new Map<string, number>();
    for (const r of rs) {
      const status =
        r.leak_check?.status === "completed"
          ? (r.leak_check.transcript_scan?.status ?? "unknown")
          : (r.leak_check?.status ?? "legacy-unknown");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    lines.push(
      `- ${cohort} transcript-scan coverage: ${[...counts].map(([k, v]) => `${k} ${v}`).join(" · ") || "no records"}. No findings does not establish scan completion or absence of leakage.`,
    );
    for (const r of rs)
      for (const note of r.reporting_notes ?? [])
        lines.push(`- Evidence note: ${r.instance} — ${note}`);
    for (const r of rs.filter((r) => r.leak_check?.status === "error"))
      lines.push(
        `- Detector failure: ${r.instance} — ${r.leak_check?.reason ?? "reason not recorded"}`,
      );
  }
  lines.push(
    `- pre-cutoff ${preRate} vs post-cutoff ${postRate} resolve (n=${preCutoff.length}/${postCutoff.length})`,
  );
  if (totalDropped === 0) {
    lines.push("- instances dropped by oracle controls before scoring: 0");
  } else {
    lines.push(
      `- instances dropped by oracle controls before scoring: ${totalDropped} ` +
        `(gold fix does not resolve: ${goldUnresolved} · FAIL_TO_PASS already passes on base: ${basePasses} · base preservation failed: ${baseUnstable} · flaky: ${flakyDropped} · controls not measured: ${unmeasuredControls})`,
    );
  }
  if (prDisagree.length > 0) {
    const names = prDisagree.map(
      (r) =>
        `${r.instance} (styre: ${r.pr_self_reported ? "PR" : "no PR"}, forge: ${r.pr_opened ? "PR" : "no PR"})`,
    );
    lines.push(
      `- **⚠ PR ground-truth vs self-report DISAGREE on ${prDisagree.length} instance(s): ${names.join(" · ")}.** One of the two readers is wrong; the PR-opened rate and the self-report gap are both suspect until it is identified.`,
    );
  } else {
    const compared = records.filter(
      (r) => typeof r.pr_opened === "boolean" && typeof r.pr_self_reported === "boolean",
    ).length;
    lines.push(
      `- PR ground-truth vs self-report: ${compared ? `agree on ${compared} comparable instance(s)` : "n/a (no comparable observations)"}; ${records.length - compared} not compared.`,
    );
  }
  if (prUnknown.length > 0) {
    lines.push(
      `- PR state UNDETERMINED (excluded from the PR-opened rate) on ${prUnknown.length} instance(s): ${prUnknown
        .map((r) => `${r.instance} — ${r.pr_lookup_error ?? "reason not recorded"}`)
        .join(" · ")}`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Turns the collected `TaskRecord`s into the §8a markdown report + a machine-readable JSON
 * export. Pure aggregation + string templating — no I/O, no external deps.
 *
 * Each metric uses its own evidence population (report/measurement.ts); taxonomy alone
 * cannot establish a candidate verdict, PR state or a completed detector scan.
 */
export function renderReport(inputRecords: TaskRecord[], meta: ReportMeta): RenderReportResult {
  ReportMetaSchema.parse(meta);
  const records = inputRecords.map(normalizeReportRecord);
  const sections = [
    renderHeadline(records, meta),
    renderGrid(records),
    renderLoopEconomics(records),
    renderJudgmentQuality(records),
    renderTaxonomy(records),
    renderValidityPanel(records),
  ];

  return {
    markdown: sections.join("\n"),
    json: records,
    metrics: {
      webOff: measurePopulation(records.filter((r) => r.cohort === "web-off")),
      webOn: measurePopulation(records.filter((r) => r.cohort === "web-on")),
    },
  };
}
