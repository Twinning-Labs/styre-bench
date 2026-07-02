import { describe, expect, test } from "bun:test";
import {
  addedPaths,
  assertNoHeldOut,
  assertNoHeldOutPaths,
  stripClaudeDir,
  touchedPaths,
} from "../orchestrator/firewall";
import { seedGithub } from "../orchestrator/seed-github";
import { buildIssueBody, seedLinear } from "../orchestrator/seed-linear";
import type { Instance } from "../orchestrator/types";

const SENTINEL_FIX_LINE =
  "+    return _really_specific_accepted_fix_implementation(value, extra_arg=True)";
const SENTINEL_TEST_LINE =
  "+    assert compute_regression_result(edge_case_input) == EXPECTED_REGRESSION_VALUE";

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "org__repo-123",
    language: "python",
    difficulty: "medium",
    repo: "acme/widget",
    base_commit: "deadbeefcafe",
    problem_statement:
      "Calling widget.compute() with a negative offset raises an unhandled KeyError.",
    hints: "The bug is likely in widget/core.py around the offset-normalization branch.",
    image: "sweb.eval.x86_64.org__repo-123",
    fail_to_pass: ["tests/test_widget.py::test_negative_offset"],
    pass_to_pass: ["tests/test_widget.py::test_basic"],
    fix_patch: [
      "diff --git a/widget/core.py b/widget/core.py",
      "--- a/widget/core.py",
      "+++ b/widget/core.py",
      "@@ -10,3 +10,3 @@",
      SENTINEL_FIX_LINE,
      "-    return _old_broken_implementation(value)",
    ].join("\n"),
    test_patch: [
      "diff --git a/tests/x_regression.py b/tests/x_regression.py",
      "--- /dev/null",
      "+++ b/tests/x_regression.py",
      "@@ -0,0 +1,3 @@",
      SENTINEL_TEST_LINE,
    ].join("\n"),
    ...overrides,
  };
}

describe("touchedPaths (pure)", () => {
  test("extracts both a/ and b/ paths from a diff --git header", () => {
    const patch = "diff --git a/foo/bar.py b/foo/bar.py\n--- a/foo/bar.py\n+++ b/foo/bar.py\n";
    expect(touchedPaths(patch)).toContain("foo/bar.py");
  });

  test("extracts the b/ path for a newly-added file (/dev/null source)", () => {
    const patch =
      "diff --git a/tests/x_regression.py b/tests/x_regression.py\n--- /dev/null\n+++ b/tests/x_regression.py\n";
    expect(touchedPaths(patch)).toContain("tests/x_regression.py");
  });

  test("does not add /dev/null as a path", () => {
    const patch =
      "diff --git a/tests/x_regression.py b/tests/x_regression.py\n--- /dev/null\n+++ b/tests/x_regression.py\n";
    expect(touchedPaths(patch)).not.toContain("/dev/null");
  });
});

describe("addedPaths (pure)", () => {
  test("does not include a path the patch only MODIFIES (pre-image is a real file, not /dev/null)", () => {
    const patch =
      "diff --git a/foo/bar.py b/foo/bar.py\n--- a/foo/bar.py\n+++ b/foo/bar.py\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    expect(addedPaths(patch)).not.toContain("foo/bar.py");
    expect(addedPaths(patch)).toEqual([]);
  });

  test("includes a path created via a `--- /dev/null` pre-image (SWE-bench-style patch, no `diff --git` header)", () => {
    const patch = "--- /dev/null\n+++ b/tests/x_regression.py\n@@ -0,0 +1,1 @@\n+assert True\n";
    expect(addedPaths(patch)).toContain("tests/x_regression.py");
  });

  test("includes a path created via the git-generated `new file mode` form", () => {
    const patch =
      "diff --git a/tests/x_new.py b/tests/x_new.py\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/tests/x_new.py\n@@ -0,0 +1,1 @@\n+assert True\n";
    expect(addedPaths(patch)).toContain("tests/x_new.py");
  });
});

