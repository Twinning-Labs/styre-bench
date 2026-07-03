#!/usr/bin/env bun
/**
 * The pilot runner entrypoint: `bun bin/run-pilot.ts`. Drives `runPilot(BENCH_CONFIG)` —
 * `selectPilot` -> `buildStyre` -> `runPool` (map `runInstance` at `concurrency`, respecting
 * `runBudgetUsd`) -> `renderReport` -> write `report/out/report.md` + `report/out/report.json`
 * (Task 11). Requires `ANTHROPIC_API_KEY`/`LINEAR_API_KEY`/`GITHUB_TOKEN`/`BENCH_GH_TOKEN`
 * (see `.env.example`) and a Docker daemon — this is a LIVE entrypoint, never exercised by
 * `bun test` (which stubs every external stage — see `tests/pipeline.test.ts`).
 */
import { BENCH_CONFIG } from "../config/bench.config";
import { runPilot } from "../orchestrator/pipeline";

async function main(): Promise<void> {
  // SMOKE=1 -> run one ts + one python instance (the first-run plumbing test) instead of the
  // full 6-cell pilot, INCLUDING the oracle. SMOKE=2 -> the same one-ts-one-python selection,
  // but BYPASSES the oracle (Option-B): the swebench/multi-swe-bench oracle harnesses are
  // Linux-x86_64-only, so this lets the operator validate the whole pipeline minus the oracle
  // on macOS (seed -> styre-in-container -> collect -> leak-detect -> blind judges).
  const smokeEnv = process.env.SMOKE;
  const smoke = smokeEnv === "1" || smokeEnv === "2";
  const bypassOracle = smokeEnv === "2";
  if (smoke) {
    console.error(
      bypassOracle
        ? "[run-pilot] SMOKE=2 — oracle-BYPASS: validating pipeline minus the Linux oracle"
        : "[run-pilot] SMOKE=1 — running one ts + one python instance only",
    );
  }
  const result = await runPilot(BENCH_CONFIG, { smoke, bypassOracle });
  console.log(result.markdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
