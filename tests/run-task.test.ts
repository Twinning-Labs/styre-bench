import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CLI_VERSION,
  EXAMPLE_COM_TITLE,
  type RunSeed,
  SETUP_FAILED_EXIT,
  buildDockerArgs,
  buildEntrypoint,
  detectWebReachable,
  hasAgentActivity,
  resolveNotifyTier,
  runStyre,
  webOffProbe,
} from "../orchestrator/run-task";
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
    problem_statement: "Calling widget.compute() with a negative offset raises a KeyError.",
    image: "sweb.eval.x86_64.org__repo-123",
    fail_to_pass: ["tests/test_widget.py::test_negative_offset"],
    pass_to_pass: ["tests/test_widget.py::test_basic"],
    fix_patch: ["diff --git a/widget/core.py b/widget/core.py", SENTINEL_FIX_LINE].join("\n"),
    test_patch: [
      "diff --git a/tests/x_regression.py b/tests/x_regression.py",
      SENTINEL_TEST_LINE,
    ].join("\n"),
    ...overrides,
  };
}

function makeSeed(overrides: Partial<RunSeed> = {}): RunSeed {
  return {
    repoUrl: "https://example.invalid/styre-bench-scratch/bench-org__repo-123.git",
    defaultBranch: "main",
    ident: "BENCH-42",
    ...overrides,
  };
}

