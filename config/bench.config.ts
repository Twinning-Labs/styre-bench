import { z } from "zod";
export const BenchConfig = z.object({
  styreRepo: z.string().default("https://github.com/Twinning-Labs/styre.git"),
  styreCommit: z.string().default("a2406a431f3168e59b29a988473b2b3bca5a14dd"), // feat/polyglot-setup HEAD (full sha — short shas are ambiguous on fetch)
  cohort: z.enum(["web-off", "web-on"]).default("web-off"),
  pythonCorpus: z.enum(["swe-bench-verified", "swe-bench"]).default("swe-bench-verified"), // §11 pinned: Verified (human-validated)
  tsCorpus: z.literal("multi-swe-bench").default("multi-swe-bench"),
  modelCutoff: z.string().default("2025-01-01"), // instances merged after -> post_cutoff
  seed: z.number().default(42),
  perTaskCostCapUsd: z.number().default(15),
  runBudgetUsd: z.number().default(150),
  concurrency: z.number().default(3),
  benchGithubOrg: z.string().default("styre-bench-scratch"),
  linearProjectId: z.string().default(""), // dedicated throwaway project
});
export const BENCH_CONFIG = BenchConfig.parse({});
