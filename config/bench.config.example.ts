// EXAMPLE / TEMPLATE. Copy to the git-ignored real config, then fill in your values:
//   cp config/bench.config.example.ts config/bench.config.ts
// The real config/bench.config.ts holds operator-specific values (the styre commit pin,
// the throwaway Linear project id) and is git-ignored so those never get committed.
import { z } from "zod";
export const BenchConfig = z.object({
  styreRepo: z.string().default("https://github.com/Twinning-Labs/styre.git"),
  styreCommit: z.string().default(""), // FILL IN: styre commit to bench (full sha — short shas are ambiguous on fetch)
  cohort: z.enum(["web-off", "web-on"]).default("web-off"),
  pythonCorpus: z.enum(["swe-bench-verified", "swe-bench"]).default("swe-bench-verified"), // §11 pinned: Verified (human-validated)
  tsCorpus: z.literal("multi-swe-bench").default("multi-swe-bench"),
  modelCutoff: z.string().default("2025-01-01"), // instances merged after -> post_cutoff
  seed: z.number().default(42),
  perTaskCostCapUsd: z.number().default(15),
  runBudgetUsd: z.number().default(150),
  concurrency: z.number().default(3),
  benchGithubOrg: z.string().default("styre-bench-scratch"),
  linearProjectId: z.string().default(""), // FILL IN: dedicated throwaway Linear project id
});
export const BENCH_CONFIG = BenchConfig.parse({});