describe("buildEntrypoint (pure)", () => {
  test("step order: claude install -> wrapper install -> git identity -> origin -> setup -> run", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    const iInstall = script.indexOf("installing claude CLI");
    const iWrapper = script.indexOf("installing the claude transcript-tee wrapper");
    const iGitId = script.indexOf("git config --global user.email");
    const iOrigin = script.indexOf("git remote set-url origin");
    const iSetup = script.indexOf('setup "');
    const iRun = script.indexOf('run "');
    expect(iInstall).toBeGreaterThan(-1);
    expect(iWrapper).toBeGreaterThan(iInstall);
    expect(iGitId).toBeGreaterThan(iWrapper);
    expect(iOrigin).toBeGreaterThan(iGitId);
    expect(iSetup).toBeGreaterThan(iOrigin);
    expect(iRun).toBeGreaterThan(iSetup);
  });

  test("runs styre --in-place with a repo-scoped .styre-disposable marker (git-excluded, before run)", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    // marker dropped at the repo root, and locally excluded so styre's `git add -A` won't commit it
    expect(script).toContain('touch "/testbed/.styre-disposable"');
    expect(script).toContain('echo ".styre-disposable" >> "/testbed/.git/info/exclude"');
    // `.git/info` is ensured before the exclude write (robust to a non-standard git template)
    expect(script).toContain('mkdir -p "/testbed/.git/info"');
    expect(script.indexOf('mkdir -p "/testbed/.git/info"')).toBeLessThan(
      script.indexOf(".git/info/exclude"),
    );
    // the styre run is --in-place
    const runLine = script.split("\n").find((l) => l.includes('run "') && l.includes("--profile"));
    expect(runLine).toContain("--in-place");
    // the marker exists BEFORE the run mutates the repo
    expect(script.indexOf('touch "/testbed/.styre-disposable"')).toBeLessThan(
      script.indexOf('run "'),
    );
  });

  test("the marker + exclude honor a repoDirInImage override (Multi-SWE-bench /home/<repo>)", () => {
    const script = buildEntrypoint({ seed: makeSeed(), repoDirInImage: "/home/darkreader" });
    expect(script).toContain('touch "/home/darkreader/.styre-disposable"');
    expect(script).toContain('echo ".styre-disposable" >> "/home/darkreader/.git/info/exclude"');
    expect(script).not.toContain("/testbed/.styre-disposable");
  });

  test("activates the SWE-bench `testbed` conda env before setup+run (non-login-shell gap), conda-guarded", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain("if command -v conda >/dev/null 2>&1; then");
    expect(script).toContain('source "$(conda info --base)/etc/profile.d/conda.sh"');
    expect(script).toContain("conda activate testbed");
    // activation must precede BOTH styre setup and styre run (so styre's python3 = testbed python)
    expect(script.indexOf("conda activate testbed")).toBeLessThan(script.indexOf('setup "'));
    expect(script.indexOf("conda activate testbed")).toBeLessThan(script.indexOf('run "'));
  });

  test("writes styre's Slack config only when SLACK_BOT_TOKEN is set, before run, default #harness", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    // token-gated so tokenless runs stay silent (styre fail-louds on notifier:slack w/o a token)
    expect(script).toContain('if [ -n "${SLACK_BOT_TOKEN:-}" ]; then');
    expect(script).toContain('"${HOME}/.config/styre/config.json"');
    // the written JSON: notifier slack, quietest tier, default channel
    expect(script).toContain('"notifier":"slack"');
    expect(script).toContain('"notify":"escalations"');
    expect(script).toContain('"channel":"#harness"');
    // the config write precedes styre run (so styre reads it)
    expect(script.indexOf("SLACK_BOT_TOKEN")).toBeLessThan(script.indexOf('run "'));
  });

  test("Slack channel is overridable via slackChannel", () => {
    const script = buildEntrypoint({ seed: makeSeed(), slackChannel: "#my-channel" });
    expect(script).toContain('"channel":"#my-channel"');
    expect(script).not.toContain('"channel":"#harness"');
  });

  test("notify tier defaults to escalations and is overridable via notifyTier", () => {
    expect(buildEntrypoint({ seed: makeSeed() })).toContain('"notify":"escalations"');
    const noisy = buildEntrypoint({ seed: makeSeed(), notifyTier: "everything" });
    expect(noisy).toContain('"notify":"everything"');
    expect(noisy).not.toContain('"notify":"escalations"');
  });

  test("installs a pinned claude CLI version (default CLAUDE_CLI_VERSION) via curl or npm", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain(`bash -s ${CLAUDE_CLI_VERSION}`);
    expect(script).toContain(`@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}`);
  });

  test("honors a claudeCliVersion override", () => {
    const script = buildEntrypoint({ seed: makeSeed(), claudeCliVersion: "9.9.9" });
    expect(script).toContain("bash -s 9.9.9");
    expect(script).not.toContain(`bash -s ${CLAUDE_CLI_VERSION}`);
  });

  test("the wrapper forces --output-format stream-json --verbose and tees to the transcript path", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain('args+=("--output-format" "stream-json" "--verbose")');
    expect(script).toContain('tee -a "$TRANSCRIPT_PATH"');
    expect(script).toContain('TRANSCRIPT_PATH="/out/transcript.jsonl"');
  });

  test("the wrapper strips any caller-supplied --output-format before forcing stream-json", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain('if [ "$a" = "--output-format" ]; then skip_next=true; continue; fi');
  });

  test("the wrapper strips any caller-supplied --verbose before forcing it back on (robustness)", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain('if [ "$a" = "--verbose" ]; then continue; fi');
  });

  test("the wrapper passes through all other args and the exit code (via PIPESTATUS, not tee's)", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain('args+=("$a")');
    // Tees the full stream-json to the transcript, but pipes stdout through the python3
    // extractor (NOT `tail -n 1`) so styre gets the plain-text `.result`, not a JSON envelope.
    expect(script).toContain(
      '"$REAL_CLAUDE" "${args[@]}" | tee -a "$TRANSCRIPT_PATH" | python3 "/opt/styre-bench/wrapper-bin/extract-result.py"',
    );
    expect(script).not.toContain("| tail -n 1");
    expect(script).toContain('wrapper_exit="${PIPESTATUS[0]}"');
    expect(script).toContain('exit "$wrapper_exit"');
  });

  test("installs the python3 result-extractor (plain-text `.result` for styre's extractSidecar) and guards python3 presence", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    // Fails loudly if python3 is absent rather than silently emitting empty stdout.
    expect(script).toContain("if ! command -v python3 >/dev/null 2>&1; then");
    expect(script).toContain(
      "cat > /opt/styre-bench/wrapper-bin/extract-result.py <<'EXTRACT_EOF'",
    );
    // The extractor keys on the terminal `result` event and prints its `.result` field.
    expect(script).toContain('if isinstance(obj, dict) and obj.get("type") == "result"');
    expect(script).toContain('sys.stdout.write(result if result is not None else "")');
  });

  test("sets git commit identity (user.email + user.name)", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain('git config --global user.email "bench@styre.dev"');
    expect(script).toContain('git config --global user.name "styre-bench"');
  });

  test("sets origin to seed.repoUrl and the local branch to seed.defaultBranch", () => {
    const seed = makeSeed({
      repoUrl: "https://example.invalid/org/some-repo.git",
      defaultBranch: "trunk",
    });
    const script = buildEntrypoint({ seed });
    expect(script).toContain(
      'git remote set-url origin "https://example.invalid/org/some-repo.git"',
    );
    expect(script).toContain('git remote add origin "https://example.invalid/org/some-repo.git"');
    expect(script).toContain('git checkout -B "trunk"');
  });

  test("configures a github.com push credential from BENCH_GH_TOKEN, without embedding it in origin", () => {
    const seed = makeSeed({ repoUrl: "https://github.com/styre-bench-scratch/some-repo.git" });
    const script = buildEntrypoint({ seed });
    // an inline credential helper that reads the token from the container env (never a file/URL)
    expect(script).toContain("git config --global credential.helper");
    expect(script).toContain("$BENCH_GH_TOKEN");
    expect(script).toContain("username=x-access-token");
    // origin stays tokenless (styre derives owner/repo from it; the token must not leak there)
    expect(script).toContain(
      'git remote set-url origin "https://github.com/styre-bench-scratch/some-repo.git"',
    );
    expect(script).not.toContain("x-access-token:");
    // set before styre run so merge:push can authenticate
    expect(script.indexOf("credential.helper")).toBeLessThan(script.indexOf('run "BENCH-42"'));
  });

  test("runs styre setup with --out a deterministic profile path + --trust-agent-commands, on the repoDirInImage default (/testbed)", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain('cd "/testbed"');
    // --trust-agent-commands: bench is autonomous/headless, so styre must accept agent-discovered
    // build/test/check commands (else it can't ground-truth-verify most stacks).
    expect(script).toContain('setup "/testbed" --out "/out/profile.json" --trust-agent-commands');
  });

  test("honors a repoDirInImage override", () => {
    const script = buildEntrypoint({ seed: makeSeed(), repoDirInImage: "/repo" });
    expect(script).toContain('cd "/repo"');
    expect(script).toContain('setup "/repo" --out "/out/profile.json"');
  });

  test("a styre setup failure exits with the distinct SETUP_FAILED_EXIT (probe), not a generic non-zero", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    // setup is wrapped so its non-zero exit is captured (not aborted by set -e) and mapped to
    // the sentinel exit code — collect reads it as `probe`, not `infra`.
    expect(script).toContain('setup_exit="$?"');
    expect(script).toContain('if [ "$setup_exit" -ne 0 ]; then');
    expect(script).toContain(`exit ${SETUP_FAILED_EXIT}`);
    // The sentinel must differ from styre run's own exit passthrough.
    expect(SETUP_FAILED_EXIT).toBe(70);
  });

  test("runs styre run with the seed ident + --profile, AFTER setup, teeing NDJSON stdout", () => {
    const seed = makeSeed({ ident: "ENG-999" });
    const script = buildEntrypoint({ seed });
    expect(script).toContain(
      'run "ENG-999" --profile "/out/profile.json" --in-place | tee "/out/run.ndjson"',
    );
    expect(script).toContain('run_exit="${PIPESTATUS[0]}"');
  });

  test("web-off cohort: the claude wrapper appends --disallowedTools WebSearch WebFetch (layer 2)", () => {
    const script = buildEntrypoint({ seed: makeSeed(), cohort: "web-off" });
    expect(script).toContain('args+=("--disallowedTools" "WebSearch" "WebFetch")');
    // ordering: the disallowedTools append happens AFTER the forced --output-format/--verbose
    // append, so both survive on the final invocation.
    const iForced = script.indexOf('args+=("--output-format" "stream-json" "--verbose")');
    const iDisallowed = script.indexOf('args+=("--disallowedTools" "WebSearch" "WebFetch")');
    expect(iForced).toBeGreaterThan(-1);
    expect(iDisallowed).toBeGreaterThan(iForced);
  });

  test("web-on cohort (and the default, cohort omitted): the wrapper never appends --disallowedTools", () => {
    const scriptOn = buildEntrypoint({ seed: makeSeed(), cohort: "web-on" });
    const scriptDefault = buildEntrypoint({ seed: makeSeed() });
    expect(scriptOn).not.toContain("--disallowedTools");
    expect(scriptDefault).not.toContain("--disallowedTools");
  });

  test("FIREWALL: never contains held-out fix_patch/test_patch sentinel content or a .claude reference (structural: buildEntrypoint takes no such input)", () => {
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).not.toContain(SENTINEL_FIX_LINE);
    expect(script).not.toContain(SENTINEL_TEST_LINE);
    expect(script).not.toContain(".claude");
  });
});

