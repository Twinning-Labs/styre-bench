import { describe, expect, test } from "bun:test";
import {
  type CollectStageResult,
  type LeakResult,
  type PipelineConfig,
  type PipelineDeps,
  type RunControlsResult,
  type RunPilotDeps,
  type RunPoolOpts,
  type ScoreResult,
  type SelfTestResult,
  resolvePythonBin,
  runInstance,
  runPilot,
  runPool,
} from "../orchestrator/pipeline";
import type { RunSeed, RunStyreResult } from "../orchestrator/run-task";
import type { Instance, TaskRecord } from "../orchestrator/types";

// The styre binaries map every runInstance/runPool/buildStyre stub uses. makeInstance()
// fixtures leave `platform` unset, so the pipeline resolves them at the default "linux/amd64"
// key (see pipeline.ts's resolveBinary).
const STYRE_BINS: Record<string, string> = { "linux/amd64": "/bin/styre" };

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    language: "ts",
    difficulty: "easy",
    repo: "acme/widget",
    base_commit: "deadbeef",
    problem_statement: "Fix the thing.",
    image: "mswebench/acme_m_widget:pr-1",
    fail_to_pass: ["tests/x.test.ts"],
    pass_to_pass: [],
    fix_patch:
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-1\n+2\n",
    test_patch:
      "diff --git a/tests/x.test.ts b/tests/x.test.ts\n--- /dev/null\n+++ b/tests/x.test.ts\n",
    ...overrides,
  };
}

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    styreRepo: "https://github.com/Twinning-Labs/styre.git",
    styreCommit: "a2406a4",
    cohort: "web-off",
    pythonCorpus: "swe-bench-verified",
    tsCorpus: "multi-swe-bench",
    modelCutoff: "2025-01-01",
    seed: 42,
    perTaskCostCapUsd: 15,
    runBudgetUsd: 150,
    concurrency: 3,
    benchGithubOrg: "styre-bench-scratch",
    linearProjectId: "proj-1",
    ...overrides,
  };
}

const VALID_CONTROLS: RunControlsResult = {
  gold_resolved: true,
  base_fails: true,
  deterministic: true,
};

const FLAKY_CONTROLS: RunControlsResult = {
  gold_resolved: true,
  base_fails: true,
  deterministic: false,
};

const SEED: RunSeed = {
  repoUrl: "https://github.com/org/repo.git",
  defaultBranch: "main",
  ident: "BENCH-1",
};
const RUN_RESULT: RunStyreResult = {
  ndjsonPath: "/tmp/run.ndjson",
  transcriptPath: "/tmp/transcript.jsonl",
  profilePath: "/tmp/profile.json",
  exitCode: 0,
};

function pendingStage(overrides: Partial<CollectStageResult["record"]> = {}): CollectStageResult {
  return {
    record: {
      self_authored_test: true,
      self_test_passed: true,
      ticks: 5,
      cycle_count: 1,
      escalation_count: 0,
      escalation_reasons: [],
      outcome: "pr-ready",
      status: "ok",
      cost_usd: 1.5,
      tokens_in: 100,
      tokens_out: 50,
      parked: false,
      ...overrides,
    },
    diff: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-1\n+2\n",
    addedTestPaths: ["tests/y.test.ts"],
    transcript: "",
    pr_opened: true,
  };
}

function infraStage(): CollectStageResult {
  return {
    record: { taxonomy: "infra", cost_usd: 0.2 },
    diff: "",
    addedTestPaths: [],
    transcript: "",
    pr_opened: false,
  };
}

function probeStage(): CollectStageResult {
  return {
    record: { taxonomy: "probe", cost_usd: 0.1, self_authored_test: null, self_test_passed: null },
    diff: "",
    addedTestPaths: [],
    transcript: "",
    pr_opened: false,
  };
}

const SCORE_RESOLVED: ScoreResult = { resolved: true, fail_to_pass: {}, pass_to_pass: {} };
const SCORE_UNRESOLVED: ScoreResult = { resolved: false, fail_to_pass: {}, pass_to_pass: {} };
const LEAK_CLEAN: LeakResult = { suspected: false, reasons: [] };

