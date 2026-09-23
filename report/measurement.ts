import { z } from "zod";
import { LeakCheckSchema } from "../orchestrator/leak-contract";
import type { TaskRecord } from "../orchestrator/types";

const count = z.number().int().nonnegative();
const RecordSchema = z.object({
  instance: z.string().min(1),
  taxonomy: z.string().min(1),
  outcome: z.string(),
  evidence_dir: z.string().nullable(),
  cohort: z.enum(["web-off", "web-on"]),
  language: z.enum(["ts", "python"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  resolved: z.boolean().nullable(),
  score_attempted: z.boolean().optional(),
  pr_opened: z.boolean().nullable(),
  pr_self_reported: z.boolean().nullable(),
  post_cutoff: z.boolean().nullable(),
  ticks: count,
  cycle_count: count,
  escalation_count: count,
  escalation_reasons: z.array(z.string()),
  leak_reasons: z.array(z.string()),
  suspected_leak: z.boolean().nullable(),
  blind_quality: z.string().nullable(),
  ab_preference: z.enum(["A(styre)", "B(human)", "tie", "invalid"]).nullable(),
  cost_usd_measured: z.number().finite().nonnegative().nullable(),
  leak_check: LeakCheckSchema.optional(),
  prior_leak_assessment: z
    .object({ suspected: z.boolean().nullable(), reasons: z.array(z.string()) })
    .optional(),
  reporting_notes: z.array(z.string()).optional(),
  test_configuration: z
    .object({ status: z.enum(["declared", "none", "unreadable"]), components: z.array(z.string()) })
    .refine(
      (c) => (c.status === "declared") === c.components.length > 0,
      "test configuration status must match declarations",
    )
    .optional(),
  ticket_fix_overlap: z
    .object({
      fix_lines: count,
      test_lines: count,
      method: z.literal("exact-trimmed-added-lines-v2").optional(),
      sample: z.array(z.string()),
    })
    .passthrough()
    .nullable()
    .optional(),
  controls: z
    .object({
      gold_resolved: z.boolean().nullable(),
      base_fails: z.boolean().nullable(),
      deterministic: z.boolean().nullable(),
      base_preserved: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

export function wasSubmitted(r: TaskRecord): boolean {
  return r.score_attempted ?? (hasOracleVerdict(r) || r.taxonomy === "oracle-unmeasured");
}

const LEGACY_SCORED = new Set(["resolved", "opened-but-unresolved", "loop-exhausted"]);

/** Explicit submission provenance wins. Older ambiguous defaults are not oracle verdicts. */
export function hasOracleVerdict(r: TaskRecord): boolean {
  return (
    typeof r.resolved === "boolean" &&
    (r.score_attempted === true ||
      (r.score_attempted === undefined && LEGACY_SCORED.has(r.taxonomy)))
  );
}

export function controlsQualified(r: TaskRecord): boolean {
  const c = r.controls;
  return (
    c?.gold_resolved === true &&
    c.base_fails === true &&
    c.deterministic === true &&
    c.base_preserved !== false &&
    (!c.oracle_profile || c.base_preserved === true)
  );
}

/** Normalize old records without mutating the preserved input. Never invent a measurement. */
export function normalizeReportRecord(r: TaskRecord): TaskRecord {
  RecordSchema.parse(r);
  if (r.score_attempted === false && r.resolved !== null)
    throw new Error(`${r.instance}: oracle verdict conflicts with score_attempted=false`);
  if (
    r.leak_check &&
    (r.leak_check.status === "completed") !== (typeof r.suspected_leak === "boolean")
  )
    throw new Error(`${r.instance}: detector status conflicts with heuristic assessment`);
  const normalized = { ...r };
  const notes = [...(r.reporting_notes ?? [])];
  if (!hasOracleVerdict(r) && r.resolved !== null) {
    normalized.resolved = null;
    notes.push("Legacy resolved default discarded: no candidate oracle measurement provenance.");
  }
  const beforeRun =
    (r.taxonomy.startsWith("dropped-") && r.evidence_dir === null) ||
    (r.taxonomy === "probe" &&
      r.status === "styre setup failed — no usable profile produced (setup/enrichment gap)");
  if (beforeRun && r.outcome === "" && r.pr_self_reported === false) {
    normalized.pr_self_reported = null;
    notes.push("Run did not start: no Styre self-report exists to compare with PR state.");
  }
  if (notes.length) normalized.reporting_notes = notes;
  return normalized;
}

export type Rate = { numerator: number; denominator: number };
const rate = (rs: TaskRecord[], match: (r: TaskRecord) => boolean): Rate => ({
  numerator: rs.filter(match).length,
  denominator: rs.length,
});

/** Each metric owns its measured population; taxonomy is not a substitute for provenance. */
export function measurePopulation(records: TaskRecord[]) {
  const measured = records.filter(hasOracleVerdict);
  const qualified = records.filter(controlsQualified);
  const prs = records.filter((r) => typeof r.pr_opened === "boolean");
  const comparable = measured.filter((r) => typeof r.pr_opened === "boolean");
  return {
    recorded: records.length,
    qualified: qualified.length,
    qualificationUnknown: records.filter((r) => {
      const c = r.controls;
      if (!c) return true;
      if (
        c.gold_resolved === false ||
        c.base_fails === false ||
        c.deterministic === false ||
        c.base_preserved === false
      )
        return false;
      return (
        c.gold_resolved === null ||
        c.base_fails === null ||
        c.deterministic === null ||
        Boolean(c.oracle_profile && c.base_preserved === undefined)
      );
    }).length,
    submitted: records.filter(wasSubmitted).length,
    oracleResolved: rate(measured, (r) => r.resolved === true),
    confirmedDelivery: rate(
      qualified,
      (r) => hasOracleVerdict(r) && r.resolved === true && r.pr_opened === true,
    ),
    prOpened: rate(prs, (r) => r.pr_opened === true),
    openedUnresolved: rate(comparable, (r) => r.pr_opened === true && r.resolved === false),
  };
}
