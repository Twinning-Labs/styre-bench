import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { $ } from "bun";
import { applyWebOffPatch, buildStyre } from "../orchestrator/build-styre";

const ALLOWLIST_FILE_REL = "src/dispatch/tool-allowlists.ts";

// Single-target fixture (one distinct container platform) for the stubbed cohort-branching
// and cache-reuse tests — the arch-selection itself lives in runPilot/platform.ts, not here.
const TARGETS = [{ platform: "linux/amd64", bunTarget: "bun-linux-x64" }];

// Representative fixture mirroring the REAL shape of styre's
// src/dispatch/tool-allowlists.ts (confirmed against the styre repo, ~line 10): a
// `design:dispatch` allowlist array containing "WebSearch" and "WebFetch" literals
// alongside other tool names, embedded in a Record<string, string[]> object literal.
const FIXTURE_WITH_WEB_TOOLS = `/** Per-step tool allowlists (capability isolation, move 4 / control-loop §4). */
const READ_ONLY = ["Read", "Grep", "Glob"];

const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": [...READ_ONLY, "Write", "Edit", "WebSearch", "WebFetch"],
  "implement:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
  "docs:revise": [...READ_ONLY, "Write", "Edit"],
  "design:extract": [...READ_ONLY],
  "design:size": [...READ_ONLY],
  "design:review": [...READ_ONLY],
  review: [...READ_ONLY],
  "merge:pr-ensure": [...READ_ONLY],
  "setup:enrich": [...READ_ONLY],
  "setup:discover": [...READ_ONLY],
};

export function allowlistFor(handlerKey: string): string[] {
  const tools = ALLOWLISTS[handlerKey];
  if (tools === undefined) {
    throw new Error(\`allowlistFor: no tool allowlist for handlerKey '\${handlerKey}'\`);
  }
  return [...tools];
}
`;

const FIXTURE_WITHOUT_WEB_TOOLS = `const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": ["Read", "Grep", "Glob", "Write", "Edit"],
  "implement:dispatch": ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
};
`;

// Simulates a PARTIAL styre refactor: "WebFetch" survives untouched but "WebSearch" was
// renamed/removed from the allowlist shape. This is the exact contamination scenario the
// fail-closed `||` guard exists to catch — the old `&&` guard would happily patch out
// "WebFetch" here and report a clean web-off build while "WebSearch" (renamed away, so not
// even present to strip) is moot, but a REAL renamed-in-place tool would survive silently.
const FIXTURE_WITH_ONLY_WEBFETCH = `const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": ["Read", "Grep", "Glob", "Write", "Edit", "WebFetch"],
  "implement:dispatch": ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
};
`;

