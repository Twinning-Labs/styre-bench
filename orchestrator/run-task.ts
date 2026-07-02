import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedGithub } from "./seed-github";
import type { SeedGithubConfig, SeedGithubResult } from "./seed-github";
import { seedLinear } from "./seed-linear";
import type { SeedLinearConfig, SeedLinearResult } from "./seed-linear";
import type { Instance } from "./types";

/**
 * Pinned Claude Code CLI version installed inside the benchmark container (Step 1 of the
 * entrypoint). SWE-bench/Multi-SWE-bench images do NOT ship `claude` — styre shells out to
 * `claude -p` for every agent step, including the mandatory `styre setup` Opus call — so a
 * version must be pinned here before ANY live run. **UNVERIFIED in this session** (no
 * container was actually run): confirm this resolves via the native installer
 * (`curl -fsSL https://claude.ai/install.sh | bash -s <version>`) or `npm install -g
 * @anthropic-ai/claude-code@<version>` before the first RUN_LIVE=1 pass, and bump it here.
 */
export const CLAUDE_CLI_VERSION = "2.0.1";

/** SWE-bench convention: the pre-built instance image has the repo already checked out here.
 *  **UNVERIFIED for Multi-SWE-bench** (the TS/JS/Go/Java/Rust corpus) in this session — its
 *  images may use a different path; confirm per-corpus before a live run and override via
 *  `RunStyreConfig.repoDirInImage` if it differs. */
export const DEFAULT_REPO_DIR_IN_IMAGE = "/testbed";

// Fixed container-side paths — compile-time constants, never derived from instance/seed data,
// so the entrypoint script and the docker mount set can never accidentally embed
// inst.test_patch/fix_patch content (the FIREWALL is structural: neither buildEntrypoint nor
// buildDockerArgs even accepts those fields as input — see the interfaces below).
const CONTAINER_BINARY_PATH = "/styre-bin/styre";
const CONTAINER_OUT_DIR = "/out";
const CONTAINER_NDJSON_PATH = `${CONTAINER_OUT_DIR}/run.ndjson`;
const CONTAINER_TRANSCRIPT_PATH = `${CONTAINER_OUT_DIR}/transcript.jsonl`;
const CONTAINER_PROFILE_PATH = `${CONTAINER_OUT_DIR}/profile.json`;
const CONTAINER_ENTRYPOINT_PATH = "/entrypoint.sh";
const WRAPPER_DIR = "/opt/styre-bench/wrapper-bin";
const WRAPPER_PATH = `${WRAPPER_DIR}/claude`;
const REAL_CLAUDE_LINK = "/opt/styre-bench/real-claude";
const GIT_IDENTITY_EMAIL = "bench@styre.dev"; // matches seed-github.ts's push-commit identity
const GIT_IDENTITY_NAME = "styre-bench";

/** The github+linear seed result combined — everything `runStyre` needs to point the
 *  containerized styre at the throwaway repo/ticket (seed-github.ts's `SeedGithubResult` +
 *  seed-linear.ts's `SeedLinearResult`). */
export type RunSeed = SeedGithubResult & SeedLinearResult;

export interface RunStyreCreds {
  anthropicApiKey: string;
  linearApiKey: string;
  githubToken: string;
}

export interface BuildEntrypointInput {
  seed: RunSeed;
  /** Path inside the instance image the corpus repo is already checked out at.
   *  Default `DEFAULT_REPO_DIR_IN_IMAGE` ("/testbed", SWE-bench convention — UNVERIFIED for
   *  Multi-SWE-bench, see that constant's doc). */
  repoDirInImage?: string;
  /** Overrides `CLAUDE_CLI_VERSION` (tests / a future re-pin without editing the constant). */
  claudeCliVersion?: string;
}