describe("assertNoHeldOutPaths (pure, path-level firewall)", () => {
  test("throws when a held-out test_patch-ADDED path is present in the candidate path set", () => {
    const inst = makeInstance();
    expect(() => assertNoHeldOutPaths(["tests/x_regression.py", "widget/core.py"], inst)).toThrow(
      /FIREWALL VIOLATION/,
    );
  });

  test("does NOT throw when the snapshot contains a path fix_patch only MODIFIES (legitimately pre-exists in base_commit as the buggy code to fix)", () => {
    const inst = makeInstance(); // default fix_patch modifies widget/core.py, does not create it
    expect(() => assertNoHeldOutPaths(["widget/core.py"], inst)).not.toThrow();
  });

  test("throws when a held-out fix_patch-ADDED path is present (fix_patch creates a new file)", () => {
    const inst = makeInstance({
      fix_patch: [
        "diff --git a/widget/new_helper.py b/widget/new_helper.py",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/widget/new_helper.py",
        "@@ -0,0 +1,1 @@",
        SENTINEL_FIX_LINE,
      ].join("\n"),
    });
    expect(() => assertNoHeldOutPaths(["widget/new_helper.py"], inst)).toThrow(
      /FIREWALL VIOLATION/,
    );
  });

  test("passes cleanly when no held-out path is present", () => {
    const inst = makeInstance();
    expect(() => assertNoHeldOutPaths(["widget/other.py", "README.md"], inst)).not.toThrow();
  });
});

describe("assertNoHeldOutPaths / assertNoHeldOut: fail CLOSED on an unparseable patch", () => {
  test("assertNoHeldOutPaths throws when test_patch is non-empty but has no recognizable diff headers", () => {
    const inst = makeInstance({ test_patch: "this is not a valid unified diff at all" });
    expect(() => assertNoHeldOutPaths(["widget/core.py"], inst)).toThrow(/unparseable patch/);
  });

  test("assertNoHeldOutPaths throws when fix_patch is non-empty but has no recognizable diff headers", () => {
    const inst = makeInstance({ fix_patch: "garbage, not a diff" });
    expect(() => assertNoHeldOutPaths(["widget/core.py"], inst)).toThrow(/unparseable patch/);
  });

  test("assertNoHeldOut throws when fix_patch is non-empty but has no recognizable diff headers", () => {
    const inst = makeInstance({ fix_patch: "garbage, not a diff" });
    expect(() => assertNoHeldOut("some issue text", inst)).toThrow(/unparseable patch/);
  });

  test("assertNoHeldOut throws when test_patch is non-empty but has no recognizable diff headers", () => {
    const inst = makeInstance({ test_patch: "garbage, not a diff" });
    expect(() => assertNoHeldOut("some issue text", inst)).toThrow(/unparseable patch/);
  });
});

describe("assertNoHeldOut (pure, content-level firewall)", () => {
  test("throws when text contains a real non-trivial line from fix_patch", () => {
    const inst = makeInstance();
    const text = `Some issue body that happens to quote: ${SENTINEL_FIX_LINE.slice(1)}`;
    expect(() => assertNoHeldOut(text, inst)).toThrow(/FIREWALL VIOLATION/);
  });

  test("throws when text contains a real non-trivial line from test_patch", () => {
    const inst = makeInstance();
    const text = `leaked: ${SENTINEL_TEST_LINE.slice(1)}`;
    expect(() => assertNoHeldOut(text, inst)).toThrow(/FIREWALL VIOLATION/);
  });

  test("passes on clean issue text unrelated to either patch", () => {
    const inst = makeInstance();
    const text = "Calling widget.compute() with a negative offset raises an unhandled KeyError.";
    expect(() => assertNoHeldOut(text, inst)).not.toThrow();
  });

  test("does not trip on short/trivial diff lines (avoids false positives)", () => {
    const inst = makeInstance({
      fix_patch: "diff --git a/x.py b/x.py\n+pass\n+}\n",
      test_patch: "diff --git a/y.py b/y.py\n+ok\n",
    });
    expect(() => assertNoHeldOut("pass, ok, }", inst)).not.toThrow();
  });

  test("does NOT throw when text quotes a REMOVED (-) line from fix_patch — old buggy code already visible in base_commit, not secret", () => {
    const inst = makeInstance();
    const removedLineBody = "return _old_broken_implementation(value)"; // the '-' line, sans leading '-'
    const text = `Stack trace shows: ${removedLineBody}`;
    expect(() => assertNoHeldOut(text, inst)).not.toThrow();
  });

  test("throws when text contains an ADDED (+) line from fix_patch even though a '-' line is also present in the patch", () => {
    const inst = makeInstance();
    const text = `leaked: ${SENTINEL_FIX_LINE.slice(1)}`;
    expect(() => assertNoHeldOut(text, inst)).toThrow(/FIREWALL VIOLATION/);
  });
});