interface Calls {
  runControls: number;
  seed: number;
  run: number;
  collect: number;
  score: number;
  runSelfTest: number;
  detectLeak: number;
  blindQuality: number;
  abReview: number;
  cleanup: number;
}

function trackedDeps(overrides: Partial<PipelineDeps> = {}): { deps: PipelineDeps; calls: Calls } {
  const calls: Calls = {
    runControls: 0,
    seed: 0,
    run: 0,
    collect: 0,
    score: 0,
    runSelfTest: 0,
    detectLeak: 0,
    blindQuality: 0,
    abReview: 0,
    cleanup: 0,
  };

  const deps: PipelineDeps = {
    runControls: async (inst) => {
      calls.runControls++;
      return overrides.runControls ? overrides.runControls(inst) : VALID_CONTROLS;
    },
    seed: async (inst, cfg) => {
      calls.seed++;
      return overrides.seed ? overrides.seed(inst, cfg) : SEED;
    },
    run: async (inst, seed, binaryPath, cfg) => {
      calls.run++;
      return overrides.run ? overrides.run(inst, seed, binaryPath, cfg) : RUN_RESULT;
    },
    collect: async (inst, seed, result) => {
      calls.collect++;
      return overrides.collect ? overrides.collect(inst, seed, result) : pendingStage();
    },
    score: async (inst, diff) => {
      calls.score++;
      return overrides.score ? overrides.score(inst, diff) : SCORE_RESOLVED;
    },
    runSelfTest: async (inst, diff, addedTestPaths) => {
      calls.runSelfTest++;
      if (overrides.runSelfTest) return overrides.runSelfTest(inst, diff, addedTestPaths);
      return { passed: true } satisfies SelfTestResult;
    },
    detectLeak: async (diff, fixPatch, transcript) => {
      calls.detectLeak++;
      return overrides.detectLeak ? overrides.detectLeak(diff, fixPatch, transcript) : LEAK_CLEAN;
    },
    blindQuality: async (issue, diff) => {
      calls.blindQuality++;
      return overrides.blindQuality
        ? overrides.blindQuality(issue, diff)
        : { verdict: "addresses-issue", notes: "" };
    },
    abReview: async (issue, diff, fixPatch, instanceId, seed) => {
      calls.abReview++;
      return overrides.abReview
        ? overrides.abReview(issue, diff, fixPatch, instanceId, seed)
        : { preference: "A(styre)", notes: "" };
    },
    cleanup: async (ctx) => {
      calls.cleanup++;
      if (overrides.cleanup) return overrides.cleanup(ctx);
    },
  };

  return { deps, calls };
}

describe("runInstance: FAIL-CLOSED DROP CONTRACT (Task-3 crux)", () => {
  test("deterministic:false -> taxonomy dropped-flaky, styre NEVER invoked", async () => {
    const { deps, calls } = trackedDeps({ runControls: async () => FLAKY_CONTROLS });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.taxonomy).toBe("dropped-flaky");
    expect(rec.resolved).toBe(false);
    expect(calls.runControls).toBe(1);
    expect(calls.seed).toBe(0);
    expect(calls.run).toBe(0);
    expect(calls.collect).toBe(0);
    expect(calls.score).toBe(0);
    expect(calls.blindQuality).toBe(0);
    expect(calls.abReview).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  test("gold_resolved:false -> dropped-flaky, styre never invoked", async () => {
    const { deps, calls } = trackedDeps({
      runControls: async () => ({ gold_resolved: false, base_fails: true, deterministic: true }),
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });
    expect(rec.taxonomy).toBe("dropped-flaky");
    expect(calls.seed).toBe(0);
  });

  test("base_fails:false -> dropped-flaky, styre never invoked", async () => {
    const { deps, calls } = trackedDeps({
      runControls: async () => ({ gold_resolved: true, base_fails: false, deterministic: true }),
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });
    expect(rec.taxonomy).toBe("dropped-flaky");
    expect(calls.seed).toBe(0);
  });

  test("all controls true -> proceeds to seed/run/collect", async () => {
    const { deps, calls } = trackedDeps();
    await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });
    expect(calls.seed).toBe(1);
    expect(calls.run).toBe(1);
    expect(calls.collect).toBe(1);
  });
});