/**
 * PURE. Builds the bash entrypoint script run inside the instance container, in the exact
 * order the task-6 brief specifies (each step is load-bearing on the one before it):
 *
 * 1. Installs the pinned `claude` CLI (native installer via curl, falling back to npm) and
 *    resolves its real, installed location to a fixed symlink (`REAL_CLAUDE_LINK`) so the
 *    wrapper below can reference it as a compile-time-known literal path — no runtime
 *    string-templating of the wrapper file needed. Fails loudly (exit 1) if neither curl nor
 *    npm is present: a benchmark image lacking BOTH needs a derived image layer with `claude`
 *    pre-baked instead (documented gap, not silently ignored).
 * 2. Installs a `claude` WRAPPER at `WRAPPER_PATH`, on a directory prepended to PATH so it
 *    shadows the real CLI for every subsequent invocation (including inside `styre setup`
 *    and `styre run`, which shell out to the bare `claude` command). The wrapper: strips any
 *    `--output-format <fmt>` pair the caller passed, forces `--output-format stream-json`,
 *    tees the full NDJSON event stream to `CONTAINER_TRANSCRIPT_PATH` (append mode — the
 *    transcript accumulates across every `claude` call in the run, which is what the leak
 *    detector's URL-scan needs), and prints only the LAST stream-json line (the terminal
 *    `result` event) to stdout — matching the shape `claude.ts`'s `parseClaudeJson` expects
 *    from `--output-format json` (UNVERIFIED against a real CLI run in this session: confirmed
 *    only by inspection of styre's `src/agent/providers/claude.ts`, which itself notes its
 *    flag/field assumptions are "verified against a real `claude` run in the Task 7 smoke" —
 *    re-verify this wrapper the same way before trusting it live). Exit code is passed through
 *    via `PIPESTATUS[0]`, not the tee/tail tail-of-pipe status.
 * 3. `git config --global user.email/user.name` — else styre's first implement commit dies in
 *    a bare image (no committer identity).
 * 4. Points the ALREADY-checked-out repo's `origin` at `seed.repoUrl` and resets the local
 *    branch to `seed.defaultBranch` — styre's github adapter derives owner/repo from `origin`
 *    and throws otherwise.
 * 5. `styre setup <repoDirInImage> --out <profilePath>` — deterministic path (setup otherwise
 *    writes under `$XDG_CONFIG_HOME/styre/<slug>/profile.json`, which `runStyre`'s caller has
 *    no fixed handle on).
 * 6. `styre run <seed.ident> --profile <profilePath>`, teeing NDJSON stdout to
 *    `CONTAINER_NDJSON_PATH`; the container's own exit code is styre run's exit code
 *    (`PIPESTATUS[0]`, not tee's).
 *
 * FIREWALL: this function's input type carries no `test_patch`/`fix_patch`/`.claude` data at
 * all — `RunSeed` is only `{ repoUrl, defaultBranch, ident }` — so there is no code path by
 * which held-out content could end up embedded in the generated script.
 */