describe("resolveNotifyTier (pure)", () => {
  test("accepts the three valid tiers", () => {
    expect(resolveNotifyTier("escalations")).toBe("escalations");
    expect(resolveNotifyTier("transitions")).toBe("transitions");
    expect(resolveNotifyTier("everything")).toBe("everything");
  });

  test("returns undefined (→ default) for unset/empty", () => {
    expect(resolveNotifyTier(undefined)).toBeUndefined();
    expect(resolveNotifyTier("")).toBeUndefined();
  });

  test("returns undefined + warns for an invalid value (falls back, never crashes)", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let warned = "";
    // capture the warning so it's asserted AND doesn't pollute test output
    process.stderr.write = ((s: string) => {
      warned += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(resolveNotifyTier("loud")).toBeUndefined();
      expect(resolveNotifyTier("ESCALATIONS")).toBeUndefined(); // case-sensitive
    } finally {
      process.stderr.write = orig;
    }
    expect(warned).toContain("STYRE_NOTIFY");
    expect(warned).toContain("loud");
  });
});

describe("buildDockerArgs (pure)", () => {
  const creds = {
    anthropicApiKey: "ak-1",
    linearApiKey: "lk-1",
    githubToken: "gh-1",
    benchGhToken: "bgh-1",
    slackBotToken: "slk-1",
  };

  test("defaults --platform to linux/amd64 when none is passed (MSB + legacy/fixture callers)", () => {
    const args = buildDockerArgs({
      image: "sweb.eval.x86_64.org__repo-123",
      binaryPath: "/host/dist/styre",
      outDir: "/host/out",
      entrypointHostPath: "/host/out/entrypoint.sh",
      creds,
    });
    expect(args).toContain("--platform");
    expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
    // early, right after run/--rm
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--platform", "linux/amd64"]);
  });

  test("honors an explicit per-instance platform (SWE-bench arm64 -> linux/arm64, native, no emulation)", () => {
    const args = buildDockerArgs({
      image: "swebench/sweb.eval.arm64.org__repo-123",
      platform: "linux/arm64",
      binaryPath: "/host/dist/styre",
      outDir: "/host/out",
      entrypointHostPath: "/host/out/entrypoint.sh",
      creds,
    });
    expect(args[args.indexOf("--platform") + 1]).toBe("linux/arm64");
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--platform", "linux/arm64"]);
  });

  test("mounts exactly the binary (ro), the outDir (rw), and the entrypoint script (ro)", () => {
    const args = buildDockerArgs({
      image: "sweb.eval.x86_64.org__repo-123",
      binaryPath: "/host/dist/styre",
      outDir: "/host/out",
      entrypointHostPath: "/host/out/entrypoint.sh",
      creds,
    });
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toEqual([
      "/host/dist/styre:/styre-bin/styre:ro",
      "/host/out:/out",
      "/host/out/entrypoint.sh:/entrypoint.sh:ro",
    ]);
  });

  test("passes creds as -e env flags", () => {
    const args = buildDockerArgs({
      image: "img",
      binaryPath: "/b",
      outDir: "/o",
      entrypointHostPath: "/e",
      creds,
    });
    expect(args).toContain("ANTHROPIC_API_KEY=ak-1");
    expect(args).toContain("LINEAR_API_KEY=lk-1");
    expect(args).toContain("GITHUB_TOKEN=gh-1");
    expect(args).toContain("BENCH_GH_TOKEN=bgh-1");
    expect(args).toContain("SLACK_BOT_TOKEN=slk-1");
  });

  test("SLACK_BOT_TOKEN is forwarded even when empty (unset = notifications off, not an error)", () => {
    const args = buildDockerArgs({
      image: "img",
      binaryPath: "/b",
      outDir: "/o",
      entrypointHostPath: "/e",
      creds: { ...creds, slackBotToken: "" },
    });
    // present as an -e pair with an empty value; the entrypoint's [ -n ] guard treats it as off
    expect(args).toContain("SLACK_BOT_TOKEN=");
  });

  test("runs the entrypoint script via --entrypoint bash <image> <script>", () => {
    const args = buildDockerArgs({
      image: "sweb.eval.x86_64.org__repo-123",
      binaryPath: "/b",
      outDir: "/o",
      entrypointHostPath: "/e",
      creds,
    });
    expect(args).toContain("--entrypoint");
    expect(args.at(-2)).toBe("sweb.eval.x86_64.org__repo-123");
    expect(args.at(-1)).toBe("/entrypoint.sh");
  });

  test("FIREWALL: the mount/arg set never references test_patch/fix_patch content or a .claude path", () => {
    const args = buildDockerArgs({
      image: "img",
      binaryPath: "/host/dist/styre",
      outDir: "/host/out",
      entrypointHostPath: "/host/out/entrypoint.sh",
      creds,
    });
    const joined = args.join(" ");
    expect(joined).not.toContain(SENTINEL_FIX_LINE);
    expect(joined).not.toContain(SENTINEL_TEST_LINE);
    expect(joined).not.toContain(".claude");
    // exactly 3 -v flags: no extra/surprise mount was added
    expect(args.filter((a) => a === "-v")).toHaveLength(3);
  });
});

