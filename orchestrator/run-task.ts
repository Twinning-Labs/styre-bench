import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedGithub } from "./seed-github";
import type { SeedGithubConfig, SeedGithubResult } from "./seed-github";
import { seedLinear } from "./seed-linear";
import type { SeedLinearConfig, SeedLinearResult } from "./seed-linear";
import type { Cohort, Instance } from "./types";

/**
 * Pinned Claude Code CLI version installed inside the benchmark container (Step 1 of the
 * entrypoint). SWE-bench/Multi-SWE-bench images do NOT ship `claude` — styre shells out to
 * `claude -p` for every agent step, including the mandatory `styre setup` Opus call — so a
 * version must be pinned here before ANY live run. **KNOWN-BROKEN-UNTIL-LIVE** (no container
 * was actually run in this session): confirm this resolves via the native installer
 * (`curl -fsSL https://claude.ai/install.sh | bash -s <version>`) or `npm install -g
 * @anthropic-ai/claude-code@<version>` before the first RUN_LIVE=1 pass, and bump it here —
 * verify-at-Task-7-smoke. (Separately: the `-p`/`--print` + `--output-format stream-json`
 * requiring `--verbose` — see the wrapper in `buildEntrypoint` step 2 — IS confirmed against
 * Anthropic's CLI docs; only the exact behavior of *this pinned version* is unverified.)
 */
export const CLAUDE_CLI_VERSION = "2.0.1";

/** SWE-bench convention: the pre-built instance image has the repo already checked out here.
 *  **UNVERIFIED for Multi-SWE-bench** (the TS/JS/Go/Java/Rust corpus) in this session — its
 *  images may use a different path; confirm per-corpus before a live run and override via
 *  `RunStyreConfig.repoDirInImage` if it differs.
 *  **KNOWN-BROKEN-UNTIL-LIVE for `webOffProbe` specifically**: see that function's doc — a
 *  probe image with no repo checked out at this path makes `buildEntrypoint` step 4 die before
 *  styre ever runs, which is why `webOffProbe` now requires an explicit, repo-provisioned
 *  `probeImage` rather than defaulting to a vanilla image. */
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
/** Distinct container exit code the entrypoint uses when `styre setup` fails (produced no
 *  usable profile). Lets `collect` classify it as `probe` (a setup-coverage gap — styre
 *  couldn't produce a runnable profile for this repo) rather than `infra`, and — because
 *  `probe` is terminal — skip the pointless infra-retry (styre setup already retries its own
 *  agent enrichment internally, so a bench-level retry just re-runs the same deterministic
 *  failure). 70 = EX_SOFTWARE; styre itself uses 65/75 (resume/park) and 0/1, never 70. */
export const SETUP_FAILED_EXIT = 70;
const CONTAINER_ENTRYPOINT_PATH = "/entrypoint.sh";
const WRAPPER_DIR = "/opt/styre-bench/wrapper-bin";
const WRAPPER_PATH = `${WRAPPER_DIR}/claude`;
const REAL_CLAUDE_LINK = "/opt/styre-bench/real-claude";
// Extracts the terminal stream-json `result` event's `.result` (the assistant's final text,
// with REAL newlines) for the wrapper to print to stdout — see the wrapper doc in
// buildEntrypoint for why styre needs plain text, not a JSON envelope, on stdout.
const EXTRACT_SCRIPT_PATH = `${WRAPPER_DIR}/extract-result.py`;
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
  /** The PAT scoped to `benchGithubOrg` that seeded (created + pushed) the throwaway repo — the
   *  ONLY token that can push styre's fix branch back to it. Wired into the container so styre's
   *  `merge:push` can authenticate (`buildEntrypoint` configures a github.com credential helper
   *  that reads it from the env, never embedding it in origin). */
  benchGhToken: string;
  /** OPTIONAL Slack bot token for styre's outbound notifications. Empty string = off: the
   *  entrypoint only writes styre's Slack config when this is non-empty, and styre fail-louds if
   *  told `notifier:slack` without a token — so "unset" means silent, never a broken run. */
  slackBotToken: string;
}

