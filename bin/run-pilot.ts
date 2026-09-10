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
import { reapBenchContainers } from "../orchestrator/container-reaper";
import { runPilot } from "../orchestrator/pipeline";

async function main(): Promise<void> {
  // SMOKE=1 -> run one ts + one python instance (the first-run plumbing test) instead of the
  // full 6-cell pilot, INCLUDING the oracle. SMOKE=2 -> the same one-ts-one-python selection,
  // but BYPASSES the oracle (Option-B): the swebench/multi-swe-bench oracle harnesses are
  // Linux-x86_64-only, so this lets the operator validate the whole pipeline minus the oracle
  // on macOS (seed -> styre-in-container -> collect -> leak-detect -> blind judges).
  // ONLY=<instance_id> -> run exactly that one named SWE / multi-SWE image (skips SMOKE/pilot
  // selection). It ALWAYS bypasses the oracle: the swebench/multi-swe oracle harnesses are
  // Linux-x86_64-only, and ONLY is a fast single-image dev-iteration mode, not a scored run.
  // Reap first. `--rm` removes a container when it EXITS, which a KILLED pilot never causes: the
  // docker client dies and the daemon keeps the container. SIGKILL cannot be trapped, so no
  // handler can cover it — one was found still running four hours after its pilot was killed.
  // Sweeping at start is the only thing that recovers from that, and it costs a `docker ps`.
  const reaped = await reapBenchContainers();
  if (reaped.length > 0) {
    console.error(
      `[run-pilot] reaped ${reaped.length} leftover bench container(s) from a previous run: ${reaped.join(", ")}`,
    );
  }

  const only = process.env.ONLY?.trim() || undefined;
  const smokeEnv = process.env.SMOKE;
  const smoke = smokeEnv === "1" || smokeEnv === "2";
  const bypassOracle = smokeEnv === "2" || Boolean(only);
  if (only) {
    console.error(
      `[run-pilot] ONLY=${only} — single-image run, oracle-BYPASS (dev iteration; SMOKE ignored)`,
    );
  } else if (smoke) {
    console.error(
      bypassOracle
        ? "[run-pilot] SMOKE=2 — oracle-BYPASS: validating pipeline minus the Linux oracle"
        : "[run-pilot] SMOKE=1 — running one ts + one python instance only",
    );
  }
  const result = await runPilot(BENCH_CONFIG, { smoke, only, bypassOracle });
  console.log(result.markdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
