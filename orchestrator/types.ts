export type Cohort = "web-off" | "web-on";
export type Difficulty = "easy" | "medium" | "hard";
export interface Instance {
  id: string;
  language: "ts" | "python";
  difficulty: Difficulty;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints?: string;
  image: string; // pinned Docker image ref
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
  resolved: boolean;
  pr_opened: boolean;
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
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  blind_quality: string | null;
  ab_preference: "A(styre)" | "B(human)" | "tie" | "invalid" | null;
  ab_notes: string | null;
  suspected_leak: boolean;
  leak_reasons: string[]; // from detect_leak; canonical bare values (exact-match, never a formatted/suffixed variant): "high-similarity" | "high-containment" | "pr-url-in-transcript" | "url-in-transcript" | "transcript-unavailable" | "similarity-unavailable" — Task 10 validity panel needs this to state whether the URL-scan ran
  taxonomy: string;
  /** Task 11: count of whole-instance infra-retries consumed before this record was
   *  finalized (0 if none). Optional/additive — pre-Task-11 code (e.g. report.test.ts's
   *  hand-built fixtures) never sets this and remains valid; `renderReport` does not read
   *  it today. */
  infra_retries?: number;
}
