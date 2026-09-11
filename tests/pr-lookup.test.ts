import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type PrSummary,
  defaultCollectStage,
  lookupPrOpened,
  runInstance,
} from "../orchestrator/pipeline";
import type { PipelineConfig, PipelineDeps } from "../orchestrator/pipeline";
import type { RunStyreResult } from "../orchestrator/run-task";
import type { Instance } from "../orchestrator/types";

/**
 * ENG: `pr_opened` read FALSE on every instance of matrix #1 and #2, on a host where styre
 * demonstrably opened a PR (`.../pull/1` is in django-12325's own run.ndjson).
 *
 * ROOT CAUSE. The old `fetchPrDiff` found the PR, then cloned the repo to compute a diff its
 * only caller discarded, and returned `pr_opened: true` only AFTER the clone. Scratch repos
 * are created `private: true` (seed-github.ts), the orchestrator process has no git credential
 * helper (the one in run-task.ts is configured INSIDE the container), so the clone failed
 * with "Repository not found" on every call. The throw was swallowed by
 * `.catch(() => ({ pr_opened: false }))`, so an unobservable metric rendered as a measured
 * zero -- taking the PR-opened rate and the self-report gap with it.
 *
 * The fix is not "move the return above the clone": the clone has no reason to exist at all.
 * These tests pin BOTH halves -- the tri-state contract, and the absence of the clone.
 */

const SEED = {
  repoUrl: "https://github.com/styre-bench-scratch/bench-x.git",
  defaultBranch: "main",
  ident: "BENCH-1",
};

describe("lookupPrOpened: tri-state", () => {
  test("a PR exists -> true, with no error", async () => {
    const list = async (): Promise<PrSummary[]> => [{ number: 1 }];
    expect(await lookupPrOpened(SEED, list)).toEqual({ pr_opened: true, error: null });
  });

  test("no PR exists -> false (a real measurement, not a guess)", async () => {
    const list = async (): Promise<PrSummary[]> => [];
    expect(await lookupPrOpened(SEED, list)).toEqual({ pr_opened: false, error: null });
  });

  test("the lookup FAILS -> null + the reason, never false", async () => {
    const list = async (): Promise<PrSummary[]> => {
      throw new Error("HttpError: Not Found");
    };
    const got = await lookupPrOpened(SEED, list);
    // The whole point: "we could not find out" must not be reported as "there was no PR".
    expect(got.pr_opened).toBeNull();
    expect(got.error).toMatch(/Not Found/);
  });

  test("an unparseable repoUrl -> null + the reason, never false", async () => {
    const list = async (): Promise<PrSummary[]> => [{ number: 1 }];
    const got = await lookupPrOpened({ ...SEED, repoUrl: "not-a-github-url" }, list);
    expect(got.pr_opened).toBeNull();
    expect(got.error).toMatch(/owner\/repo/);
  });
});

describe("lookupPrOpened: the PR lookup must never touch git", () => {
  /**
   * A grep-level invariant, for the same reason `check-executor-invariant.test.ts` is one:
   * the defect was a line that should not have been there, and no behavioural test of the
   * happy path can stop someone re-introducing a clone "just to compute the diff again".
   * The diff is deliberately discarded by the caller (see defaultCollectStage) -- the clone
   * can only ever subtract.
   */
  test("the source between lookupPrOpened and its closing brace contains no git call", () => {
    const src = readFileSync("orchestrator/pipeline.ts", "utf8");
    const start = src.indexOf("export async function lookupPrOpened");
    expect(start).toBeGreaterThan(-1);
    // The next top-level `export ` / `function ` after it bounds the body well enough here.
    const rest = src.slice(start);
    const end = rest.indexOf("\n}\n");
    const body = rest.slice(0, end);
    expect(body).not.toMatch(/git\s+clone/);
    expect(body).not.toMatch(/\$`git/);
    expect(body).not.toMatch(/mkdtemp/);
  });
});

// ---------------------------------------------------------------------------------------
// The two paths that reach a record WITHOUT the lookup ever running. Both used to report
// `pr_opened: false` -- a guess wearing a measurement's clothes. Both must report `null`.
// ---------------------------------------------------------------------------------------

const NO_FILES: RunStyreResult = {
  ndjsonPath: "/nonexistent/run.ndjson",
  transcriptPath: "/nonexistent/transcript.jsonl",
  profilePath: "/nonexistent/profile.json",
  rawCandidateDiffPath: "/nonexistent/candidate.diff",
  baselineShaPath: "/nonexistent/baseline-sha.txt",
  exitCode: 0,
  outDir: "/nonexistent",
};

function inst(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    language: "python",
    difficulty: "medium",
    repo: "o/r",
    base_commit: "deadbeef",
    problem_statement: "boom",
    image: "img:latest",
    fail_to_pass: ["t"],
    pass_to_pass: [],
    fix_patch: "",
    test_patch: "",
    ...overrides,
  };
}

describe("no GITHUB_TOKEN -> undetermined, not 'no PR'", () => {
  test("a null lister yields pr_opened:null and says why", async () => {
    // `defaultCollectStage`'s lister defaults to null when the token is absent. Reporting
    // `false` here would mean "we checked the forge and styre opened nothing" on a host that
    // never checked anything at all.
    const stage = await defaultCollectStage(inst(), SEED, NO_FILES, null);
    expect(stage.pr_opened).toBeNull();
    expect(stage.pr_lookup_error).toMatch(/GITHUB_TOKEN/);
  });

  test("a working lister on the same inputs still yields a real verdict", async () => {
    const stage = await defaultCollectStage(inst(), SEED, NO_FILES, async () => []);
    expect(stage.pr_opened).toBe(false);
    expect(stage.pr_lookup_error).toBeNull();
  });
});

describe("collect threw before the lookup -> undetermined, not 'no PR'", () => {
  test("an infra record from a crashed collect carries pr_opened:null + the reason", async () => {
    const cfg = {
      cohort: "web-off",
      styreCommit: "abc1234",
      modelCutoff: "2030-01-01",
      benchGithubOrg: "org",
      linearProjectId: "proj",
      evidenceRoot: "/tmp/evidence",
      concurrency: 1,
      runBudgetUsd: 100,
    } as unknown as PipelineConfig;

    const deps = {
      runControls: async () => ({ gold_resolved: true, base_fails: true, deterministic: true }),
      seed: async () => SEED,
      run: async () => NO_FILES,
      // The container ran. We crashed reading its artifacts -- so whether it opened a PR is
      // something we never got far enough to find out.
      collect: async () => {
        throw new Error("ENOENT: candidate diff vanished");
      },
      score: async () => ({ resolved: false }),
      runSelfTest: async () => ({ passed: null }),
      detectLeak: async () => ({ suspected: false, reasons: [] }),
      blindQuality: async () => ({ verdict: "does-not-address", notes: "" }),
      abReview: async () => ({ preference: "B(human)" as const, notes: "" }),
      cleanup: async () => {},
    } as unknown as PipelineDeps;

    const record = await runInstance(inst(), { "linux/amd64": "/bin/styre" }, cfg, {
      deps,
      preflightOracle: async (languages: string[]) =>
        Object.fromEntries(languages.map((l) => [l, { ok: true, detail: "stubbed" }])),
    } as never);

    expect(record.taxonomy).toBe("infra");
    expect(record.pr_opened).toBeNull();
    expect(record.pr_lookup_error).toMatch(/did not reach the PR lookup/);
  });
});
