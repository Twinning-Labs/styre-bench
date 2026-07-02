import { describe, expect, test } from "bun:test";
import { applyWebOffPatch, buildStyre } from "../orchestrator/build-styre";

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

  test("produces syntactically plausible TS: no dangling/double commas or empty array slots", () => {
    const patched = applyWebOffPatch(FIXTURE_WITH_WEB_TOOLS);
    expect(patched).not.toMatch(/,\s*,/); // no double comma left behind
    expect(patched).not.toMatch(/,\s*\]/); // no trailing comma before a closing bracket
    expect(patched).not.toMatch(/\[\s*,/); // no leading comma after an opening bracket
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
          runBuildScript: async () => {
            calls.push("runBuildScript");
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
      "runBuildScript",
    ]);
    expect(writtenText).not.toContain('"WebSearch"');
    expect(writtenText).not.toContain('"WebFetch"');
    expect(result.webTools).toBe("off");
    expect(result.commit).toBe("deadbeef");
    expect(result.binaryPath).toContain("/tmp/fake-cache");
  });

  test("web-on: leaves the allowlist file UNTOUCHED (readAllowlist/writeAllowlist never called)", async () => {
    const calls: string[] = [];
    const result = await buildStyre(
      { styreRepo: "https://example.invalid/styre.git", styreCommit: "deadbeef", cohort: "web-on" },
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
          runBuildScript: async () => {
            calls.push("runBuildScript");
          },
        },
      },
    );

    expect(calls).toEqual(["clone", "checkout", "bunInstall", "runBuildScript"]);
    expect(calls).not.toContain("readAllowlist");
    expect(calls).not.toContain("writeAllowlist");
    expect(result.webTools).toBe("on");
  });

  test("bun install runs BEFORE the build script (compile needs node_modules)", async () => {
    const order: string[] = [];
    await buildStyre(
      { styreRepo: "https://example.invalid/styre.git", styreCommit: "abc123", cohort: "web-on" },
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
          runBuildScript: async () => {
            order.push("runBuildScript");
          },
        },
      },
    );
    expect(order).toEqual(["bunInstall", "runBuildScript"]);
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
      };
      const result = await buildStyre(cfg);
      const proc = Bun.spawnSync([result.binaryPath, "--version"]);
      expect(proc.exitCode).toBe(0);
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