describe("applyWebOffPatch (pure, no clone/build needed)", () => {
  test("removes both WebSearch and WebFetch literals", () => {
    const patched = applyWebOffPatch(FIXTURE_WITH_WEB_TOOLS);
    expect(patched).not.toContain('"WebSearch"');
    expect(patched).not.toContain('"WebFetch"');
  });

  test("leaves the OTHER tools in the same array untouched", () => {
    const patched = applyWebOffPatch(FIXTURE_WITH_WEB_TOOLS);
    expect(patched).toContain('[...READ_ONLY, "Write", "Edit"]');
  });

  test("leaves every other allowlist entry byte-for-byte unchanged", () => {
    const patched = applyWebOffPatch(FIXTURE_WITH_WEB_TOOLS);
    expect(patched).toContain('"implement:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"]');
    expect(patched).toContain('"docs:revise": [...READ_ONLY, "Write", "Edit"]');
  });

  test("produces syntactically valid TS: real-parses via Bun.Transpiler (not just a comma-regex heuristic)", () => {
    const patched = applyWebOffPatch(FIXTURE_WITH_WEB_TOOLS);
    // A dangling/double comma or empty array slot would fail to transpile — this is a real
    // parse, so it catches actual syntax breakage, not just the specific comma shapes a
    // regex heuristic happens to check for.
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(patched)).not.toThrow();
    expect(patched).not.toContain('"WebSearch"');
    expect(patched).not.toContain('"WebFetch"');
  });

  test("is pure: does not mutate its input string (strings are immutable, but assert no aliasing surprises)", () => {
    const before = FIXTURE_WITH_WEB_TOOLS;
    applyWebOffPatch(FIXTURE_WITH_WEB_TOOLS);
    expect(FIXTURE_WITH_WEB_TOOLS).toBe(before);
  });

  test("anchor-missing guard: throws a clear error when neither literal is present", () => {
    expect(() => applyWebOffPatch(FIXTURE_WITHOUT_WEB_TOOLS)).toThrow(/WebSearch|WebFetch/);
  });

  test("anchor-missing guard: error message names what a styre refactor moved (actionable, not generic)", () => {
    expect(() => applyWebOffPatch(FIXTURE_WITHOUT_WEB_TOOLS)).toThrow(/applyWebOffPatch/);
  });

  test("fail-closed guard: throws when exactly ONE anchor is missing (partial refactor, not just both gone)", () => {
    // Before the fix this was an `&&` guard, so a fixture with only one literal present
    // would NOT throw — the patch would strip that one literal, report webTools: "off", and
    // silently leave a renamed/relocated web tool grant in place. The guard must fail closed
    // on a partial match, not just a total one.
    expect(() => applyWebOffPatch(FIXTURE_WITH_ONLY_WEBFETCH)).toThrow(/WebSearch/);
  });

  test("fail-closed guard: still throws when the OTHER single anchor is missing (WebSearch present, WebFetch gone)", () => {
    const fixtureWithOnlyWebSearch = FIXTURE_WITH_ONLY_WEBFETCH.replace("WebFetch", "WebSearch");
    expect(() => applyWebOffPatch(fixtureWithOnlyWebSearch)).toThrow(/WebFetch/);
  });
});

describe("buildStyre: cohort branching (git clone / bun install / build.sh stubbed — no network)", () => {
  test("web-off: patches the allowlist file via readAllowlist/writeAllowlist", async () => {
    const calls: string[] = [];
    let writtenText = "";
    const result = await buildStyre(
      {
        styreRepo: "https://example.invalid/styre.git",
        styreCommit: "deadbeef",
        cohort: "web-off",
        targets: TARGETS,
      },
      {
        cacheDir: "/tmp/fake-cache",
        deps: {
          clone: async () => {
            calls.push("clone");
          },
          checkout: async () => {
            calls.push("checkout");
          },
          bunInstall: async () => {
            calls.push("bunInstall");
          },
          readAllowlist: async () => {
            calls.push("readAllowlist");
            return FIXTURE_WITH_WEB_TOOLS;
          },
          writeAllowlist: async (_cacheDir, text) => {
            calls.push("writeAllowlist");
            writtenText = text;
          },
          compile: async () => {
            calls.push("compile");
          },
        },
      },
    );

    expect(calls).toEqual([
      "clone",
      "checkout",
      "bunInstall",
      "readAllowlist",
      "writeAllowlist",
      "compile",
    ]);
    expect(writtenText).not.toContain('"WebSearch"');
    expect(writtenText).not.toContain('"WebFetch"');
    expect(result.webTools).toBe("off");
    expect(result.commit).toBe("deadbeef");
    // One target -> one binary, keyed by its docker platform, under the cache dir's dist/.
    expect(result.binaries["linux/amd64"]).toContain("/tmp/fake-cache");
    expect(result.binaries["linux/amd64"]).toContain("bun-linux-x64");
  });

  test("web-on: leaves the allowlist file UNTOUCHED (readAllowlist/writeAllowlist never called)", async () => {
    const calls: string[] = [];
    const result = await buildStyre(
      {
        styreRepo: "https://example.invalid/styre.git",
        styreCommit: "deadbeef",
        cohort: "web-on",
        targets: TARGETS,
      },
      {
        cacheDir: "/tmp/fake-cache",
        deps: {
          clone: async () => {
            calls.push("clone");
          },
          checkout: async () => {
            calls.push("checkout");
          },
          bunInstall: async () => {
            calls.push("bunInstall");
          },
          readAllowlist: async () => {
            calls.push("readAllowlist");
            return FIXTURE_WITH_WEB_TOOLS;
          },
          writeAllowlist: async () => {
            calls.push("writeAllowlist");
          },
          compile: async () => {
            calls.push("compile");
          },
        },
      },
    );

    expect(calls).toEqual(["clone", "checkout", "bunInstall", "compile"]);
    expect(calls).not.toContain("readAllowlist");
    expect(calls).not.toContain("writeAllowlist");
    expect(result.webTools).toBe("on");
  });

  test("bun install runs BEFORE the build script (compile needs node_modules)", async () => {
    const order: string[] = [];
    await buildStyre(
      {
        styreRepo: "https://example.invalid/styre.git",
        styreCommit: "abc123",
        cohort: "web-on",
        targets: TARGETS,
      },
      {
        cacheDir: "/tmp/fake-cache",
        deps: {
          clone: async () => {},
          checkout: async () => {},
          bunInstall: async () => {
            order.push("bunInstall");
          },
          readAllowlist: async () => "",
          writeAllowlist: async () => {},
          compile: async () => {
            order.push("compile");
          },
        },
      },
    );
    expect(order).toEqual(["bunInstall", "compile"]);
  });
});