export function buildEntrypoint(input: BuildEntrypointInput): string {
  const repoDirInImage = input.repoDirInImage ?? DEFAULT_REPO_DIR_IN_IMAGE;
  const claudeCliVersion = input.claudeCliVersion ?? CLAUDE_CLI_VERSION;
  const { seed } = input;

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `echo 'styre-bench entrypoint: [1/6] installing claude CLI (pinned ${claudeCliVersion})'`,
    "if command -v curl >/dev/null 2>&1; then",
    `  curl -fsSL https://claude.ai/install.sh | bash -s ${claudeCliVersion}`,
    '  export PATH="$HOME/.local/bin:$PATH"',
    "elif command -v npm >/dev/null 2>&1; then",
    `  npm install -g @anthropic-ai/claude-code@${claudeCliVersion}`,
    "else",
    `  echo 'FATAL: entrypoint: neither curl nor npm is available to install claude ${claudeCliVersion} -- this image needs a derived layer with claude pre-baked' >&2`,
    "  exit 1",
    "fi",
    'REAL_CLAUDE_BIN="$(command -v claude || true)"',
    'if [ -z "$REAL_CLAUDE_BIN" ]; then',
    "  echo 'FATAL: entrypoint: claude CLI install reported success but claude is not on PATH' >&2",
    "  exit 1",
    "fi",
    `mkdir -p ${path.dirname(REAL_CLAUDE_LINK)}`,
    `ln -sf "$REAL_CLAUDE_BIN" ${REAL_CLAUDE_LINK}`,
    "",
    "echo 'styre-bench entrypoint: [2/6] installing the claude transcript-tee wrapper on PATH'",
    `mkdir -p ${WRAPPER_DIR}`,
    `cat > ${WRAPPER_PATH} <<'WRAPPER_EOF'`,
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `REAL_CLAUDE="${REAL_CLAUDE_LINK}"`,
    `TRANSCRIPT_PATH="${CONTAINER_TRANSCRIPT_PATH}"`,
    "args=()",
    "skip_next=false",
    'for a in "$@"; do',
    "  if $skip_next; then skip_next=false; continue; fi",
    '  if [ "$a" = "--output-format" ]; then skip_next=true; continue; fi',
    '  args+=("$a")',
    "done",
    'args+=("--output-format" "stream-json")',
    "set +e",
    '"$REAL_CLAUDE" "${args[@]}" | tee -a "$TRANSCRIPT_PATH" | tail -n 1',
    'wrapper_exit="${PIPESTATUS[0]}"',
    "set -e",
    'exit "$wrapper_exit"',
    "WRAPPER_EOF",
    `chmod +x ${WRAPPER_PATH}`,
    `export PATH="${WRAPPER_DIR}:$PATH"`,
    "",
    "echo 'styre-bench entrypoint: [3/6] git commit identity'",
    `git config --global user.email "${GIT_IDENTITY_EMAIL}"`,
    `git config --global user.name "${GIT_IDENTITY_NAME}"`,
    "",
    "echo 'styre-bench entrypoint: [4/6] pointing origin at the seeded throwaway repo'",
    `cd "${repoDirInImage}"`,
    `git remote set-url origin "${seed.repoUrl}" 2>/dev/null || git remote add origin "${seed.repoUrl}"`,
    `git checkout -B "${seed.defaultBranch}"`,
    "",
    "echo 'styre-bench entrypoint: [5/6] styre setup'",
    `"${CONTAINER_BINARY_PATH}" setup "${repoDirInImage}" --out "${CONTAINER_PROFILE_PATH}"`,
    "",
    "echo 'styre-bench entrypoint: [6/6] styre run'",
    "set +e",
    `"${CONTAINER_BINARY_PATH}" run "${seed.ident}" --profile "${CONTAINER_PROFILE_PATH}" | tee "${CONTAINER_NDJSON_PATH}"`,
    'run_exit="${PIPESTATUS[0]}"',
    "set -e",
    'exit "$run_exit"',
    "",
  ];
  return lines.join("\n");
}

export interface BuildDockerArgsInput {
  image: string;
  binaryPath: string;
  /** HOST directory mounted read-write to `CONTAINER_OUT_DIR` ("/out") — ndjson/transcript/
   *  profile all land under here on the host. */
  outDir: string;
  /** HOST path of the entrypoint script written by `runStyre` (see `buildEntrypoint`),
   *  mounted read-only. */
  entrypointHostPath: string;
  creds: RunStyreCreds;
}

/**
 * PURE. Builds the `docker run` argv (everything after the `docker` binary itself). Mounts
 * EXACTLY three paths — the styre binary (ro), the host output dir (rw), and the entrypoint
 * script (ro) — and three cred env vars. `image` is the only per-instance value threaded
 * through; nothing here ever touches `inst.test_patch`/`inst.fix_patch`/`.claude` (the input
 * type has no field for them — FIREWALL by construction, matching `buildEntrypoint`).
 */
