import type { Difficulty, TaskRecord } from "../orchestrator/types";

/** Run-level metadata for the report header — NOT derived from `records` (styre commit,
 * dataset, sampling seed, budget, run date are properties of the run, not of any task). */
export interface ReportMeta {
  /** e.g. "feat/polyglot-setup @ a2406a4" */
  styreRef: string;
  /** e.g. "Multi-SWE-bench v1 + SWE-bench Verified" */
  dataset: string;
  seed: number;
  /** ISO date, e.g. "2026-07-15" */
  runDate: string;
  budgetUsd: number;
  spentUsd?: number;
  /** Count of instances the `runBudgetUsd` kill-switch (`runPool`'s `skipped`) prevented from
   *  ever starting — i.e. this run is budget-truncated, not a complete run over the selected
   *  pilot set. `undefined`/`0` renders nothing (Task-11 capstone Fix 4: a truncated run must
   *  never render as if it were a smaller-but-complete one). */
  skippedCount?: number;
  /** Defaults to "Styre-Bench Report". */
  title?: string;
}

export interface RenderReportResult {
  markdown: string;
  json: TaskRecord[];
}

/**
 * DENOMINATOR HYGIENE (the load-bearing correctness rule — reviews have hammered this):
 * these taxonomies never received a trustworthy oracle verdict (flaky-dropped before styre
 * ever ran, an unusable `styre setup` profile, a parked/resumable run, an infra/tooling
 * failure, or — SMOKE=2 Option-B — the oracle was deliberately BYPASSED so no verdict was
 * ever produced) — they must NEVER appear in the resolve-rate / self-report-gap /
 * PR-opened-rate denominators. They are reported separately (taxonomy histogram + validity
 * panel), and their cost/blind_quality/ab_preference still populate the sections that aren't
 * gated on a `resolved` verdict (see `renderJudgmentQuality`'s `reviewed`/`abEligible`).
 */
const EXCLUDED_FROM_RESOLVE_DENOM = new Set([
  "dropped-flaky",
  "probe",
  "infra",
  "parked",
  "unscored",
]);

function inResolveDenom(r: TaskRecord): boolean {
  return !EXCLUDED_FROM_RESOLVE_DENOM.has(r.taxonomy);
}

function resolvedCount(rs: TaskRecord[]): number {
  return rs.filter((r) => r.resolved).length;
}

/** true iff `r` counts toward the "self-report gap": styre opened a PR (self-reported
 * success) but the oracle says it did not actually resolve the issue. */
