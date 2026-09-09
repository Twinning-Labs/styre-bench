#!/usr/bin/env bun
/**
 * Emits the stdin payload `scorer/score.py score` expects, so a diff produced by a local
 * (macOS) styre run can be scored on x86-64 Linux — the SWE-bench harness needs
 * `sweb.env.py.x86_64.*` images that do not exist for arm64.
 *
 * FIREWALL: this deliberately carries ONLY an instance id, a language and the candidate diff.
 * `SweBenchAdapter.score` reads only `instance["id"]` (scorer/adapters/swebench.py:222) and
 * re-fetches the authoritative record — version, environment_setup_commit, test_patch, the
 * FAIL_TO_PASS/PASS_TO_PASS lists — via `load_swebench_dataset` (:150). Nothing else is needed,
 * and `fix_patch`/`test_patch` (orchestrator/types.ts:29-30) must never enter a committed or
 * uploaded artifact: `/data/` is gitignored precisely so the corpus stays out of the public repo.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface ScorePayload {
  instance: { id: string; language: string };
  candidate_diff: string;
}

/** PURE. The scorer's stdin contract (`scorer/score.py:_COMMANDS["score"]`). */
export function buildScorePayload(
  instanceId: string,
  language: string,
  diff: string,
): ScorePayload {
  return { instance: { id: instanceId, language }, candidate_diff: diff };
}

function main(): void {
  const [id, language, diffFile] = process.argv.slice(2);
  if (!id || !language || !diffFile) {
    console.error("usage: bun bin/emit-score-payload.ts <instance-id> <language> <diff-file>");
    process.exit(64);
  }
  const diff = readFileSync(diffFile, "utf8");
  writeFileSync(1, `${JSON.stringify(buildScorePayload(id, language, diff))}\n`);
}

if (import.meta.main) main();