describe("stripClaudeDir (pure)", () => {
  test("removes a top-level .claude/settings.json entry", () => {
    const files = [{ path: ".claude/settings.json" }, { path: "src/index.ts" }];
    const result = stripClaudeDir(files);
    expect(result.map((f) => f.path)).toEqual(["src/index.ts"]);
  });

  test("removes nested .claude/ paths at any depth", () => {
    const files = [{ path: "a/b/.claude/hooks/pre.sh" }, { path: "a/b/keep.ts" }];
    expect(stripClaudeDir(files).map((f) => f.path)).toEqual(["a/b/keep.ts"]);
  });

  test("leaves files with .claude only as a substring of a name untouched", () => {
    const files = [{ path: "src/claude-helper.ts" }, { path: ".claude-ignore" }];
    expect(stripClaudeDir(files).map((f) => f.path)).toEqual([
      "src/claude-helper.ts",
      ".claude-ignore",
    ]);
  });
});

describe("seedGithub (mocked deps — no network)", () => {
  test("FIREWALL: rejects and never pushes when a held-out test_patch path is present in the fetched snapshot", async () => {
    const inst = makeInstance();
    let pushCalled = false;
    await expect(
      seedGithub(
        inst,
        { benchGithubOrg: "styre-bench-scratch" },
        {
          deps: {
            fetchSnapshot: async () => [
              { path: "widget/core.py", content: "def compute(): ..." },
              { path: "tests/x_regression.py", content: "def test_x(): ..." },
            ],
            createRepo: async () => ({
              repoUrl: "https://example.invalid/styre-bench-scratch/bench-org__repo-123.git",
              defaultBranch: "main",
            }),
            pushSnapshot: async () => {
              pushCalled = true;
            },
          },
        },
      ),
    ).rejects.toThrow(/FIREWALL VIOLATION/);
    expect(pushCalled).toBe(false);
  });

  test("strips .claude/settings.json from the snapshot before pushing", async () => {
    const inst = makeInstance();
    let pushedFiles: { path: string; content: string }[] = [];
    await seedGithub(
      inst,
      { benchGithubOrg: "styre-bench-scratch" },
      {
        deps: {
          fetchSnapshot: async () => [
            { path: "widget/other.py", content: "def helper(): ..." },
            { path: ".claude/settings.json", content: '{"tools":["WebFetch"]}' },
            { path: "README.md", content: "# widget" },
          ],
          createRepo: async () => ({
            repoUrl: "https://example.invalid/styre-bench-scratch/bench-org__repo-123.git",
            defaultBranch: "main",
          }),
          pushSnapshot: async (files) => {
            pushedFiles = files;
          },
        },
      },
    );
    const paths = pushedFiles.map((f) => f.path);
    expect(paths).not.toContain(".claude/settings.json");
    expect(paths).toContain("widget/other.py");
    expect(paths).toContain("README.md");
  });

  test("creates the repo under cfg.benchGithubOrg", async () => {
    const inst = makeInstance();
    let orgSeen = "";
    const result = await seedGithub(
      inst,
      { benchGithubOrg: "styre-bench-scratch" },
      {
        deps: {
          fetchSnapshot: async () => [{ path: "README.md", content: "# widget" }],
          createRepo: async (org) => {
            orgSeen = org;
            return {
              repoUrl: "https://example.invalid/styre-bench-scratch/bench-org__repo-123.git",
              defaultBranch: "main",
            };
          },
          pushSnapshot: async () => {},
        },
      },
    );
    expect(orgSeen).toBe("styre-bench-scratch");
    expect(result.repoUrl).toContain("styre-bench-scratch");
    expect(result.defaultBranch).toBe("main");
  });
});

describe("seedGithub / seedLinear: fail CLOSED on an unparseable patch (integration)", () => {
  test("seedGithub throws and never pushes when test_patch is unparseable", async () => {
    const inst = makeInstance({ test_patch: "not a diff, no headers at all" });
    let pushCalled = false;
    await expect(
      seedGithub(
        inst,
        { benchGithubOrg: "styre-bench-scratch" },
        {
          deps: {
            fetchSnapshot: async () => [{ path: "widget/core.py", content: "def compute(): ..." }],
            createRepo: async () => ({
              repoUrl: "https://example.invalid/styre-bench-scratch/bench-org__repo-123.git",
              defaultBranch: "main",
            }),
            pushSnapshot: async () => {
              pushCalled = true;
            },
          },
        },
      ),
    ).rejects.toThrow(/unparseable patch/);
    expect(pushCalled).toBe(false);
  });

  test("seedLinear throws and never creates the issue when fix_patch is unparseable", async () => {
    const inst = makeInstance({ fix_patch: "not a diff, no headers at all" });
    let called = false;
    await expect(
      seedLinear(
        inst,
        { linearProjectId: "proj-123" },
        {
          deps: {
            createIssue: async () => {
              called = true;
              return { ident: "BENCH-X" };
            },
          },
        },
      ),
    ).rejects.toThrow(/unparseable patch/);
    expect(called).toBe(false);
  });
});

