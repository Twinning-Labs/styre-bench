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
  const result = await runPilot(BENCH_CONFIG);
  console.log(result.markdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