describe("runStyre (wiring — deps stubbed, no real docker daemon)", () => {
  test("writes the entrypoint, builds docker args from it, spawns docker, and returns HOST paths + exit code", async () => {
    const calls: string[] = [];
    let writtenEntrypoint = "";
    let spawnedArgs: string[] = [];
    const inst = makeInstance({ id: "abc123", image: "sweb.eval.x86_64.abc123" });
    const seed = makeSeed();

    const result = await runStyre(
      inst,
      seed,
      "/host/dist/styre",
      {
        outDir: "/host/out/abc123",
        creds: { anthropicApiKey: "ak", linearApiKey: "lk", githubToken: "gh" },
      },
      {
        deps: {
          ensureOutDir: async (outDir) => {
            calls.push(`ensureOutDir:${outDir}`);
          },
          writeEntrypoint: async (hostPath, content) => {
            calls.push(`writeEntrypoint:${hostPath}`);
            writtenEntrypoint = content;
          },
          spawnDocker: async (args) => {
            calls.push("spawnDocker");
            spawnedArgs = args;
            return 0;
          },
        },
      },
    );

    expect(calls).toEqual([
      "ensureOutDir:/host/out/abc123",
      "writeEntrypoint:/host/out/abc123/entrypoint.sh",
      "spawnDocker",
    ]);
    expect(writtenEntrypoint).toContain('run "BENCH-42"');
    expect(spawnedArgs).toContain("sweb.eval.x86_64.abc123");
    expect(spawnedArgs.join(" ")).toContain("/host/out/abc123:/out");
    expect(result).toEqual({
      ndjsonPath: "/host/out/abc123/run.ndjson",
      transcriptPath: "/host/out/abc123/transcript.jsonl",
      profilePath: "/host/out/abc123/profile.json",
      exitCode: 0,
    });
  });

  test("propagates the container's (non-zero) exit code", async () => {
    const inst = makeInstance();
    const seed = makeSeed();
    const result = await runStyre(
      inst,
      seed,
      "/host/dist/styre",
      {
        outDir: "/host/out/x",
        creds: { anthropicApiKey: "a", linearApiKey: "l", githubToken: "g" },
      },
      {
        deps: {
          ensureOutDir: async () => {},
          writeEntrypoint: async () => {},
          spawnDocker: async () => 1,
        },
      },
    );
    expect(result.exitCode).toBe(1);
  });

  test("throws when a required cred is missing from both cfg.creds and the environment", async () => {
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevLinear = process.env.LINEAR_API_KEY;
    const prevGithub = process.env.GITHUB_TOKEN;
    process.env.ANTHROPIC_API_KEY = undefined;
    process.env.LINEAR_API_KEY = undefined;
    process.env.GITHUB_TOKEN = undefined;
    try {
      await expect(
        runStyre(
          makeInstance(),
          makeSeed(),
          "/host/dist/styre",
          { outDir: "/host/out/y" },
          {
            deps: {
              ensureOutDir: async () => {},
              writeEntrypoint: async () => {},
              spawnDocker: async () => 0,
            },
          },
        ),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevLinear !== undefined) process.env.LINEAR_API_KEY = prevLinear;
      if (prevGithub !== undefined) process.env.GITHUB_TOKEN = prevGithub;
    }
  });
});