describe("buildStyre: heavy end-to-end (real clone + bun install + compile) — RUN_BUILD=1 only", () => {
  const run = process.env.RUN_BUILD === "1" ? test : test.skip;

  run(
    "clones styreRepo at styreCommit, bun-installs, builds, and returns a runnable binary",
    async () => {
      const cfg = {
        styreRepo: "https://github.com/Twinning-Labs/styre.git",
        styreCommit: process.env.STYRE_BENCH_COMMIT ?? "a2406a4",
        cohort: "web-off" as const,
        targets: TARGETS,
      };
      const result = await buildStyre(cfg);
      // Cross-compiled Linux binary — can't `--version` it on a macOS build host (that's the
      // whole point: it runs in the Linux container, not here). Assert it compiled to a
      // non-empty file at the platform-keyed path instead.
      const binaryPath = result.binaries["linux/amd64"];
      expect(binaryPath).toBeTruthy();
      expect(existsSync(binaryPath as string)).toBe(true);
      expect(statSync(binaryPath as string).size).toBeGreaterThan(0);
    },
    600_000,
  );

  // The BEHAVIORAL web-off probe ("run the binary on a throwaway ticket that tries to
  // fetch a URL; assert it could not") requires orchestrator/run-task.ts (Task 6) to
  // dispatch a ticket to the built binary end-to-end — that module does not exist yet
  // in this repo (Task 4 lands before Task 5/6). Documented here per the task brief so
  // the gap is visible, not silently dropped; wire this up for real once Task 6 lands,
  // and re-run it as part of Task 11 Step 5's live gate.
  test.skip("behavioral: built binary cannot fetch a URL on a 'fetch https://example.com' ticket (BLOCKED on Task 6 run-task.ts)", () => {});
});

/** Creates a real (local, no network) temp git repo with a single commit containing a fixture
 *  `src/dispatch/tool-allowlists.ts` (WebSearch/WebFetch present) — used by the
 *  sequential-cache-reuse tests below, which exercise the REAL checkout+patch+read flow
 *  against real git state, not just in-memory stubs (Task-4 independent-review gap: the
 *  original tests never caught the stale-patch cohort mislabel because they always started
 *  from a fresh in-memory stub, never a REUSED cache dir on disk). */
