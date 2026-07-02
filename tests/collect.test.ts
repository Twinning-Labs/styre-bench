import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collect, extractStrippedDiff, isTestPath } from "../orchestrator/collect";
import type { ProbeProfile } from "../orchestrator/collect";

const FIXTURES = join(import.meta.dir, "fixtures");
const SUMMARY_NDJSON = readFileSync(join(FIXTURES, "summary.ndjson"), "utf8");
const PR_DIFF = readFileSync(join(FIXTURES, "pr.diff"), "utf8");

const RUNNABLE_PROFILE: ProbeProfile = {
  components: [{ commands: { test: "npm test" } }],
};

const UNAVAILABLE_PROFILE: ProbeProfile = {
  components: [{ commands: { test: { unavailable: true } } }],
};

const ABSENT_TEST_CMD_PROFILE: ProbeProfile = {
  components: [{ commands: { build: "npm run build" } }],
};

function summaryLine(overrides: Record<string, unknown>): string {
  const base = {
    schema_version: 1,
    type: "summary",
    ticket_id: 1,
    ident: "ENG-1",
    outcome: "pr-ready",
    stage: "merge",
    status: "ok",
    ticks: 5,
    cost_usd: 1.23,
    tokens_in: 1000,
    tokens_out: 200,
    cache_read: 0,
    cache_create: 0,
    dispatch_count: 1,
    dispatch_outcomes: { ok: 1 },
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
  };
  return JSON.stringify({ ...base, ...overrides });
}

describe("collect: summary parsing", () => {
  test("outcome:pr-ready -> fields populated, taxonomy pending (undefined)", () => {
    const rec = collect(SUMMARY_NDJSON, PR_DIFF, RUNNABLE_PROFILE, {
      language: "ts",
      pr_opened: true,
    });
    expect(rec.ticks).toBe(13);
    expect(rec.cycle_count).toBe(4);
    expect(rec.escalation_count).toBe(1);
    expect(rec.escalation_reasons).toEqual(["verify-red-exhausted"]);
    expect(rec.outcome).toBe("pr-ready");
    expect(rec.status).toBe("ok");
    expect(rec.cost_usd).toBe(5.8);
    expect(rec.tokens_in).toBe(210400);
    expect(rec.tokens_out).toBe(38200);
    expect(rec.parked).toBe(false);
    expect(rec.taxonomy).toBeUndefined();
  });

  test("parses the LAST summary event, not an earlier one", () => {
    const ndjson = [
      summaryLine({ outcome: "blocked", ticks: 1 }),
      summaryLine({ outcome: "pr-ready", ticks: 99 }),
    ].join("\n");
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: true });
    expect(rec.outcome).toBe("pr-ready");
    expect(rec.ticks).toBe(99);
  });

  test("outcome:no-progress (even with exit 1) -> taxonomy loop-exhausted", () => {
    const ndjson = summaryLine({ outcome: "no-progress" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: false });
    expect(rec.taxonomy).toBe("loop-exhausted");
  });

  test("outcome:blocked -> taxonomy loop-exhausted", () => {
    const ndjson = summaryLine({ outcome: "blocked" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: false });
    expect(rec.taxonomy).toBe("loop-exhausted");
  });

  test("outcome:parked -> taxonomy parked, parked===true", () => {
    const ndjson = summaryLine({ outcome: "parked" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: false });
    expect(rec.taxonomy).toBe("parked");
    expect(rec.parked).toBe(true);
  });

  test("profile whose only component's commands.test is {unavailable} -> taxonomy probe", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, UNAVAILABLE_PROFILE, { language: "ts", pr_opened: true });
    expect(rec.taxonomy).toBe("probe");
  });

  test("profile whose only component has no commands.test key at all -> taxonomy probe", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, ABSENT_TEST_CMD_PROFILE, {
      language: "ts",
      pr_opened: true,
    });
    expect(rec.taxonomy).toBe("probe");
  });

  test("profile with no components at all -> taxonomy probe", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, { components: [] }, { language: "ts", pr_opened: true });
    expect(rec.taxonomy).toBe("probe");
  });
});