describe("detectWebReachable (pure — the webOffProbe detection logic)", () => {
  test("true when the diff contains the real example.com page title", () => {
    const diff = "diff --git a/PLAN.md b/PLAN.md\n+The page title is: Example Domain\n";
    expect(detectWebReachable(diff, "")).toBe(true);
  });

  test(`EXAMPLE_COM_TITLE is the real title ("${EXAMPLE_COM_TITLE}")`, () => {
    expect(EXAMPLE_COM_TITLE).toBe("Example Domain");
  });

  test("true when the transcript shows a WebFetch tool_use referencing example.com (structured NDJSON)", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({
        type: "tool_use",
        name: "WebFetch",
        input: { url: "https://example.com" },
      }),
    ].join("\n");
    expect(detectWebReachable("", transcript)).toBe(true);
  });

  test("true when a WebSearch tool_use references example.com", () => {
    const transcript = JSON.stringify({
      type: "tool_use",
      name: "WebSearch",
      input: { query: "example.com site info" },
    });
    expect(detectWebReachable("", transcript)).toBe(true);
  });

  test("false: clean diff + transcript with no fetch tool and no title (correct web-off behavior)", () => {
    const diff = "diff --git a/docs/plans/1.md b/docs/plans/1.md\n+Some unrelated design note.\n";
    const transcript = JSON.stringify({ type: "tool_use", name: "Read", input: { file: "a.ts" } });
    expect(detectWebReachable(diff, transcript)).toBe(false);
  });

  test("false: a WebFetch/WebSearch call that does NOT target example.com is not a false positive", () => {
    const transcript = JSON.stringify({
      type: "tool_use",
      name: "WebFetch",
      input: { url: "https://docs.anthropic.com/some-page" },
    });
    expect(detectWebReachable("", transcript)).toBe(false);
  });

  test("raw-text fallback: detects a fetch reference even when the transcript line isn't valid JSON", () => {
    const transcript = "tool_use name=WebFetch url=https://example.com (non-JSON log line)";
    expect(detectWebReachable("", transcript)).toBe(true);
  });
});