async function createTempStyreRepo(): Promise<{ repoPath: string; commit: string }> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "styre-bench-fake-repo-"));
  await $`git init -q -b main ${repoPath}`;
  await $`git -C ${repoPath} config user.email test@example.invalid`;
  await $`git -C ${repoPath} config user.name test`;
  const filePath = path.join(repoPath, ALLOWLIST_FILE_REL);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, FIXTURE_WITH_WEB_TOOLS, "utf8");
  await $`git -C ${repoPath} add -A`;
  await $`git -C ${repoPath} commit -q -m "fixture: tool-allowlists with web tools"`;
  const commit = (await $`git -C ${repoPath} rev-parse HEAD`.text()).trim();
  return { repoPath, commit };
}

describe("buildStyre: SEQUENTIAL cache-dir reuse against a REAL temp git repo (Task-4 independent-review Critical: stale-patch cohort mislabel)", () => {
  test("repeat web-off build at the SAME cacheDir does NOT throw a false anchor-missing error (force-reset restores anchors before the second patch)", async () => {
    const { repoPath, commit } = await createTempStyreRepo();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "styre-bench-cache-"));
    try {
      const cfg = {
        styreRepo: repoPath,
        styreCommit: commit,
        cohort: "web-off" as const,
        targets: TARGETS,
      };
      const opts = {
        cacheDir,
        deps: { bunInstall: async () => {}, compile: async () => {} },
      };

      // Run 1: strips WebSearch/WebFetch from the cache dir's working tree.
      const result1 = await buildStyre(cfg, opts);
      expect(result1.webTools).toBe("off");
      const afterRun1 = await readFile(path.join(cacheDir, ALLOWLIST_FILE_REL), "utf8");
      expect(afterRun1).not.toContain('"WebSearch"');
      expect(afterRun1).not.toContain('"WebFetch"');

      // Run 2: SAME cacheDir, SAME cohort, SAME commit. Before the fix, `clone()` no-ops
      // (cache dir already has a .git) and `checkout()` never force-reset the tree, so this
      // reads the ALREADY-stripped file from run 1 and `applyWebOffPatch` throws a false
      // anchor-missing error. The checkout force-reset must restore the anchors first.
      const result2 = await buildStyre(cfg, opts);
      expect(result2.webTools).toBe("off");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("web-off then web-on at the SAME cacheDir: the web-on build sees the PRISTINE file, not the stale web-off patch", async () => {
    const { repoPath, commit } = await createTempStyreRepo();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "styre-bench-cache-"));
    try {
      const deps = { bunInstall: async () => {}, compile: async () => {} };

      // Run 1: web-off patches the file in the shared cache dir.
      const webOffResult = await buildStyre(
        { styreRepo: repoPath, styreCommit: commit, cohort: "web-off", targets: TARGETS },
        { cacheDir, deps },
      );
      expect(webOffResult.webTools).toBe("off");
      const afterWebOff = await readFile(path.join(cacheDir, ALLOWLIST_FILE_REL), "utf8");
      expect(afterWebOff).not.toContain('"WebSearch"');
      expect(afterWebOff).not.toContain('"WebFetch"');

      // Run 2: web-on, SAME cacheDir, SAME commit (the documented way to get the web-on
      // delta). web-on skips the patch step entirely, so whatever is on disk when
      // `compile` runs is what would get compiled. Before the fix, that was the
      // STALE web-off-patched file — the binary would be silently web-OFF while the
      // function reports `webTools: "on"`, mislabeling the cohort and invalidating the
      // contamination delta. The checkout force-reset must restore the pristine file first.
      const webOnResult = await buildStyre(
        { styreRepo: repoPath, styreCommit: commit, cohort: "web-on", targets: TARGETS },
        { cacheDir, deps },
      );
      expect(webOnResult.webTools).toBe("on");

      const fileAtBuildTime = await readFile(path.join(cacheDir, ALLOWLIST_FILE_REL), "utf8");
      expect(fileAtBuildTime).toContain('"WebSearch"');
      expect(fileAtBuildTime).toContain('"WebFetch"');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);
});