export interface BuildEntrypointInput {
  seed: RunSeed;
  /** Path inside the instance image the corpus repo is already checked out at.
   *  Default `DEFAULT_REPO_DIR_IN_IMAGE` ("/testbed", SWE-bench convention — UNVERIFIED for
   *  Multi-SWE-bench, see that constant's doc). */
  repoDirInImage?: string;
  /** Overrides `CLAUDE_CLI_VERSION` (tests / a future re-pin without editing the constant). */
  claudeCliVersion?: string;
  /** Which build cohort this entrypoint is for. Default `"web-on"` (the permissive default —
   *  matches every pre-existing caller/test that predates this field and never mentions
   *  web-off). `"web-off"` makes the installed `claude` wrapper (step 2 below) append
   *  `--disallowedTools WebSearch WebFetch` to every `claude` invocation — the SECOND, wrapper-
   *  level web-off layer, independent of `build-styre.ts`'s `applyWebOffPatch` (which strips
   *  the tools from styre's own compiled-in allowlist, layer 1). See the step-2 doc below. */
  cohort?: Cohort;
  /** Slack channel styre posts notifications to — baked into the entrypoint's conditional config
   *  write (the token itself is checked at container runtime). Default `#harness`. Non-secret. */
  slackChannel?: string;
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
 *    `--output-format <fmt>` pair and any bare `--verbose` flag the caller passed, then forces
 *    `--output-format stream-json --verbose`. `--verbose` is REQUIRED alongside
 *    `--output-format stream-json` in `-p`/`--print` mode — Claude Code errors without it
 *    (confirmed against Anthropic's CLI docs; the exact behavior for the pinned
 *    `CLAUDE_CLI_VERSION` is still KNOWN-BROKEN-UNTIL-LIVE, verify-at-Task-7-smoke — see that
 *    constant's doc). `--verbose` is also what makes stream-json emit the intermediate
 *    `assistant`/`tool_use` lines the leak detector's WebFetch URL-scan (and the web-off
 *    probe's liveness gate, `hasAgentActivity`) depend on — without it only the terminal
 *    `result` event would stream. The wrapper tees the full NDJSON event stream to
 *    `CONTAINER_TRANSCRIPT_PATH` (append mode — the transcript accumulates across every
 *    `claude` call in the run), and pipes stdout through `extract-result.py`, which prints
 *    ONLY the terminal `result` event's `.result` field — the assistant's final text with
 *    REAL newlines. This is load-bearing: styre reads a fenced ```<fence>``` block off stdout
 *    via `extractSidecar` (src/dispatch/sidecar.ts), whose regex needs REAL newlines. A JSON
 *    envelope on stdout — whether `--output-format json` OR the stream-json `result` line —
 *    has the fence's newlines escaped as `\n` and NEVER matches (confirmed live against
 *    claude 2.1.199: `.result` = "```fence\n{...}\n```" only after JSON-decoding). The cost of
 *    this: `claude.ts`'s `parseClaudeJson` (usage/cost) sees plain text and returns nulls —
 *    it tolerates that by design (try/catch), so per-dispatch claude-side cost telemetry is
 *    lost (revisit: derive cost from the stream-json transcript instead). Exit code is passed
 *    through via `PIPESTATUS[0]` (the real claude), not the tee/python tail-of-pipe status.
 *
 *    WEB-OFF, LAYER 2: when `input.cohort === "web-off"`, the wrapper ALSO appends
 *    `--disallowedTools WebSearch WebFetch` to every `claude` invocation, after the forced
 *    `--output-format`/`--verbose` pair. This is a genuinely independent layer from
 *    `build-styre.ts`'s `applyWebOffPatch` (layer 1, which strips the `"WebSearch"`/
 *    `"WebFetch"` string literals from styre's COMPILED-IN tool allowlist before the binary
 *    is built): layer 1 denies the tools because styre itself never asks for them; layer 2
 *    denies them at the `claude` CLI's own flag, regardless of what styre's allowlist grants
 *    — so a styre allowlist regression (a refactor that re-adds the tools, or a bug that
 *    hands `--allowed-tools` a stale/unpatched list) is still blocked. `"web-on"` (the
 *    default) never appends this flag, leaving the wrapper's arg handling unchanged from
 *    before this layer existed.
 * 3. `git config --global user.email/user.name` — else styre's first implement commit dies in
 *    a bare image (no committer identity).
 * 4. Points the ALREADY-checked-out repo's `origin` at `seed.repoUrl` and resets the local
 *    branch to `seed.defaultBranch` — styre's github adapter derives owner/repo from `origin`
 *    and throws otherwise. Then drops a repo-scoped `.styre-disposable` marker (git-excluded
 *    locally so `git add -A` won't commit it) — the disposability signal `styre run --in-place`
 *    gates on.
 * 5. `styre setup <repoDirInImage> --out <profilePath> --trust-agent-commands` (see the flag's
 *    rationale at the call site) — deterministic path (setup otherwise
 *    writes under `$XDG_CONFIG_HOME/styre/<slug>/profile.json`, which `runStyre`'s caller has
 *    no fixed handle on).
 * 6. `styre run <seed.ident> --profile <profilePath> --in-place`, teeing NDJSON stdout to
 *    `CONTAINER_NDJSON_PATH`; the container's own exit code is styre run's exit code
 *    (`PIPESTATUS[0]`, not tee's). `--in-place` makes styre work on a branch IN the repo root
 *    (the pre-built editable env's target) instead of a separate worktree, so its conda-reuse
 *    probe fires; discovery finds the repo from cwd (step 4 `cd`d in).
 *
 * FIREWALL: this function's input type carries no `test_patch`/`fix_patch`/`.claude` data at
 * all — `RunSeed` is only `{ repoUrl, defaultBranch, ident }` — so there is no code path by
 * which held-out content could end up embedded in the generated script.
 */
export function buildEntrypoint(input: BuildEntrypointInput): string {
  const repoDirInImage = input.repoDirInImage ?? DEFAULT_REPO_DIR_IN_IMAGE;
  const claudeCliVersion = input.claudeCliVersion ?? CLAUDE_CLI_VERSION;
  const isWebOff = (input.cohort ?? "web-on") === "web-off";
  const { seed } = input;
  // Slack config the entrypoint writes (only when SLACK_BOT_TOKEN is present at runtime). JSON has
  // no single quotes, so it's safe to single-quote in the emitted `printf` below.
  const slackConfigJson = JSON.stringify({
    notifier: "slack",
    notify: "escalations",
    slack: { channel: input.slackChannel ?? "#harness" },
  });

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
    // The wrapper pipes claude's stdout through this python3 extractor (python3 is present in
    // both the swebench and mswebench eval images; jq/node are each missing from one). It must
    // exist before the wrapper runs; fail loudly if python3 is unavailable rather than silently
    // emitting empty stdout (which styre would see as a missing sidecar).
    "if ! command -v python3 >/dev/null 2>&1; then",
    "  echo 'FATAL: entrypoint: python3 is required to extract the claude result for styre stdout but is not present in this image' >&2",
    "  exit 1",
    "fi",
    `cat > ${EXTRACT_SCRIPT_PATH} <<'EXTRACT_EOF'`,
    "import json, sys",
    "",
    "# Read the full claude stream-json event stream (already tee'd to the transcript) and print",
    "# ONLY the terminal `result` event's `.result` field — the assistant's final text with REAL",
    "# newlines. styre's extractSidecar needs a real ```fence``` block; a JSON envelope (where the",
    "# fence's newlines are escaped as \\n) never matches. parseClaudeJson (cost, forensic-only)",
    "# sees plain text and returns nulls, which it tolerates by design.",
    "result = None",
    "for line in sys.stdin:",
    "    line = line.strip()",
    "    if not line:",
    "        continue",
    "    try:",
    "        obj = json.loads(line)",
    "    except Exception:",
    "        continue",
    '    if isinstance(obj, dict) and obj.get("type") == "result" and isinstance(obj.get("result"), str):',
    '        result = obj["result"]',
    'sys.stdout.write(result if result is not None else "")',
    "EXTRACT_EOF",
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
    '  if [ "$a" = "--verbose" ]; then continue; fi',
    '  args+=("$a")',
    "done",
    'args+=("--output-format" "stream-json" "--verbose")',
    ...(isWebOff ? ['args+=("--disallowedTools" "WebSearch" "WebFetch")'] : []),
    "set +e",
    // Tee the FULL stream-json event stream to the transcript (the leak-scan/liveness gate
    // parse it), but emit only the terminal event's `.result` — the plain assistant text with
    // real newlines — to stdout, so styre's extractSidecar can find its ```fence``` block. A
    // JSON envelope on stdout (json OR the stream-json result line) has the fence's newlines
    // escaped and never matches. PIPESTATUS[0] is still the real claude's exit.
    `"$REAL_CLAUDE" "\${args[@]}" | tee -a "$TRANSCRIPT_PATH" | python3 "${EXTRACT_SCRIPT_PATH}"`,
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
    // Give styre's `merge:push` an HTTPS credential for github.com so it can push the fix branch
    // back to the seeded throwaway repo. An inline credential helper echoes BENCH_GH_TOKEN (the
    // container env var, the org-scoped PAT that owns the repo) ONLY on a `get` — the token is
    // NEVER embedded in origin (styre derives owner/repo from origin) nor written to a file.
    // GIT_TERMINAL_PROMPT=0 makes an absent/bad credential fail fast instead of hanging on the
    // interactive username prompt (which is what the missing-credential failure showed headless).
    `git config --global credential.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$BENCH_GH_TOKEN"; }; f'`,
    "export GIT_TERMINAL_PROMPT=0",
    // styre run --in-place gate: it refuses unless a repo-scoped `.styre-disposable` marker
    // exists (defense-in-depth against mutating a checkout someone owns). This is a single-use
    // eval container, so the repo IS disposable. Exclude the marker LOCALLY first (a
    // non-committed `.git/info/exclude` entry) so styre's `git add -A` never commits it into the
    // fix diff — otherwise it'd surface as scope/firewall noise. `mkdir -p .git/info` guards a
    // non-standard git template (an absent info/ dir would make the `>>` fail under `set -e`,
    // aborting the run before styre ever starts).
    `mkdir -p "${repoDirInImage}/.git/info"`,
    `echo ".styre-disposable" >> "${repoDirInImage}/.git/info/exclude"`,
    `touch "${repoDirInImage}/.styre-disposable"`,
    "",
    // SWE-bench Python images pre-build the repo's deps into a conda env named `testbed` and
    // activate it via ~/.bashrc — which only runs in a LOGIN/interactive shell. This entrypoint
    // is a non-login script, so testbed is never activated and styre would run against the BASE
    // conda env, which lacks the repo's editable install (e.g. astropy is `pip install -e .`'d
    // only into testbed). styre's interpreter probe takes the first `python3` on PATH, so it
    // picks base python and the --in-place identity/reuse source-check fails ("not installed
    // against <repo>"). Activate testbed the way SWE-bench's own eval harness does, BEFORE setup
    // and run. `conda info --base` handles /opt/miniconda3 vs /opt/conda; the guards make this a
    // no-op for Multi-SWE-bench (node) images that ship no conda / no `testbed` env.
    "if command -v conda >/dev/null 2>&1; then",
    `  source "$(conda info --base)/etc/profile.d/conda.sh" 2>/dev/null || true`,
    "  conda activate testbed 2>/dev/null || true",
    "fi",
    "",
    // Slack notifications (styre's outbound notifier): enable ONLY when SLACK_BOT_TOKEN is present
    // in the container env. styre reads its global config from $HOME/.config/styre/config.json and
    // fail-louds if told notifier:slack WITHOUT a token — so writing this file only when the token
    // is set keeps tokenless runs silent-but-working (no config => styre defaults to notifier:none).
    // Quietest tier ("escalations") so parallel instances don't flood the channel; each message
    // already carries the ticket ident to tell instances apart.
    'if [ -n "${SLACK_BOT_TOKEN:-}" ]; then',
    '  mkdir -p "${HOME}/.config/styre"',
    `  printf '%s' '${slackConfigJson}' > "\${HOME}/.config/styre/config.json"`,
    "fi",
    "",
    "echo 'styre-bench entrypoint: [5/6] styre setup'",
    // Wrap styre setup so a failure exits with the distinct SETUP_FAILED_EXIT (not the generic
    // 1 that claude-install/infra failures also use, nor styre run's own exit) — collect maps
    // it to `probe` (setup-coverage gap), not `infra`. Without this, a setup crash writes no
    // profile.json and emits no run summary, so collect would misread it as an infra failure
    // and retry it (uselessly — styre setup is deterministic).
    "set +e",
    // --trust-agent-commands: the bench is inherently autonomous/headless — there is no
    // operator to approve agent-discovered build/test/check commands. Without this flag styre
    // drops every agent-proposed command ("headless — agent override not accepted"), leaving it
    // unable to ground-truth-verify most stacks, which cripples its self-correcting loop. This
    // does NOT affect the final oracle score (the oracle uses the gold FAIL_TO_PASS tests); it
    // only lets styre's own verify signal function so the loop measures styre's real autonomous
    // capability rather than a command-starved cripple.
    `"${CONTAINER_BINARY_PATH}" setup "${repoDirInImage}" --out "${CONTAINER_PROFILE_PATH}" --trust-agent-commands`,
    'setup_exit="$?"',
    "set -e",
    'if [ "$setup_exit" -ne 0 ]; then',
    `  echo "styre-bench entrypoint: styre setup failed (exit $setup_exit) — no usable profile; exiting ${SETUP_FAILED_EXIT} (probe)" >&2`,
    `  exit ${SETUP_FAILED_EXIT}`,
    "fi",
    "",
    "echo 'styre-bench entrypoint: [6/6] styre run'",
    "set +e",
    `"${CONTAINER_BINARY_PATH}" run "${seed.ident}" --profile "${CONTAINER_PROFILE_PATH}" --in-place | tee "${CONTAINER_NDJSON_PATH}"`,
    'run_exit="${PIPESTATUS[0]}"',
    "set -e",
    'exit "$run_exit"',
    "",
  ];
  return lines.join("\n");
}

export interface BuildDockerArgsInput {
  image: string;
  /** `docker run --platform` value (from `Instance.platform`). Defaults to `linux/amd64`
   *  when unset — the correct value for every Multi-SWE-bench image and for SWE-bench on an
   *  x86_64 host; an arm64 host's SWE-bench instances carry `linux/arm64` so their native
   *  arm64 images run without emulation. */
  platform?: string;
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
 * script (ro) — and five cred env vars (the fifth, SLACK_BOT_TOKEN, is optional/possibly-empty).
 * `image` is the only per-instance value threaded
 * through; nothing here ever touches `inst.test_patch`/`inst.fix_patch`/`.claude` (the input
 * type has no field for them — FIREWALL by construction, matching `buildEntrypoint`).
 */
export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  const { image, platform = "linux/amd64", binaryPath, outDir, entrypointHostPath, creds } = input;
  return [
    "run",
    "--rm",
    // Per-instance platform (set by corpus.ts's normalizers). SWE-bench on an arm64 host uses
    // linux/arm64 to run its native arm64 image; SWE-bench on x86_64 and every Multi-SWE-bench
    // image (amd64-only) use linux/amd64 — native on x86_64, emulated on arm64. The default
    // keeps legacy/fixture callers (no platform) on linux/amd64.
    "--platform",
    platform,
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
    "-e",
    `BENCH_GH_TOKEN=${creds.benchGhToken}`,
    // OPTIONAL: "" when unset — the entrypoint's `[ -n "$SLACK_BOT_TOKEN" ]` guard treats empty as
    // off, so styre never sees a Slack config and notifications stay silent.
    "-e",
    `SLACK_BOT_TOKEN=${creds.slackBotToken}`,
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
   *  call (`os.tmpdir()/styre-bench-run-<instance-id>-<ts>-<rand>`) — the trailing random
   *  suffix (Task-6 review fix) avoids a `Date.now()` collision under rapid re-invocation of
   *  the same instance id (e.g. retries within the same millisecond). */
  outDir?: string;
  repoDirInImage?: string;
  claudeCliVersion?: string;
  /** Overrides for creds; any field left unset falls back to the matching env var
   *  (`ANTHROPIC_API_KEY`/`LINEAR_API_KEY`/`GITHUB_TOKEN`). Missing after that => throws
   *  (mirrors seed-github.ts's/seed-linear.ts's fail-loud missing-cred pattern). */
  creds?: Partial<RunStyreCreds>;
  /** Forwarded to `buildEntrypoint` — see `BuildEntrypointInput.cohort`. Default `"web-on"`. */
  cohort?: Cohort;
  /** Slack channel for styre's notifications (falls back to `STYRE_SLACK_CHANNEL`, then
   *  `#harness`). Non-secret; the token itself is `SLACK_BOT_TOKEN` via creds. */
  slackChannel?: string;
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

/** Short random hex suffix for the default `outDir` (Task-6 review fix) — `Date.now()` alone
 *  can collide under rapid re-invocation of the same instance id. */
function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

function resolveCreds(overrides: Partial<RunStyreCreds> | undefined): RunStyreCreds {
  const anthropicApiKey = overrides?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const linearApiKey = overrides?.linearApiKey ?? process.env.LINEAR_API_KEY ?? "";
  const githubToken = overrides?.githubToken ?? process.env.GITHUB_TOKEN ?? "";
  const benchGhToken = overrides?.benchGhToken ?? process.env.BENCH_GH_TOKEN ?? "";
  // OPTIONAL (unlike the four above): unset => "" => Slack notifications simply stay off. NOT added
  // to the `missing` fail-loud list — a bench run must not require a Slack token.
  const slackBotToken = overrides?.slackBotToken ?? process.env.SLACK_BOT_TOKEN ?? "";
  const missing = [
    anthropicApiKey ? null : "ANTHROPIC_API_KEY",
    linearApiKey ? null : "LINEAR_API_KEY",
    githubToken ? null : "GITHUB_TOKEN",
    benchGhToken ? null : "BENCH_GH_TOKEN",
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    throw new Error(
      `runStyre: missing required creds (set env vars or pass cfg.creds): ${missing.join(", ")}`,
    );
  }
  return { anthropicApiKey, linearApiKey, githubToken, benchGhToken, slackBotToken };
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

  const outDir =
    cfg.outDir ??
    path.join(os.tmpdir(), `styre-bench-run-${inst.id}-${Date.now()}-${randomSuffix()}`);
  await deps.ensureOutDir(outDir);

  const creds = resolveCreds(cfg.creds);
  const entrypoint = buildEntrypoint({
    seed,
    repoDirInImage: cfg.repoDirInImage,
    claudeCliVersion: cfg.claudeCliVersion,
    cohort: cfg.cohort,
    slackChannel: cfg.slackChannel ?? process.env.STYRE_SLACK_CHANNEL,
  });
  const entrypointHostPath = path.join(outDir, "entrypoint.sh");
  await deps.writeEntrypoint(entrypointHostPath, entrypoint);

  const args = buildDockerArgs({
    image: inst.image,
    platform: inst.platform,
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

const ACTIVITY_MARKERS = ['"type":"assistant"', '"type":"tool_use"'];

/**
 * PURE. Liveness gate for the web-off probe (Task-6 review fix). A `webReachable: false` result
 * is only trustworthy if the agent actually ran; otherwise a crashed container, a dead
 * entrypoint, or a broken `claude` wrapper produces an empty/inert transcript that looks
 * identical to a correctly-blocked web-off build. Returns `true` iff the transcript shows
 * evidence of at least one real assistant turn or tool invocation — checked both structurally
 * (parses each NDJSON line, greps the serialized event for an `assistant`/`tool_use` `type`)
 * and, as a fallback, as raw text (covers a non-NDJSON or truncated transcript).
 */
export function hasAgentActivity(transcript: string): boolean {
  if (transcript.trim().length === 0) return false;

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const serialized = JSON.stringify(parsed);
      if (ACTIVITY_MARKERS.some((marker) => serialized.includes(marker))) {
        return true;
      }
    } catch {
      // not a JSON line — fall through to the raw-text fallback below
    }
  }

  return /"type"\s*:\s*"(assistant|tool_use)"/.test(transcript);
}

export interface WebOffProbeConfig {
  benchGithubOrg: string;
  linearProjectId: string;
  /** A tiny, public, throwaway-safe upstream repo to seed the probe ticket against — content
   *  is irrelevant, only used as a checkout target. Default: octocat/Hello-World. */
  probeRepo?: string;
  probeBaseCommit?: string;
  /**
   * A container image with a REAL git repo already checked out at
   * `runStyreConfig.repoDirInImage` (default `DEFAULT_REPO_DIR_IN_IMAGE`, "/testbed") — REQUIRED,
   * no default (Task-6 review fix). `buildEntrypoint`'s step 4 unconditionally `cd`s into
   * `repoDirInImage`; a repo-less image (e.g. a vanilla "node:20-bookworm") dies there before
   * styre ever runs, which previously made this probe silently report a false
   * `webReachable: false` for every call. `webOffProbe` throws if this is omitted.
   *
   * KNOWN-BROKEN-UNTIL-LIVE: no such image is wired here yet. Task 11 owns the real path —
   * either reuse `runStyre`'s throwaway-repo flow with a proper image, or provision a minimal
   * git repo at `repoDirInImage` inside the probe's own container. Until then, callers must
   * supply this explicitly (and keep it consistent with `runStyreConfig.repoDirInImage` if that
   * is also overridden away from the "/testbed" default).
   */
  probeImage: string;
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
  /** Returns `null` (Task-6 review fix), not `""`, when the transcript file is missing or
   *  unreadable — an infra failure (crashed container, missing wrapper, bad mount) the caller
   *  must treat as "cannot certify web-off", never as "no web access" / "no activity". Returns
   *  `""` only when the file exists and is genuinely empty. */
  readTranscript: (transcriptPath: string) => Promise<string | null>;
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
    // See the interface doc: missing/unreadable (any error, e.g. ENOENT) -> null, an infra
    // failure. A file that exists and is empty resolves normally with content "".
    try {
      return await readFile(transcriptPath, "utf8");
    } catch {
      return null;
    }
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
 *
 * BEHAVIORAL GUARANTEE, not vacuous (Task-6 review fix). A `webReachable: false` result is only
 * trustworthy if the run actually executed:
 * - Throws if `cfg.probeImage` is omitted — see that field's doc; there is no safe default
 *   image with a repo pre-checked-out at `repoDirInImage`.
 * - Throws if the transcript file is missing/unreadable (`readTranscript` returned `null`) —
 *   an infra failure, not a "no activity" signal.
 * - Before trusting a `false` detection, requires liveness: `result.exitCode === 0` AND
 *   `hasAgentActivity(transcript)`. If either fails, throws `"web-off probe did not execute —
 *   cannot certify web-off"` instead of silently returning `false`.
 *
 * POSITIVE CONTROL (not yet wired here — documented, not skipped): a `false` result alone
 * proves nothing without a paired positive-control run — the SAME probe, against a web-ON
 * build, MUST yield `webReachable: true`. Without that paired run you cannot distinguish "the
 * allowlist patch works" from "the probe itself is broken and always returns false". See the
 * `RUN_LIVE=1`-gated placeholder test in `tests/run-task.test.ts`; Task 11's live gated pass is
 * expected to run both and assert the contrast.
 */
export async function webOffProbe(
  binaryPath: string,
  cfg: WebOffProbeConfig,
  opts: WebOffProbeOpts = {},
): Promise<{ webReachable: boolean }> {
  if (!cfg.probeImage) {
    throw new Error(
      "webOffProbe: cfg.probeImage is required (KNOWN-BROKEN-UNTIL-LIVE, see that field's " +
        'doc) -- there is no safe default: a repo-less image (e.g. "node:20-bookworm") makes ' +
        "buildEntrypoint's step 4 `cd` into repoDirInImage and die before styre ever runs, " +
        "which used to surface as a silent, wrong `webReachable: false`. Pass an image with a " +
        'real repo checked out at cfg.runStyreConfig.repoDirInImage (default "/testbed").',
    );
  }

  const deps: WebOffProbeDeps = { ...defaultWebOffProbeDeps, ...opts.deps };

  const inst: Instance = {
    id: `web-off-probe-${Date.now()}`,
    language: "ts",
    difficulty: "easy",
    repo: cfg.probeRepo ?? "octocat/Hello-World",
    base_commit: cfg.probeBaseCommit ?? "7fd1a60b01f91b314f59955a4e4d4e80d8edf11",
    problem_statement: WEB_OFF_PROBE_STATEMENT,
    image: cfg.probeImage,
    fail_to_pass: [],
    pass_to_pass: [],
    fix_patch: "",
    test_patch: "",
  };

  const seedGh = await deps.seedGithub(inst, { benchGithubOrg: cfg.benchGithubOrg });
  const seedLi = await deps.seedLinear(inst, { linearProjectId: cfg.linearProjectId });
  const seed: RunSeed = { ...seedGh, ident: seedLi.ident };

  const result = await deps.runStyre(inst, seed, binaryPath, cfg.runStyreConfig ?? {});

  const transcript = await deps.readTranscript(result.transcriptPath);
  if (transcript === null) {
    throw new Error(
      "web-off probe: transcript file missing or unreadable -- infra failure (crashed " +
        "container, missing wrapper, bad mount), not a web-off signal; cannot certify web-off",
    );
  }

  const diff = await deps.readDiff(result, seed);
  const webReachable = detectWebReachable(diff, transcript);

  if (!webReachable && (result.exitCode !== 0 || !hasAgentActivity(transcript))) {
    throw new Error("web-off probe did not execute — cannot certify web-off");
  }

  return { webReachable };
}