describe("collect: docs/plans/ stripping + per-language self_authored_test", () => {
  test("extractStrippedDiff removes the docs/plans/ hunk, keeps src + test hunks", () => {
    const stripped = extractStrippedDiff(PR_DIFF);
    expect(stripped).not.toContain("docs/plans/1.md");
    expect(stripped).toContain("src/x.ts");
    expect(stripped).toContain("tests/x.test.ts");
  });

  test("lang ts: docs/plans/ stripped, self_authored_test true", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: true });
    expect(rec.self_authored_test).toBe(true);
  });

  test("SAME diff, lang python -> self_authored_test false (x.test.ts is not a python test path)", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, {
      language: "python",
      pr_opened: true,
    });
    expect(rec.self_authored_test).toBe(false);
  });

  test("go diff with foo_test.go -> self_authored_test true", () => {
    const goDiff = [
      "diff --git a/docs/plans/1.md b/docs/plans/1.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/plans/1.md",
      "@@ -0,0 +1,1 @@",
      "+plan",
      "diff --git a/pkg/foo.go b/pkg/foo.go",
      "index abc..def 100644",
      "--- a/pkg/foo.go",
      "+++ b/pkg/foo.go",
      "@@ -1,1 +1,1 @@",
      "-func Foo() int { return 1 }",
      "+func Foo() int { return 2 }",
      "diff --git a/pkg/foo_test.go b/pkg/foo_test.go",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/foo_test.go",
      "@@ -0,0 +1,3 @@",
      "+package pkg",
      "+",
      "+func TestFoo(t *testing.T) {}",
      "",
    ].join("\n");
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, goDiff, RUNNABLE_PROFILE, { language: "go", pr_opened: true });
    expect(rec.self_authored_test).toBe(true);
  });

  test("no test-file hunk -> self_authored_test false", () => {
    const srcOnlyDiff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index abc..def 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,1 +1,1 @@",
      "-return 1;",
      "+return 2;",
      "",
    ].join("\n");
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, srcOnlyDiff, RUNNABLE_PROFILE, {
      language: "ts",
      pr_opened: true,
    });
    expect(rec.self_authored_test).toBe(false);
  });
});

describe("collect: self_test_passed derivation", () => {
  test("self_authored_test && pr_opened -> self_test_passed true", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: true });
    expect(rec.self_authored_test).toBe(true);
    expect(rec.self_test_passed).toBe(true);
  });

  test("self_authored_test but NOT pr_opened -> self_test_passed false", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: false });
    expect(rec.self_authored_test).toBe(true);
    expect(rec.self_test_passed).toBe(false);
  });

  test("not applicable (no self-authored test) -> self_test_passed null", () => {
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, {
      language: "python",
      pr_opened: true,
    });
    expect(rec.self_authored_test).toBe(false);
    expect(rec.self_test_passed).toBeNull();
  });
});

describe("isTestPath: per-language matcher", () => {
  test("python: test_*.py and **/tests/**/*.py match; a .ts file under tests/ does not", () => {
    expect(isTestPath("tests/test_foo.py", "python")).toBe(true);
    expect(isTestPath("pkg/test_bar.py", "python")).toBe(true);
    expect(isTestPath("tests/x.test.ts", "python")).toBe(false);
  });

  test("python: *_test.py (pytest's other default discovery pattern) matches", () => {
    expect(isTestPath("pkg/foo_test.py", "python")).toBe(true);
  });

  test("python: tests/conftest.py and tests/__init__.py are NOT self-authored tests", () => {
    expect(isTestPath("tests/conftest.py", "python")).toBe(false);
    expect(isTestPath("tests/__init__.py", "python")).toBe(false);
  });

  test("ts/js: *.test.ts, *.spec.ts, __tests__/*.ts match", () => {
    expect(isTestPath("src/x.test.ts", "ts")).toBe(true);
    expect(isTestPath("src/x.spec.ts", "ts")).toBe(true);
    expect(isTestPath("src/__tests__/x.ts", "ts")).toBe(true);
    expect(isTestPath("src/x.ts", "ts")).toBe(false);
  });

  test("js: mocha test/ directory convention matches", () => {
    expect(isTestPath("test/foo.js", "js")).toBe(true);
    expect(isTestPath("test/nested/foo.js", "js")).toBe(true);
  });

  test("go: *_test.go matches", () => {
    expect(isTestPath("pkg/foo_test.go", "go")).toBe(true);
    expect(isTestPath("pkg/foo.go", "go")).toBe(false);
  });

  test("java: src/test/java/** matches", () => {
    expect(isTestPath("module/src/test/java/com/foo/BarTest.java", "java")).toBe(true);
    expect(isTestPath("module/src/main/java/com/foo/Bar.java", "java")).toBe(false);
  });

  test("rust: tests/** matches", () => {
    expect(isTestPath("tests/foo.rs", "rust")).toBe(true);
    expect(isTestPath("src/foo.rs", "rust")).toBe(false);
  });
});