function isSelfReportGap(r: TaskRecord): boolean {
  return r.pr_opened && !r.resolved;
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
  if (nums.length === 0) return 0;
  const s = sortedNums(nums);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) {
    return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  }
  return s[mid] ?? 0;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = sortedNums(nums);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx] ?? 0;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt1(n: number): string {
  return n.toFixed(1);
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

  const gapOff = webOff.filter(isSelfReportGap).length;
  const gapOn = webOn.filter(isSelfReportGap).length;
  const gapPost = postCutoff.filter(isSelfReportGap).length;

  const prOff = webOff.filter((r) => r.pr_opened).length;
  const prOn = webOn.filter((r) => r.pr_opened).length;
  const prPost = postCutoff.filter((r) => r.pr_opened).length;

  const cohortLabel =
    webOnAll.length > 0 ? "web-OFF (headline) + web-on delta" : "web-OFF (headline)";

  const lines: string[] = [];
  lines.push(`# ${meta.title ?? "Styre-Bench Report"}`);
  lines.push("");
  lines.push(`styre: ${meta.styreRef} · dataset: ${meta.dataset} · seed: ${meta.seed}`);
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
    `| Self-report gap (opened-unresolved) | ${absCell(gapOff, webOff.length)} | ${deltaCell(gapOff, webOff.length, gapOn, webOn.length)} | ${absCell(gapPost, postCutoff.length)} |`,
  );
  lines.push(
    `| PR-opened rate | ${absCell(prOff, webOff.length)} | ${deltaCell(prOff, webOff.length, prOn, webOn.length)} | ${absCell(prPost, postCutoff.length)} |`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Resolve grid — language x difficulty (web-off cohort)
// ---------------------------------------------------------------------------------------

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

function gridCell(cellAll: TaskRecord[]): string {
  const denom = cellAll.filter(inResolveDenom);
  const hasProbe = cellAll.some((r) => r.taxonomy === "probe");
  const base = denom.length === 0 ? "-" : `${resolvedCount(denom)}/${denom.length}`;
  return hasProbe ? `${base} ⚠` : base;
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
    "⚠ marks a cell containing a `probe` finding (an unusable `styre setup` profile) — read as detector-coverage, not loop performance; `probe` instances are excluded from the N/total shown.",
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
    cost: rs.map((r) => r.cost_usd),
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
  lines.push(`| cost / instance (med) | $${fmt2(median(gr.cost))} | $${fmt2(median(gu.cost))} |`);

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
 * Only `"addresses-issue"` predicts resolved=true; every other verdict (partial,
 * does-not-address, test-gaming-suspected, unparsed, ...) predicts resolved=false. This
 * mapping is this renderer's own scoring convention (§8 does not pin one down), documented
 * here so it's auditable rather than implicit. */
function blindQualityPredictsResolved(verdict: string): boolean {
  return verdict === "addresses-issue";
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
      r.blind_quality !== null && r.resolved !== null,
  );
  const agreementMatches = reviewed.filter(
    (r) => blindQualityPredictsResolved(r.blind_quality) === r.resolved,
  ).length;
  if (reviewed.length > 0) {
    lines.push(
      `- Review↔oracle agreement: ${fmt2(agreementMatches / reviewed.length)} (blind reviewer predicts ground truth ${pctStr(agreementMatches, reviewed.length)} of the time, n=${reviewed.length})`,
    );
  } else {
    lines.push("- Review↔oracle agreement: n/a (no blind-quality reviews recorded)");
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
  "loop-exhausted",
  "probe",
  "parked",
  "infra",
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
  const webOnAll = records.filter((r) => r.cohort === "web-on");
  const webOffDenom = records.filter((r) => r.cohort === "web-off").filter(inResolveDenom);

  const leakCount = webOnAll.filter((r) => r.suspected_leak).length;

  const preCutoff = webOffDenom.filter((r) => r.post_cutoff === false);
  const postCutoff = webOffDenom.filter((r) => r.post_cutoff === true);
  const preRate = pctStr(resolvedCount(preCutoff), preCutoff.length);
  const postRate = pctStr(resolvedCount(postCutoff), postCutoff.length);

  const flakyDropped = records.filter((r) => r.taxonomy === "dropped-flaky").length;

  const scanNotRun = records.filter((r) => r.leak_reasons.includes("transcript-unavailable"));

  const lines: string[] = [];
  lines.push("## Validity panel");
  if (webOnAll.length > 0) {
    lines.push(
      `- web-on suspected-leak: ${leakCount}/${webOnAll.length} (${pctStr(leakCount, webOnAll.length)})`,
    );
  } else {
    lines.push("- web-on suspected-leak: n/a (no web-on cohort in this run)");
  }
  lines.push(
    `- pre-cutoff ${preRate} vs post-cutoff ${postRate} resolve (n=${preCutoff.length}/${postCutoff.length})`,
  );
  lines.push(`- flaky instances dropped by oracle controls before scoring: ${flakyDropped}`);
  if (scanNotRun.length > 0) {
    lines.push(
      `- URL-scan: did NOT run for ${scanNotRun.length} instance(s) (transcript-unavailable) — leak status for these is UNKNOWN, not assumed clean.`,
    );
  } else {
    lines.push("- URL-scan: ran for all instances.");
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Turns the collected `TaskRecord`s into the §8a markdown report + a machine-readable JSON
 * export. Pure aggregation + string templating — no I/O, no external deps.
 *
 * DENOMINATOR HYGIENE (see `EXCLUDED_FROM_RESOLVE_DENOM`): `dropped-flaky` / `probe` /
 * `infra` / `parked` instances never reached a trustworthy oracle verdict and are excluded
 * from every resolve-rate-style denominator; their counts are reported separately in the
 * taxonomy histogram and validity panel instead of silently vanishing.
 */
export function renderReport(records: TaskRecord[], meta: ReportMeta): RenderReportResult {
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
  };
}