describe("runInstance: whole-instance infra-retry", () => {
  test("taxonomy:infra once then success -> retried once, final record non-infra, infra_retries recorded", async () => {
    let attempt = 0;
    const { deps, calls } = trackedDeps({
      collect: async () => {
        attempt++;
        return attempt === 1 ? infraStage() : pendingStage();
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(calls.seed).toBe(2);
    expect(calls.run).toBe(2);
    expect(calls.collect).toBe(2);
    expect(rec.taxonomy).not.toBe("infra");
    expect(rec.infra_retries).toBe(1);
    // cleanup ran for BOTH attempts (each got past seed) -- see the cleanup-always-runs suite
    // below for the dedicated assertion on this.
    expect(calls.cleanup).toBe(2);
  });

  test("a QUALITY outcome (opened-but-unresolved) is NOT retried", async () => {
    const { deps, calls } = trackedDeps({ score: async () => SCORE_UNRESOLVED });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(calls.seed).toBe(1);
    expect(calls.run).toBe(1);
    expect(rec.taxonomy).toBe("opened-but-unresolved");
    expect(rec.resolved).toBe(false);
    expect(rec.infra_retries).toBe(0);
  });

  test("infra on every attempt -> capped at maxInfraRetries, final taxonomy stays infra", async () => {
    const { deps, calls } = trackedDeps({ collect: async () => infraStage() });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      maxInfraRetries: 2,
    });

    expect(calls.collect).toBe(3); // 1 initial + 2 retries
    expect(rec.taxonomy).toBe("infra");
    expect(rec.infra_retries).toBe(2);
    // score/review must never run over an infra (no-summary) record
    expect(calls.score).toBe(0);
    expect(calls.blindQuality).toBe(0);
  });

  test("perTaskCostCapUsd stops retrying even before maxInfraRetries is reached", async () => {
    const { deps, calls } = trackedDeps({
      collect: async () => ({ ...infraStage(), record: { taxonomy: "infra", cost_usd: 10 } }),
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg({ perTaskCostCapUsd: 5 }), {
      deps,
      maxInfraRetries: 5,
    });

    // first attempt alone spends 10 + the fixed setup estimate, already >= the 5 cap -> no retry
    expect(calls.collect).toBe(1);
    expect(rec.taxonomy).toBe("infra");
    expect(rec.infra_retries).toBe(0);
  });
});

describe("runInstance: probe short-circuit", () => {
  test("taxonomy:probe -> score/self-test/leak/review NOT called", async () => {
    const { deps, calls } = trackedDeps({ collect: async () => probeStage() });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.taxonomy).toBe("probe");
    expect(calls.score).toBe(0);
    expect(calls.runSelfTest).toBe(0);
    expect(calls.detectLeak).toBe(0);
    expect(calls.blindQuality).toBe(0);
    expect(calls.abReview).toBe(0);
    // probe is not infra -- must NOT be retried
    expect(calls.collect).toBe(1);
  });
});

describe("runInstance: run_self_test transport-error contract", () => {
  test("a run_self_test TRANSPORT ERROR -> self_test_passed:null, never crash, never true", async () => {
    const { deps } = trackedDeps({
      runSelfTest: async () => {
        throw new Error("subprocess exit 1: adapter crashed");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.self_test_passed).toBeNull();
    expect(rec.taxonomy).toBe("resolved"); // the rest of the pipeline still completed normally
  });

  test("no added test paths -> run_self_test never called, self_test_passed falls back to collect's approximation", async () => {
    const { deps, calls } = trackedDeps({
      collect: async () => ({ ...pendingStage(), addedTestPaths: [] }),
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(calls.runSelfTest).toBe(0);
    expect(rec.self_test_passed).toBe(true); // pendingStage()'s record.self_test_passed
  });
});

describe("runInstance: bare-tree-diff propagation", () => {
  test("score/run_self_test/detect_leak/blindQuality/abReview all receive the SAME stage.diff", async () => {
    const seenDiffs: string[] = [];
    const { deps } = trackedDeps({
      score: async (_inst, diff) => {
        seenDiffs.push(diff);
        return SCORE_RESOLVED;
      },
      runSelfTest: async (_inst, diff) => {
        seenDiffs.push(diff);
        return { passed: true };
      },
      detectLeak: async (diff) => {
        seenDiffs.push(diff);
        return LEAK_CLEAN;
      },
      blindQuality: async (_issue, diff) => {
        seenDiffs.push(diff);
        return { verdict: "addresses-issue", notes: "" };
      },
      abReview: async (_issue, diff) => {
        seenDiffs.push(diff);
        return { preference: "A(styre)" as const, notes: "" };
      },
    });
    await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(seenDiffs).toHaveLength(5);
    expect(new Set(seenDiffs).size).toBe(1);
  });

  test("abReview is called with inst.id and cfg.seed (per-instance order), not the run seed alone", async () => {
    let capturedInstanceId: string | undefined;
    let capturedSeed: number | undefined;
    const { deps } = trackedDeps({
      abReview: async (_issue, _diff, _fixPatch, instanceId, seed) => {
        capturedInstanceId = instanceId;
        capturedSeed = seed;
        return { preference: "A(styre)", notes: "" };
      },
    });
    const inst = makeInstance({ id: "some-instance-id" });
    await runInstance(inst, STYRE_BINS, makeCfg({ seed: 99 }), { deps });

    expect(capturedInstanceId).toBe("some-instance-id");
    expect(capturedSeed).toBe(99);
  });
});

describe("runInstance: cleanup always runs per started attempt", () => {
  test("cleanup called even when the run/collect stage throws", async () => {
    const { deps, calls } = trackedDeps({
      run: async () => {
        throw new Error("docker daemon unreachable");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      maxInfraRetries: 0,
    });

    // runInstance must NOT reject -- a crashed stage degrades to a taxonomy:"infra" record.
    expect(rec.taxonomy).toBe("infra");
    expect(calls.cleanup).toBe(1);
    expect(calls.seed).toBe(1);
  });

  test("cleanup NOT called when seed itself throws (nothing was created to tear down)", async () => {
    const { deps, calls } = trackedDeps({
      seed: async () => {
        throw new Error("github API rate-limited");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      maxInfraRetries: 0,
    });

    expect(rec.taxonomy).toBe("infra");
    expect(calls.cleanup).toBe(0);
  });

  test("cleanup called for EVERY started instance in a batch, even when one instance's stage throws", async () => {
    const cleanupCalls: string[] = [];
    const instances = [
      makeInstance({ id: "ok-1" }),
      makeInstance({ id: "throws-1" }),
      makeInstance({ id: "ok-2" }),
    ];

    const runInstanceStub = async (
      inst: Instance,
      _binaries: Record<string, string>,
      cfg: PipelineConfig,
    ) => {
      const { deps: innerDeps } = trackedDeps({
        cleanup: async () => {
          cleanupCalls.push(inst.id);
        },
        run: async () => {
          if (inst.id === "throws-1") throw new Error("boom");
          return RUN_RESULT;
        },
      });
      return runInstance(inst, STYRE_BINS, cfg, { deps: innerDeps, maxInfraRetries: 0 });
    };

    const result = await runPool(instances, STYRE_BINS, makeCfg({ concurrency: 1 }), {
      runInstance: runInstanceStub,
    });

    expect(cleanupCalls.sort()).toEqual(["ok-1", "ok-2", "throws-1"]);
    expect(result.records).toHaveLength(3);
  });
});

describe("runPool: runBudgetUsd kill-switch", () => {
  test("stops scheduling further instances once cumulative cost_usd reaches the budget", async () => {
    const instances = [
      makeInstance({ id: "a" }),
      makeInstance({ id: "b" }),
      makeInstance({ id: "c" }),
      makeInstance({ id: "d" }),
    ];
    const started: string[] = [];
    const runInstanceStub = async (inst: Instance): Promise<TaskRecord> => {
      started.push(inst.id);
      return {
        instance: inst.id,
        language: inst.language,
        difficulty: inst.difficulty,
        styre_commit: "abc",
        cohort: "web-off",
        post_cutoff: false,
        resolved: true,
        pr_opened: true,
        self_authored_test: null,
        self_test_passed: null,
        ticks: 1,
        cycle_count: 0,
        escalation_count: 0,
        escalation_reasons: [],
        outcome: "pr-ready",
        status: "ok",
        exit_code: 0,
        parked: false,
        cost_usd: 6, // 3 instances -> 18, exceeds a budget of 15 after the 3rd
        tokens_in: 0,
        tokens_out: 0,
        blind_quality: null,
        ab_preference: null,
        ab_notes: null,
        suspected_leak: false,
        leak_reasons: [],
        taxonomy: "resolved",
      };
    };

    const result = await runPool(
      instances,
      STYRE_BINS,
      makeCfg({ concurrency: 1, runBudgetUsd: 15 }),
      {
        runInstance: runInstanceStub,
      },
    );

    // Concurrency 1 => strictly sequential: a(6) -> b(12) -> c(18, >=15 stop) -> d never starts.
    expect(started).toEqual(["a", "b", "c"]);
    expect(result.records).toHaveLength(3);
    expect(result.skipped.map((i) => i.id)).toEqual(["d"]);
    expect(result.budgetExceeded).toBe(true);
    expect(result.spentUsd).toBe(18);
  });

  test("under budget -> every instance runs, kill-switch never trips", async () => {
    const instances = [makeInstance({ id: "a" }), makeInstance({ id: "b" })];
    const runInstanceStub = async (inst: Instance): Promise<TaskRecord> => ({
      instance: inst.id,
      language: inst.language,
      difficulty: inst.difficulty,
      styre_commit: "abc",
      cohort: "web-off",
      post_cutoff: false,
      resolved: true,
      pr_opened: true,
      self_authored_test: null,
      self_test_passed: null,
      ticks: 1,
      cycle_count: 0,
      escalation_count: 0,
      escalation_reasons: [],
      outcome: "pr-ready",
      status: "ok",
      exit_code: 0,
      parked: false,
      cost_usd: 1,
      tokens_in: 0,
      tokens_out: 0,
      blind_quality: null,
      ab_preference: null,
      ab_notes: null,
      suspected_leak: false,
      leak_reasons: [],
      taxonomy: "resolved",
    });

    const result = await runPool(
      instances,
      STYRE_BINS,
      makeCfg({ concurrency: 2, runBudgetUsd: 150 }),
      {
        runInstance: runInstanceStub,
      },
    );

    expect(result.records).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.budgetExceeded).toBe(false);
  });
});

describe("runInstance: judgment-stage crash NEVER discards the oracle verdict (Task-11 capstone Fix 1)", () => {
  test("detectLeak throws AFTER score succeeds -> resolved verdict PRESERVED, only suspected_leak/leak_reasons degrade", async () => {
    const { deps, calls } = trackedDeps({
      score: async () => SCORE_RESOLVED,
      detectLeak: async () => {
        throw new Error("leak_detect.py: subprocess exit 1");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.resolved).toBe(true);
    expect(rec.taxonomy).toBe("resolved");
    expect(rec.suspected_leak).toBe(false);
    expect(rec.leak_reasons).toEqual(["transcript-unavailable"]);
    // the OTHER judgment signals still ran and are untouched by detectLeak's crash.
    expect(rec.blind_quality).toBe("addresses-issue");
    expect(rec.ab_preference).toBe("A(styre)");
    expect(calls.blindQuality).toBe(1);
    expect(calls.abReview).toBe(1);
  });

  test("blindQuality throws AFTER score succeeds -> resolved verdict PRESERVED, blind_quality:null only", async () => {
    const { deps } = trackedDeps({
      score: async () => SCORE_RESOLVED,
      blindQuality: async () => {
        throw new Error("blind-quality reviewer: rate limited");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.resolved).toBe(true);
    expect(rec.taxonomy).toBe("resolved");
    expect(rec.blind_quality).toBeNull();
    expect(rec.suspected_leak).toBe(false); // detectLeak still ran normally
    expect(rec.ab_preference).toBe("A(styre)"); // abReview still ran normally
  });

  test("abReview throws AFTER score succeeds -> resolved verdict PRESERVED, ab_preference:null only", async () => {
    const { deps } = trackedDeps({
      score: async () => SCORE_UNRESOLVED,
      abReview: async () => {
        throw new Error("ab-review: malformed judge output");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.resolved).toBe(false);
    expect(rec.taxonomy).toBe("opened-but-unresolved");
    expect(rec.ab_preference).toBeNull();
    expect(rec.ab_notes).toBeNull();
    expect(rec.blind_quality).toBe("addresses-issue"); // blindQuality still ran normally
  });

  test("score() itself throws -> taxonomy:infra (retryable), NOT a discarded verdict", async () => {
    const { deps, calls } = trackedDeps({
      score: async () => {
        throw new Error("scorer/score.py: docker daemon unreachable");
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      maxInfraRetries: 1,
    });

    expect(rec.taxonomy).toBe("infra");
    expect(rec.resolved).toBe(false);
    // score() crashing is retried against the SAME infra-retry budget as seed/run/collect.
    expect(calls.score).toBe(2); // 1 initial + 1 retry
    expect(rec.infra_retries).toBe(1);
    // score having crashed on every attempt means no judgment stage ever ran.
    expect(calls.detectLeak).toBe(0);
    expect(calls.blindQuality).toBe(0);
    expect(calls.abReview).toBe(0);
  });

  test("crux regression: a runInstance that rejects at the pool layer -> pool record is taxonomy:infra && resolved:false", async () => {
    const instances = [makeInstance({ id: "rejects-1" })];
    const runInstanceStub = async (): Promise<TaskRecord> => {
      throw new Error("unhandled: some judgment stage crashed and rejected the whole call");
    };

    const result = await runPool(instances, STYRE_BINS, makeCfg({ concurrency: 1 }), {
      runInstance: runInstanceStub,
    });

    expect(result.records).toHaveLength(1);
    const [record] = result.records;
    expect(record?.taxonomy).toBe("infra");
    expect(record?.resolved).toBe(false);
  });
});

describe("runInstance: cumulative cost_usd across infra retries (Task-11 capstone Fix 2)", () => {
  test("an instance that consumed one infra-retry reports cost = sum of both attempts (+ setup), not just the last", async () => {
    let attempt = 0;
    const { deps } = trackedDeps({
      collect: async () => {
        attempt++;
        return attempt === 1
          ? { ...infraStage(), record: { taxonomy: "infra", cost_usd: 2 } }
          : { ...pendingStage(), record: { ...pendingStage().record, cost_usd: 1.5 } };
      },
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.taxonomy).not.toBe("infra");
    expect(rec.infra_retries).toBe(1);
    // attempt 1: 2 (run cost) + 0.5 (setup estimate) = 2.5
    // attempt 2: 1.5 (run cost) + 0.5 (setup estimate) = 2.0
    // total: 4.5 -- NOT just the last attempt's raw 1.5 cost_usd.
    expect(rec.cost_usd).toBeCloseTo(4.5, 5);
  });

  test("a single-attempt (no retry) instance still adds the fixed setup estimate on top of its own cost_usd", async () => {
    const { deps } = trackedDeps({
      collect: async () => ({
        ...pendingStage(),
        record: { ...pendingStage().record, cost_usd: 3 },
      }),
    });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), { deps });

    expect(rec.cost_usd).toBeCloseTo(3.5, 5);
  });
});

describe("runPilot: threads runPool's skipped count into ReportMeta (Task-11 capstone Fix 4)", () => {
  test("meta.skippedCount === poolResult.skipped.length, passed through to renderReport", async () => {
    const inst = makeInstance({ id: "skipped-inst" });
    let capturedMeta: unknown;

    const deps: Partial<RunPilotDeps> = {
      loadInstances: async () => [inst],
      selectPilot: (pool) => pool,
      buildStyre: async () => ({ binaries: STYRE_BINS, commit: "abc123", webTools: "off" }),
      runPool: async () => ({
        records: [],
        spentUsd: 150,
        budgetExceeded: true,
        skipped: [inst],
      }),
      renderReport: (records, meta) => {
        capturedMeta = meta;
        return { markdown: "", json: records };
      },
      writeReport: async () => {},
    };

    await runPilot(makeCfg(), { deps });

    expect((capturedMeta as { skippedCount?: number }).skippedCount).toBe(1);
  });
});

describe("runPilot: SMOKE mode routes selection through selectSmoke, not selectPilot", () => {
  test("opts.smoke === true uses deps.selectSmoke; false uses deps.selectPilot", async () => {
    const py = makeInstance({ id: "py-1", language: "python" });
    const ts = makeInstance({ id: "ts-1", language: "ts" });
    let smokeCalled = false;
    let pilotCalled = false;
    const baseDeps: Partial<RunPilotDeps> = {
      loadInstances: async (family) => (family === "swe-bench" ? [py] : [ts]),
      selectPilot: (pool) => {
        pilotCalled = true;
        return pool;
      },
      selectSmoke: (pool) => {
        smokeCalled = true;
        return pool;
      },
      buildStyre: async () => ({ binaries: STYRE_BINS, commit: "abc123", webTools: "off" }),
      runPool: async () => ({
        records: [],
        spentUsd: 0,
        budgetExceeded: false,
        skipped: [],
      }),
      renderReport: (records) => ({ markdown: "", json: records }),
      writeReport: async () => {},
    };

    await runPilot(makeCfg(), { deps: baseDeps, smoke: true });
    expect(smokeCalled).toBe(true);
    expect(pilotCalled).toBe(false);

    smokeCalled = false;
    pilotCalled = false;
    await runPilot(makeCfg(), { deps: baseDeps, smoke: false });
    expect(pilotCalled).toBe(true);
    expect(smokeCalled).toBe(false);
  });
});

describe("RUN_LIVE=1-gated: ONE full-pipeline run PER corpus family (placeholder)", () => {
  // Per the Task-11 brief (Step 5) and the plan's Global Constraint ("per-corpus-family live
  // gate"): before ANY Phase-2 number is trusted, one full-pipeline live run must pass per
  // corpus family (>=1 Python/SWE-bench-Verified + >=1 TS/Multi-SWE-bench instance) through
  // controls -> seed -> run -> score -> self-test -> leak-detect -> review -> report, with the
  // oracle controls passing, the behavioral web-off probe passing (Task 4 Step 5), the
  // firewall holding, and a report row rendering. A green *unit* suite (this file, every
  // external stage stubbed) is explicitly NOT this gate -- described here as a placeholder,
  // not run in the default suite. Requires: a built styre binary (RUN_BUILD=1, build-styre.ts),
  // real ANTHROPIC_API_KEY/LINEAR_API_KEY/GITHUB_TOKEN/BENCH_GH_TOKEN creds, a Docker daemon,
  // and pinned dataset fixtures at data/swe-bench.json + data/multi-swe-bench.json (Task 2's
  // loadInstances contract) -- none of which this repo provisions automatically.
  const run = process.env.RUN_LIVE === "1" ? test : test.skip;

  run(
    "python (SWE-bench Verified) instance: full pipeline, oracle controls pass, report row rendered",
    async () => {
      throw new Error(
        "RUN_LIVE gate not wired: run `bun bin/run-pilot.ts` against a real pinned Python " +
          "instance and record { styre_commit, controls, webOffProbe result } manually per the " +
          "Task-11 brief Step 5 -- this test is a documented placeholder, not an automated gate.",
      );
    },
  );

  run(
    "ts (Multi-SWE-bench) instance: full pipeline, oracle controls pass, report row rendered",
    async () => {
      throw new Error(
        "RUN_LIVE gate not wired: run `bun bin/run-pilot.ts` against a real pinned TS instance " +
          "and record { styre_commit, controls, webOffProbe result } manually per the Task-11 " +
          "brief Step 5 -- this test is a documented placeholder, not an automated gate.",
      );
    },
  );
});

describe("runInstance: SMOKE=2 Option-B oracle-bypass (bypassOracle:true)", () => {
  test("skips runControls/score/runSelfTest entirely; still runs seed/run/collect/detectLeak/blindQuality/abReview", async () => {
    const { deps, calls } = trackedDeps();
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      bypassOracle: true,
    });

    expect(calls.runControls).toBe(0);
    expect(calls.score).toBe(0);
    expect(calls.runSelfTest).toBe(0);
    expect(calls.seed).toBe(1);
    expect(calls.run).toBe(1);
    expect(calls.collect).toBe(1);
    expect(calls.detectLeak).toBe(1);
    expect(calls.blindQuality).toBe(1);
    expect(calls.abReview).toBe(1);

    expect(rec.taxonomy).toBe("unscored");
    expect(rec.resolved).toBeNull();

    // the rest of the record still populates normally.
    expect(rec.cost_usd).toBeGreaterThan(0);
    expect(rec.pr_opened).toBe(true);
    expect(rec.blind_quality).toBe("addresses-issue");
    expect(rec.ab_preference).toBe("A(styre)");
  });

  test("a bypass run where collect returns infra still yields infra (bypass doesn't mask a real seed/run/collect failure)", async () => {
    const { deps, calls } = trackedDeps({ collect: async () => infraStage() });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      bypassOracle: true,
      maxInfraRetries: 0,
    });

    expect(rec.taxonomy).toBe("infra");
    expect(calls.score).toBe(0);
    expect(calls.detectLeak).toBe(0);
    expect(calls.blindQuality).toBe(0);
  });

  test("a bypass run where collect returns probe still short-circuits as probe (score/self-test/leak/review not called)", async () => {
    const { deps, calls } = trackedDeps({ collect: async () => probeStage() });
    const rec = await runInstance(makeInstance(), STYRE_BINS, makeCfg(), {
      deps,
      bypassOracle: true,
    });

    expect(rec.taxonomy).toBe("probe");
    expect(calls.detectLeak).toBe(0);
    expect(calls.blindQuality).toBe(0);
    expect(calls.abReview).toBe(0);
  });
});

describe("runPilot: SMOKE=2 threads bypassOracle to the instance path", () => {
  test("{ smoke: true, bypassOracle: true } passes bypassOracle through runPool's runInstanceOpts", async () => {
    const py = makeInstance({ id: "py-1", language: "python" });
    const ts = makeInstance({ id: "ts-1", language: "ts" });
    let capturedOpts: RunPoolOpts | undefined;
    const deps: Partial<RunPilotDeps> = {
      loadInstances: async (family) => (family === "swe-bench" ? [py] : [ts]),
      selectSmoke: (pool) => pool,
      buildStyre: async () => ({ binaries: STYRE_BINS, commit: "abc123", webTools: "off" }),
      runPool: async (_instances, _binaryPath, _cfg, opts) => {
        capturedOpts = opts;
        return { records: [], spentUsd: 0, budgetExceeded: false, skipped: [] };
      },
      renderReport: (records) => ({ markdown: "", json: records }),
      writeReport: async () => {},
    };

    await runPilot(makeCfg(), { deps, smoke: true, bypassOracle: true });

    expect(capturedOpts?.runInstanceOpts?.bypassOracle).toBe(true);
  });
});

describe("resolvePythonBin: scorer uses the .venv interpreter, not bare python3", () => {
  test("BENCH_PYTHON override wins", () => {
    expect(
      resolvePythonBin({ BENCH_PYTHON: "/custom/python" }, "/repo/.venv/bin/python", () => true),
    ).toBe("/custom/python");
  });
  test("prefers the repo .venv when it exists (bare python3 lacks swebench)", () => {
    expect(resolvePythonBin({}, "/repo/.venv/bin/python", () => true)).toBe(
      "/repo/.venv/bin/python",
    );
  });
  test("falls back to python3 only when no venv is present", () => {
    expect(resolvePythonBin({}, "/repo/.venv/bin/python", () => false)).toBe("python3");
  });
});
