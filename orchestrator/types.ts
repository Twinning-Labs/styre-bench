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
}
export interface TaskRecord {
  instance: string;
  language: string;
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
  taxonomy: string;
}