describe("buildIssueBody (pure)", () => {
  test("includes the problem_statement and hints, never fix_patch/test_patch content", () => {
    const inst = makeInstance();
    const body = buildIssueBody(inst);
    expect(body).toContain(inst.problem_statement);
    expect(body).toContain(inst.hints ?? "");
    expect(body).not.toContain(SENTINEL_FIX_LINE.slice(1));
    expect(body).not.toContain(SENTINEL_TEST_LINE.slice(1));
  });

  test("has What/Why/Scope/Acceptance criteria/Refs sections", () => {
    const inst = makeInstance();
    const body = buildIssueBody(inst);
    expect(body).toContain("## What");
    expect(body).toContain("## Why");
    expect(body).toContain("## Scope");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("## Refs");
  });
});

describe("seedLinear (mocked deps — no network)", () => {
  test("FIREWALL: the created issue description never contains a sentinel line planted in fix_patch/test_patch", async () => {
    const inst = makeInstance();
    let descriptionSeen = "";
    await seedLinear(
      inst,
      { linearProjectId: "proj-123" },
      {
        deps: {
          createIssue: async (input) => {
            descriptionSeen = input.description;
            return { ident: "BENCH-1" };
          },
        },
      },
    );
    expect(descriptionSeen).not.toContain(SENTINEL_FIX_LINE.slice(1));
    expect(descriptionSeen).not.toContain(SENTINEL_TEST_LINE.slice(1));
  });

  test("creates the issue in cfg.linearProjectId with label Bug", async () => {
    const inst = makeInstance();
    let projectSeen = "";
    let labelsSeen: string[] = [];
    const result = await seedLinear(
      inst,
      { linearProjectId: "proj-123" },
      {
        deps: {
          createIssue: async (input) => {
            projectSeen = input.projectId;
            labelsSeen = input.labelNames;
            return { ident: "BENCH-2" };
          },
        },
      },
    );
    expect(projectSeen).toBe("proj-123");
    expect(labelsSeen).toContain("Bug");
    expect(result.ident).toBe("BENCH-2");
  });

  test("rejects before calling createIssue if the description somehow carried held-out content (defense-in-depth on a corrupted body builder)", async () => {
    // Simulates a future regression in buildIssueBody by injecting a deps.createIssue that
    // would only be reached AFTER the firewall check — asserts the firewall runs first by
    // making createIssue itself detect it was never called with tainted content.
    const inst = makeInstance({ problem_statement: SENTINEL_FIX_LINE.slice(1) });
    let called = false;
    await expect(
      seedLinear(
        inst,
        { linearProjectId: "proj-123" },
        {
          deps: {
            createIssue: async (input) => {
              called = true;
              return { ident: "BENCH-3", description: input.description } as { ident: string };
            },
          },
        },
      ),
    ).rejects.toThrow(/FIREWALL VIOLATION/);
    expect(called).toBe(false);
  });
});

describe("seedGithub / seedLinear: live (real GitHub repo + Linear issue) — RUN_LIVE=1 only", () => {
  const run = process.env.RUN_LIVE === "1" ? test : test.skip;

  run(
    "seedGithub creates a real throwaway repo under benchGithubOrg and pushes a real snapshot",
    async () => {
      const inst = makeInstance({
        repo: "octocat/Hello-World",
        base_commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11",
      });
      const result = await seedGithub(inst, { benchGithubOrg: "styre-bench-scratch" });
      expect(result.repoUrl).toContain("styre-bench-scratch");
      expect(result.defaultBranch).toBeTruthy();
    },
    120_000,
  );

  run(
    "seedLinear creates a real issue in linearProjectId with label Bug",
    async () => {
      const inst = makeInstance();
      const projectId = process.env.STYRE_BENCH_LINEAR_PROJECT_ID ?? "";
      const result = await seedLinear(inst, { linearProjectId: projectId });
      expect(result.ident).toBeTruthy();
    },
    60_000,
  );
});