describe("collect: self_authored_test uses ADDED test paths, not touched", () => {
  test("diff that only MODIFIES an existing test file (no new file) -> self_authored_test false", () => {
    const modifyOnlyTestDiff = [
      "diff --git a/tests/x.test.ts b/tests/x.test.ts",
      "index abc..def 100644",
      "--- a/tests/x.test.ts",
      "+++ b/tests/x.test.ts",
      "@@ -1,3 +1,3 @@",
      ' test("x returns 2", () => {',
      "-  expect(x()).toBe(1);",
      "+  expect(x()).toBe(2);",
      " });",
      "",
    ].join("\n");
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, modifyOnlyTestDiff, RUNNABLE_PROFILE, {
      language: "ts",
      pr_opened: true,
    });
    expect(rec.self_authored_test).toBe(false);
  });

  test("diff that ADDS a new test file -> self_authored_test true", () => {
    const addedTestDiff = [
      "diff --git a/tests/y.test.ts b/tests/y.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/tests/y.test.ts",
      "@@ -0,0 +1,3 @@",
      '+test("y", () => {});',
      "",
    ].join("\n");
    const ndjson = summaryLine({ outcome: "pr-ready" });
    const rec = collect(ndjson, addedTestDiff, RUNNABLE_PROFILE, {
      language: "ts",
      pr_opened: true,
    });
    expect(rec.self_authored_test).toBe(true);
  });
});

describe("collect: no-summary / malformed-summary -> taxonomy infra", () => {
  test("ndjson with NO summary event at all -> taxonomy infra", () => {
    const ndjson = [
      JSON.stringify({ type: "event", kind: "transition" }),
      JSON.stringify({ type: "dispatch", outcome: "ok" }),
    ].join("\n");
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: false });
    expect(rec.taxonomy).toBe("infra");
    expect(rec.outcome).toBeUndefined();
  });

  test("ndjson whose only summary line lacks `outcome` -> taxonomy infra, not a bogus record", () => {
    const malformedSummary = JSON.stringify({ type: "summary", ticks: 5, status: "ok" });
    const rec = collect(malformedSummary, PR_DIFF, RUNNABLE_PROFILE, {
      language: "ts",
      pr_opened: false,
    });
    expect(rec.taxonomy).toBe("infra");
    expect(rec.outcome).toBeUndefined();
    expect(rec.ticks).toBeUndefined();
  });

  test("a corrupt (non-JSON) line among otherwise-valid lines is skipped, collection still succeeds", () => {
    const ndjson = ["not json at all {{{", summaryLine({ outcome: "pr-ready", ticks: 7 })].join(
      "\n",
    );
    const rec = collect(ndjson, PR_DIFF, RUNNABLE_PROFILE, { language: "ts", pr_opened: true });
    expect(rec.taxonomy).toBeUndefined();
    expect(rec.ticks).toBe(7);
    expect(rec.outcome).toBe("pr-ready");
  });
});

describe("collect: taxonomy ordering — probe before loop-exhausted", () => {
  test("unrunnable profile + outcome blocked -> taxonomy probe, not loop-exhausted", () => {
    const ndjson = summaryLine({ outcome: "blocked" });
    const rec = collect(ndjson, PR_DIFF, UNAVAILABLE_PROFILE, {
      language: "ts",
      pr_opened: false,
    });
    expect(rec.taxonomy).toBe("probe");
  });

  test("unrunnable profile + outcome no-progress -> taxonomy probe, not loop-exhausted", () => {
    const ndjson = summaryLine({ outcome: "no-progress" });
    const rec = collect(ndjson, PR_DIFF, UNAVAILABLE_PROFILE, {
      language: "ts",
      pr_opened: false,
    });
    expect(rec.taxonomy).toBe("probe");
  });
});
