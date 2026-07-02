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
  ab_preference: "A(styre)" | "B(human)" | "tie" | null;
  ab_notes: string | null;
  suspected_leak: boolean;
  leak_reasons: string[]; // from detect_leak; canonical bare values (exact-match, never a formatted/suffixed variant): "high-similarity" | "high-containment" | "pr-url-in-transcript" | "url-in-transcript" | "transcript-unavailable" | "similarity-unavailable" — Task 10 validity panel needs this to state whether the URL-scan ran
  taxonomy: string;
}
