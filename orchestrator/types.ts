import type { TicketFixOverlap } from "./firewall";

export type Cohort = "web-off" | "web-on";
export type Difficulty = "easy" | "medium" | "hard";
export interface Instance {
  id: string;
  language: "ts" | "python";
  difficulty: Difficulty;
  repo: string;
  base_commit: string;
  problem_statement: string;
  image: string; // pinned Docker image ref
  /** `docker run --platform` value for this instance's image, set by `corpus.ts`'s
   *  normalizers: SWE-bench (Python) uses the host-native arch (`linux/arm64` on Apple
   *  Silicon, else `linux/amd64`) to match its arch-in-the-name image; Multi-SWE-bench (TS)
   *  is always `linux/amd64` (amd64-only images). Optional only so test fixtures needn't set
   *  it — `run-task.ts`'s `buildDockerArgs` defaults an unset value to `linux/amd64`. */
  platform?: string;
  /** Absolute path the eval image has the repo pre-checked-out at, set by `corpus.ts`'s
   *  normalizers: SWE-bench (Python) uses `/testbed`; Multi-SWE-bench (TS) uses
   *  `/home/<repo>` (CONFIRMED against the multi-swe-bench harness — all 230 TS repo classes
   *  `cd /home/{repo}`, none use `/testbed` — and the live darkreader image). The entrypoint
   *  `cd`s here before `styre setup`, so a wrong value dies with "cd: <path>: No such file or
   *  directory". Optional only so fixtures needn't set it — `run-task.ts` defaults an unset
   *  value to `DEFAULT_REPO_DIR_IN_IMAGE` ("/testbed"). */
  repoDirInImage?: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  merge_date?: string; // ISO; for cutoff split
  fix_patch: string; // FIREWALL: the accepted human fix — scorer/reviewer ONLY, NEVER seeded/mounted into styre's env
  test_patch: string; // FIREWALL: the held-out regression tests — scorer ONLY, NEVER seeded/mounted into styre's env
  /** Multi-SWE-bench only: the raw record's `org`/`repo`/`number` fields, populated by
   *  `orchestrator/corpus.ts`'s `normalizeMultiSweBench` (which already reads all three to
   *  build the image tag) so `scorer/adapters/multiswebench.py`'s `MultiSweBenchAdapter`
   *  can consume them directly instead of fragilely re-parsing `id.rsplit("-", 1)`.
   *  Always `undefined` for SWE-bench (Python) instances — `normalizeSweBench` never sets
   *  them. */
  org?: string;
  repo_name?: string;
  pr_number?: number;
}
export interface TaskRecord {
  instance: string;
  language: "ts" | "python";
  difficulty: Difficulty;
  styre_commit: string;
  cohort: Cohort;
  post_cutoff: boolean | null;
  /** `null` iff no oracle verdict exists for this record — currently only `taxonomy:
   *  "unscored"` (SMOKE=2 Option-B oracle-bypass, `orchestrator/pipeline.ts`'s `runInstance`
   *  bypass branch): the Linux-only oracle never ran, so there is nothing to report `true`/
   *  `false` from. Every other taxonomy still sets a real `boolean` (including the
   *  `false` default on `dropped-flaky`/`probe`/`infra`/`parked` — see `blankRecord`). */
  resolved: boolean | null;
  /** GROUND TRUTH (CLAUDE.md move 5): whether a pull request actually exists on the seeded
   *  throwaway repo, read from the forge by `pipeline.ts`'s `lookupPrOpened`.
   *
   *  `null` iff THE LOOKUP COULD NOT FIND OUT (no token, an API failure, or collect threw
   *  before reaching it). That is a different claim from `false` ("we looked; there is no
   *  PR"), and the two must never be collapsed: for two consecutive matrices a failing
   *  `git clone` inside the old lookup was swallowed into `false`, and the report published
   *  a PR-opened rate of 0% and a self-report gap of 0/2 for a run that demonstrably opened
   *  a PR. `report/render.ts` drops `null` from BOTH the numerator and the denominator —
   *  the same rule `ticket_fix_overlap` already follows. */
  pr_opened: boolean | null;
  /** SELF-REPORT: whether styre's own terminal `outcome` claims a PR (`pr-ready` / `done`),
   *  derived in `collect.ts` from the summary event. `null` iff no summary was emitted at
   *  all, so styre made no claim either way.
   *
   *  Kept BESIDE `pr_opened` rather than replacing it: the forge is the ground truth, and
   *  this is the claim being checked against it. Their disagreement is a first-class finding
   *  (`report/render.ts`'s `isPrReportDisagreement`) — had it been reported, the `pr_opened`
   *  defect would have announced itself in matrix #1 instead of being found by hand in #2. */
  pr_self_reported: boolean | null;
  /** Why `pr_opened` is `null` — the swallowed reason, made visible. `null` when the lookup
   *  succeeded. */
  pr_lookup_error: string | null;
  self_authored_test: boolean | null;
  self_test_passed: boolean | null;
  ticks: number;
  cycle_count: number;
  escalation_count: number;
  escalation_reasons: string[];
  outcome: string;
  status: string;
  exit_code: number;
  parked: boolean;
  /** Measured USD, recovered from the run transcript (`usage.ts`, ENG-390). `null` means
   *  UNKNOWN — no transcript, or no `result` event carried a cost. NEVER coerce to `0`:
   *  "not measured" and "free" are different claims, and conflating them is exactly what
   *  let a $11.84 run report $0.50 and made the run budget unable to fire. */
  cost_usd_measured: number | null;
  /** Fallback estimate, charged ONLY when no measured cost could be recovered. Kept separate
   *  so an estimate is never rendered as though it were a measurement. */
  cost_usd_estimated: number;
  tokens_in: number | null;
  tokens_out: number | null;
  /** Absolute path to this attempt's durable evidence dir (ENG-393) — the sot.db/transcript/
   *  profile/ndjson for this run. `null` when the container never ran. */
  evidence_dir: string | null;
  blind_quality: string | null;
  ab_preference: "A(styre)" | "B(human)" | "tie" | "invalid" | null;
  ab_notes: string | null;
  suspected_leak: boolean;
  leak_reasons: string[]; // from detect_leak; canonical bare values (exact-match, never a formatted/suffixed variant): "high-similarity" | "high-containment" | "containment-uninformative" | "web-tool-used" | "pr-url-in-transcript" | "url-in-transcript" | "transcript-unavailable" | "transcript-unstructured-scan" | "similarity-unavailable" — Task 10 validity panel needs this to state whether the URL-scan ran. Issue/PR numbers the HARNESS supplied (via `instance_id` or the problem statement, which for MSB is the upstream PR body) are excused — repeating an identifier you were handed is not evidence of looking one up. NOTE: "containment-uninformative" and "transcript-unstructured-scan" report that a signal could not be assessed; like "transcript-unavailable"/"similarity-unavailable" they never set `suspected` on their own
  /** Free string, not a closed union — see `report/render.ts`'s `TAXONOMY_ORDER` /
   *  `EXCLUDED_FROM_RESOLVE_DENOM` for the canonical known values: "resolved" |
   *  "opened-but-unresolved" | "loop-exhausted" | "probe" | "parked" | "infra" |
   *  "dropped-gold-unresolved" | "dropped-base-passes" | "dropped-flaky" | "unscored"
   *  (SMOKE=2 Option-B oracle-bypass — a successful bypass run with no oracle verdict;
   *  `resolved` is `null` on these records).
   *
   *  ENG-413: the three `dropped-*` values were one `dropped-flaky`. The controls answer three
   *  unrelated questions and only ONE of them is flakiness, so collapsing them put a false
   *  statement in the record: sphinx-doc__sphinx-7590 was reported flaky when its determinism
   *  control PASSED and the human's own fix simply did not resolve the instance. */
  taxonomy: string;
  /** ENG-413: the oracle controls as measured, present only on a `dropped-*` record.
   *  Recovering these after the fact cost a full image build and a re-run, because the
   *  booleans were tested and then discarded. */
  controls?: { gold_resolved: boolean; base_fails: boolean; deterministic: boolean };
  /** ENG-411: how much of the accepted fix / held-out tests the corpus's OWN issue text
   *  already contained, measured by `firewall.ts`'s `measureTicketOverlap`. A record with
   *  `fix_lines === 0 && test_lines === 0` is a "clean ticket" and counts toward the report's
   *  clean-subset resolve rate; the headline rate counts every record, so it stays comparable
   *  with published SWE-bench numbers.
   *
   *  `null` means NOT MEASURED (a record that never got as far as seeding — probe/infra/
   *  parked), which is NOT the same claim as "measured zero" and must never be folded into
   *  the clean subset. Optional so pre-ENG-411 fixtures stay valid. */
  ticket_fix_overlap?: TicketFixOverlap | null;
  /** Task 11: count of whole-instance infra-retries consumed before this record was
   *  finalized (0 if none). Optional/additive — pre-Task-11 code (e.g. report.test.ts's
   *  hand-built fixtures) never sets this and remains valid; `renderReport` does not read
   *  it today. */
  infra_retries?: number;
}