export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  const { image, binaryPath, outDir, entrypointHostPath, creds } = input;
  return [
    "run",
    "--rm",
    "-v",
    `${binaryPath}:${CONTAINER_BINARY_PATH}:ro`,
    "-v",
    `${outDir}:${CONTAINER_OUT_DIR}`,
    "-v",
    `${entrypointHostPath}:${CONTAINER_ENTRYPOINT_PATH}:ro`,
    "-e",
    `ANTHROPIC_API_KEY=${creds.anthropicApiKey}`,
    "-e",
    `LINEAR_API_KEY=${creds.linearApiKey}`,
    "-e",
    `GITHUB_TOKEN=${creds.githubToken}`,
    "--entrypoint",
    "bash",
    image,
    CONTAINER_ENTRYPOINT_PATH,
  ];
}

export interface RunStyreResult {
  ndjsonPath: string;
  transcriptPath: string;
  profilePath: string;
  exitCode: number;
}

export interface RunStyreConfig {
  /** HOST directory the container's `/out` is mounted from. Default: a fresh temp dir per
   *  call (`os.tmpdir()/styre-bench-run-<instance-id>-<ts>`). */
  outDir?: string;
  repoDirInImage?: string;
  claudeCliVersion?: string;
  /** Overrides for creds; any field left unset falls back to the matching env var
   *  (`ANTHROPIC_API_KEY`/`LINEAR_API_KEY`/`GITHUB_TOKEN`). Missing after that => throws
   *  (mirrors seed-github.ts's/seed-linear.ts's fail-loud missing-cred pattern). */
  creds?: Partial<RunStyreCreds>;
}

/** Side-effecting steps, split out (same shape as build-styre.ts/seed-github.ts) so
 *  `runStyre`'s wiring (write entrypoint -> build docker args -> spawn) can be unit-tested
 *  with stubs — no real docker daemon, no real image pull. */
export interface RunStyreDeps {
  ensureOutDir: (outDir: string) => Promise<void>;
  writeEntrypoint: (hostPath: string, content: string) => Promise<void>;
  spawnDocker: (args: string[]) => Promise<number>;
}

const defaultDeps: RunStyreDeps = {
  async ensureOutDir(outDir) {
    await mkdir(outDir, { recursive: true });
  },
  async writeEntrypoint(hostPath, content) {
    await writeFile(hostPath, content, { mode: 0o755 });
  },
  async spawnDocker(args) {
    const proc = Bun.spawn(["docker", ...args], { stdout: "inherit", stderr: "inherit" });
    return proc.exited;
  },
};

export interface RunStyreOpts {
  deps?: Partial<RunStyreDeps>;
}

function resolveCreds(overrides: Partial<RunStyreCreds> | undefined): RunStyreCreds {
  const anthropicApiKey = overrides?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const linearApiKey = overrides?.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
  const githubToken = overrides?.githubToken ?? process.env.GITHUB_TOKEN ?? "";
  const missing = [
    anthropicApiKey ? null : "ANTHROPIC_API_KEY",
    linearApiKey ? null : "LINEAR_API_KEY",
    githubToken ? null : "GITHUB_TOKEN",
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    throw new Error(
      `runStyre: missing required creds (set env vars or pass cfg.creds): ${missing.join(", ")}`,
    );
  }
  return { anthropicApiKey, linearApiKey, githubToken };
}

/**
 * `docker run`s `inst.image`, wiring in the styre binary + creds + a generated entrypoint
 * script (`buildEntrypoint`) that installs `claude` + the transcript wrapper, sets git
 * identity + `origin`, then runs `styre setup` -> `styre run`. Returns HOST paths (under
 * `cfg.outDir`) for the three artifacts the container wrote under `/out`, plus the
 * container's exit code (styre run's own exit code — see `buildEntrypoint` step 6).
 *
 * FIREWALL: `inst.test_patch`/`inst.fix_patch` are never read here, and no `.claude` path is
 * ever mounted — `buildDockerArgs` mounts exactly the binary, `outDir`, and the entrypoint
 * script (see that function's doc).
 */