describe("hasAgentActivity (pure — the webOffProbe liveness gate)", () => {
  test("true for a transcript containing a structured assistant event", () => {
    const transcript = JSON.stringify({ type: "assistant", message: { content: [] } });
    expect(hasAgentActivity(transcript)).toBe(true);
  });

  test("true for a transcript containing a structured tool_use event", () => {
    const transcript = JSON.stringify({ type: "tool_use", name: "Read", input: {} });
    expect(hasAgentActivity(transcript)).toBe(true);
  });

  test("true via the raw-text fallback when the line isn't valid JSON", () => {
    expect(hasAgentActivity('some log noise "type":"assistant" more noise')).toBe(true);
  });

  test("false for an empty transcript", () => {
    expect(hasAgentActivity("")).toBe(false);
    expect(hasAgentActivity("   \n  ")).toBe(false);
  });

  test("false for a non-empty transcript with no assistant/tool_use activity", () => {
    expect(hasAgentActivity("styre-bench entrypoint: [1/6] installing claude CLI\n")).toBe(false);
  });
});

describe("webOffProbe (wiring — deps stubbed)", () => {
  const PROBE_IMAGE = "styre-bench-scratch/probe-with-repo:latest";

  function makeLiveTranscript(): string {
    return [
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({
        type: "tool_use",
        name: "WebFetch",
        input: { url: "https://example.com" },
      }),
    ].join("\n");
  }

  test("throws when cfg.probeImage is omitted (no safe default repo-provisioned image)", async () => {
    await expect(
      webOffProbe(
        "/host/dist/styre",
        // biome-ignore lint/suspicious/noExplicitAny: exercising the missing-required-field path
        { benchGithubOrg: "styre-bench-scratch", linearProjectId: "proj-1" } as any,
      ),
    ).rejects.toThrow(/probeImage is required/);
  });

  test("seeds github+linear, runs styre via runStyre, then detects from the resulting diff/transcript", async () => {
    const calls: string[] = [];
    const result = await webOffProbe(
      "/host/dist/styre",
      {
        benchGithubOrg: "styre-bench-scratch",
        linearProjectId: "proj-1",
        probeImage: PROBE_IMAGE,
      },
      {
        deps: {
          seedGithub: async () => {
            calls.push("seedGithub");
            return { repoUrl: "https://example.invalid/x.git", defaultBranch: "main" };
          },
          seedLinear: async () => {
            calls.push("seedLinear");
            return { ident: "BENCH-PROBE" };
          },
          runStyre: async (_inst, seed) => {
            calls.push(`runStyre:${seed.ident}`);
            return {
              ndjsonPath: "/o/run.ndjson",
              transcriptPath: "/o/transcript.jsonl",
              profilePath: "/o/profile.json",
              exitCode: 0,
            };
          },
          readDiff: async () => "",
          readTranscript: async () => {
            calls.push("readTranscript");
            return makeLiveTranscript();
          },
        },
      },
    );

    expect(calls).toEqual(["seedGithub", "seedLinear", "runStyre:BENCH-PROBE", "readTranscript"]);
    expect(result).toEqual({ webReachable: true });
  });

  test("webReachable: false when neither the diff nor the transcript shows a fetch, AND the run was live (the expected web-off result)", async () => {
    const result = await webOffProbe(
      "/host/dist/styre",
      {
        benchGithubOrg: "styre-bench-scratch",
        linearProjectId: "proj-1",
        probeImage: PROBE_IMAGE,
      },
      {
        deps: {
          seedGithub: async () => ({
            repoUrl: "https://example.invalid/x.git",
            defaultBranch: "main",
          }),
          seedLinear: async () => ({ ident: "BENCH-PROBE" }),
          runStyre: async () => ({
            ndjsonPath: "/o/run.ndjson",
            transcriptPath: "/o/transcript.jsonl",
            profilePath: "/o/profile.json",
            exitCode: 0,
          }),
          readDiff: async () => "diff --git a/README.md b/README.md\n+unrelated change\n",
          readTranscript: async () => JSON.stringify({ type: "tool_use", name: "Read", input: {} }),
        },
      },
    );
    expect(result).toEqual({ webReachable: false });
  });

  test("THROWS instead of returning false when the run had a non-zero exit code (dead run, not a real web-off pass)", async () => {
    await expect(
      webOffProbe(
        "/host/dist/styre",
        {
          benchGithubOrg: "styre-bench-scratch",
          linearProjectId: "proj-1",
          probeImage: PROBE_IMAGE,
        },
        {
          deps: {
            seedGithub: async () => ({
              repoUrl: "https://example.invalid/x.git",
              defaultBranch: "main",
            }),
            seedLinear: async () => ({ ident: "BENCH-PROBE" }),
            runStyre: async () => ({
              ndjsonPath: "/o/run.ndjson",
              transcriptPath: "/o/transcript.jsonl",
              profilePath: "/o/profile.json",
              exitCode: 1,
            }),
            readDiff: async () => "",
            readTranscript: async () => "",
          },
        },
      ),
    ).rejects.toThrow(/web-off probe did not execute/);
  });

  test("THROWS instead of returning false when the transcript shows zero agent activity (empty transcript, exit 0)", async () => {
    await expect(
      webOffProbe(
        "/host/dist/styre",
        {
          benchGithubOrg: "styre-bench-scratch",
          linearProjectId: "proj-1",
          probeImage: PROBE_IMAGE,
        },
        {
          deps: {
            seedGithub: async () => ({
              repoUrl: "https://example.invalid/x.git",
              defaultBranch: "main",
            }),
            seedLinear: async () => ({ ident: "BENCH-PROBE" }),
            runStyre: async () => ({
              ndjsonPath: "/o/run.ndjson",
              transcriptPath: "/o/transcript.jsonl",
              profilePath: "/o/profile.json",
              exitCode: 0,
            }),
            readDiff: async () => "",
            readTranscript: async () => "",
          },
        },
      ),
    ).rejects.toThrow(/web-off probe did not execute/);
  });

  test("THROWS (infra error) when the transcript file is missing/unreadable, rather than treating it as no-activity", async () => {
    await expect(
      webOffProbe(
        "/host/dist/styre",
        {
          benchGithubOrg: "styre-bench-scratch",
          linearProjectId: "proj-1",
          probeImage: PROBE_IMAGE,
        },
        {
          deps: {
            seedGithub: async () => ({
              repoUrl: "https://example.invalid/x.git",
              defaultBranch: "main",
            }),
            seedLinear: async () => ({ ident: "BENCH-PROBE" }),
            runStyre: async () => ({
              ndjsonPath: "/o/run.ndjson",
              transcriptPath: "/o/transcript.jsonl",
              profilePath: "/o/profile.json",
              exitCode: 0,
            }),
            readDiff: async () => "",
            readTranscript: async () => null,
          },
        },
      ),
    ).rejects.toThrow(/transcript file missing or unreadable/);
  });

  test("does NOT throw on a webReachable:true result even without exercising the liveness gate (a positive hit is self-evidently live)", async () => {
    const result = await webOffProbe(
      "/host/dist/styre",
      {
        benchGithubOrg: "styre-bench-scratch",
        linearProjectId: "proj-1",
        probeImage: PROBE_IMAGE,
      },
      {
        deps: {
          seedGithub: async () => ({
            repoUrl: "https://example.invalid/x.git",
            defaultBranch: "main",
          }),
          seedLinear: async () => ({ ident: "BENCH-PROBE" }),
          runStyre: async () => ({
            ndjsonPath: "/o/run.ndjson",
            transcriptPath: "/o/transcript.jsonl",
            profilePath: "/o/profile.json",
            exitCode: 0,
          }),
          readDiff: async () =>
            "diff --git a/PLAN.md b/PLAN.md\n+The page title is: Example Domain\n",
          readTranscript: async () => "",
        },
      },
    );
    expect(result).toEqual({ webReachable: true });
  });
});