export async function runStyre(
  inst: Instance,
  seed: RunSeed,
  binaryPath: string,
  cfg: RunStyreConfig = {},
  opts: RunStyreOpts = {},
): Promise<RunStyreResult> {
  const deps: RunStyreDeps = { ...defaultDeps, ...opts.deps };

  const outDir = cfg.outDir ?? path.join(os.tmpdir(), `styre-bench-run-${inst.id}-${Date.now()}`);
  await deps.ensureOutDir(outDir);

  const creds = resolveCreds(cfg.creds);
  const entrypoint = buildEntrypoint({
    seed,
    repoDirInImage: cfg.repoDirInImage,
    claudeCliVersion: cfg.claudeCliVersion,
  });
  const entrypointHostPath = path.join(outDir, "entrypoint.sh");
  await deps.writeEntrypoint(entrypointHostPath, entrypoint);

  const args = buildDockerArgs({
    image: inst.image,
    binaryPath,
    outDir,
    entrypointHostPath,
    creds,
  });

  const exitCode = await deps.spawnDocker(args);

  return {
    ndjsonPath: path.join(outDir, "run.ndjson"),
    transcriptPath: path.join(outDir, "transcript.jsonl"),
    profilePath: path.join(outDir, "profile.json"),
    exitCode,
  };
}

// --- Behavioral web-off probe (deferred from Task 4, implemented + gated here) ---------------

/** The exact, real `<title>` of https://example.com — the positive-detection signal a
 *  web-reachable agent could plausibly transcribe into a diff. */
export const EXAMPLE_COM_TITLE = "Example Domain";

export const WEB_OFF_PROBE_STATEMENT =
  "Fetch https://example.com and report the exact text of the page's <title> element " +
  "in the PR description.";

const FETCH_TOOL_NAMES = ["WebFetch", "WebSearch"];

/**
 * PURE. Detects whether the agent actually reached the web, from two independent signals
 * (either is sufficient):
 * (a) the candidate diff contains the real page title (`EXAMPLE_COM_TITLE`) — the agent could
 *     only have known this by fetching the page;
 * (b) the transcript (the `claude` wrapper's teed stream-json, see `buildEntrypoint`) shows a
 *     `WebFetch`/`WebSearch` tool invocation referencing `example.com`. Checked two ways: a
 *     structured NDJSON scan (parses each line, greps the serialized tool-use event for the
 *     tool name + "example.com") and a raw-text regex fallback (covers a non-NDJSON transcript
 *     or a tool name/URL that end up on the same line without valid JSON framing).
 * A `WebFetch`/`WebSearch` call that does NOT reference `example.com` is NOT a hit (avoids a
 * false positive from, say, the agent fetching an unrelated doc URL during design).
 */
export function detectWebReachable(diff: string, transcript: string): boolean {
  if (diff.includes(EXAMPLE_COM_TITLE)) return true;

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const serialized = JSON.stringify(parsed);
      if (
        FETCH_TOOL_NAMES.some((name) => serialized.includes(`"name":"${name}"`)) &&
        serialized.includes("example.com")
      ) {
        return true;
      }
    } catch {
      // not a JSON line — fall through to the raw-text fallback below over the whole transcript
    }
  }

  const toolAlternation = FETCH_TOOL_NAMES.join("|");
  const forward = new RegExp(`(${toolAlternation})[^\\n]{0,200}example\\.com`, "i");
  const backward = new RegExp(`example\\.com[^\\n]{0,200}(${toolAlternation})`, "i");
  return forward.test(transcript) || backward.test(transcript);
}

export interface WebOffProbeConfig {
  benchGithubOrg: string;
  linearProjectId: string;
  /** A tiny, public, throwaway-safe upstream repo to seed the probe ticket against — content
   *  is irrelevant, only used as a checkout target. Default: octocat/Hello-World. */
  probeRepo?: string;
  probeBaseCommit?: string;
  /** A generic base image (not a SWE-bench instance image) the probe container runs in —
   *  needs only git + whatever `buildEntrypoint`'s claude-install step needs (curl or npm).
   *  Default: "node:20-bookworm". */
  probeImage?: string;
  runStyreConfig?: RunStyreConfig;
}