describe("runStyre: LIVE containerized run — RUN_LIVE=1 only", () => {
  const run = process.env.RUN_LIVE === "1" ? test : test.skip;

  run(
    "docker-runs a real instance image end to end and produces readable ndjson/transcript/profile",
    async () => {
      // Requires: a real docker daemon, a pulled SWE-bench/Multi-SWE-bench instance image, a
      // built styre binary (build-styre.ts), a real seeded GitHub repo + Linear ticket
      // (seed-github.ts/seed-linear.ts), and ANTHROPIC_API_KEY/LINEAR_API_KEY/GITHUB_TOKEN in
      // the environment. Wired for real as part of Task 11's end-to-end gated pass — not
      // exercised standalone here to avoid duplicating that heavier fixture setup.
      throw new Error("not wired standalone; see Task 11's gated end-to-end pass");
    },
  );
});

describe("webOffProbe: LIVE behavioral web-off check — RUN_LIVE=1 only", () => {
  const run = process.env.RUN_LIVE === "1" ? test : test.skip;

  run("a web-off build cannot reach https://example.com (webReachable: false)", async () => {
    // Requires a real web-off styre binary (build-styre.ts, RUN_BUILD=1) + real seeding creds
    // + a real docker run. Wired for real as part of Task 11's gated end-to-end pass.
    throw new Error("not wired standalone; see Task 11's gated end-to-end pass");
  });

  // POSITIVE CONTROL (Task-6 review fix — see webOffProbe's doc). A `webReachable: false`
  // result from the test above proves nothing on its own: it is equally consistent with "the
  // allowlist patch correctly blocks web access" and "the probe itself is broken (e.g. the
  // wrong image/repoDir, a dead entrypoint) and always reports false". This paired run against
  // an UNPATCHED (web-ON) styre binary must yield `webReachable: true`; only the CONTRAST
  // between the two proves the web-off test above is meaningful. Wired for real as part of
  // Task 11's gated end-to-end pass alongside the web-off case above.
  run(
    "positive control: a web-ON (unpatched) build CAN reach https://example.com (webReachable: true)",
    async () => {
      throw new Error("not wired standalone; see Task 11's gated end-to-end pass");
    },
  );
});