/** Side-effecting steps for `webOffProbe`, split out for the same DI-testability reason as
 *  `RunStyreDeps`. `readDiff` defaults to "" (empty): extracting the actual opened-PR diff
 *  needs GitHub PR API access that `orchestrator/collect.ts` (Task 7, not yet built as of this
 *  task) owns — see the doc on `webOffProbe` below for why relying on the transcript alone is
 *  still sufficient to prove web-off. Override `readDiff` once Task 7 lands. */
export interface WebOffProbeDeps {
  seedGithub: (inst: Instance, cfg: SeedGithubConfig) => Promise<SeedGithubResult>;
  seedLinear: (inst: Instance, cfg: SeedLinearConfig) => Promise<SeedLinearResult>;
  runStyre: (
    inst: Instance,
    seed: RunSeed,
    binaryPath: string,
    cfg: RunStyreConfig,
  ) => Promise<RunStyreResult>;
  readDiff: (result: RunStyreResult, seed: RunSeed) => Promise<string>;
  readTranscript: (transcriptPath: string) => Promise<string>;
}

const defaultWebOffProbeDeps: WebOffProbeDeps = {
  seedGithub,
  seedLinear,
  runStyre,
  // See the interface doc above: full diff extraction is deferred to Task 7's GitHub PR
  // read; the transcript is the primary/sufficient signal (any successful fetch requires a
  // WebFetch/WebSearch tool call, which the transcript always captures).
  async readDiff() {
    return "";
  },
  async readTranscript(transcriptPath) {
    return readFile(transcriptPath, "utf8").catch(() => "");
  },
};

export interface WebOffProbeOpts {
  deps?: Partial<WebOffProbeDeps>;
}

/**
 * Drives the BUILT styre binary (containerized, via `runStyre` — so it goes through the same
 * `claude` + transcript-wrapper wiring as a real bench task) against a throwaway ticket whose
 * statement asks it to fetch https://example.com and report the page's `<title>`. Returns
 * `{ webReachable: true }` if either signal in `detectWebReachable` fires. For a properly
 * web-off build (WebSearch/WebFetch stripped from styre's allowlist — `build-styre.ts`'s
 * `applyWebOffPatch`) this MUST be `false`; a `true` result means the web-off guarantee has a
 * hole (allowlist patch didn't take, or a belt-and-suspenders layer — container egress /
 * stripped `.claude/settings.json` — is the only thing actually stopping it).
 */
export async function webOffProbe(
  binaryPath: string,
  cfg: WebOffProbeConfig,
  opts: WebOffProbeOpts = {},
): Promise<{ webReachable: boolean }> {
  const deps: WebOffProbeDeps = { ...defaultWebOffProbeDeps, ...opts.deps };

  const inst: Instance = {
    id: `web-off-probe-${Date.now()}`,
    language: "ts",
    difficulty: "easy",
    repo: cfg.probeRepo ?? "octocat/Hello-World",
    base_commit: cfg.probeBaseCommit ?? "7fd1a60b01f91b314f59955a4e4d4e80d8edf11",
    problem_statement: WEB_OFF_PROBE_STATEMENT,
    image: cfg.probeImage ?? "node:20-bookworm",
    fail_to_pass: [],
    pass_to_pass: [],
    fix_patch: "",
    test_patch: "",
  };

  const seedGh = await deps.seedGithub(inst, { benchGithubOrg: cfg.benchGithubOrg });
  const seedLi = await deps.seedLinear(inst, { linearProjectId: cfg.linearProjectId });
  const seed: RunSeed = { ...seedGh, ident: seedLi.ident };

  const result = await deps.runStyre(inst, seed, binaryPath, cfg.runStyreConfig ?? {});
  const [diff, transcript] = await Promise.all([
    deps.readDiff(result, seed),
    deps.readTranscript(result.transcriptPath),
  ]);

  return { webReachable: detectWebReachable(diff, transcript) };
}
