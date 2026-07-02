# Styre-Bench Pilot Rig — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint/typecheck/suite → commit. Suite green after each task.

**Goal:** stand up the end-to-end Phase-1 rig that drives styre (built from the `feat/polyglot-setup` branch, **web-off**) against ~6 Multi-SWE-bench/SWE-bench instances (TS + Python × Easy/Medium/Hard), scores each against the **held-out oracle**, runs the leak detector + blind reviews, and emits the §8a report — all behind the firewall.

**Architecture:** a bun/TS **orchestrator** owns control flow and drives styre as an opaque subprocess inside the instance's pinned Docker image; a Python **scorer** shells out to the real Multi-SWE-bench/SWE-bench eval harness (never reimplements the oracle); a **reviewer** does two blind agent passes; a **report** renderer produces markdown + JSON keyed by styre commit. Pure logic is TDD'd; external-integration glue (Docker/GitHub/Linear) is contract-tested against one real pilot instance.

**Tech Stack:** Bun + TypeScript (orchestrator/reviewer/report), Python 3.11 + the SWE-bench harness (scorer), Docker, `gh`/Octokit (GitHub), Linear SDK. `bun test` · `bun run lint` (biome) · `bun run typecheck` (tsc) · `pytest`.

**Design:** `docs/design/2026-07-02-styre-bench-strategy.md` (v3). Read §3/§3.1 (firewall + contamination), §6 (pipeline), §8/§8a (metrics + report mockup), §9a (taxonomy).

**Review status (v2):** independently reviewed (feasibility / adversarial / scope, all SHIP-WITH-FIXES) — styre-side claims verified accurate (CLI, telemetry field names, web-off patch target). Folded: two harness adapters (SWE-bench + Multi-SWE-bench, reuse-the-harness reset — Task 3); behavioral web-off probe + `--disallowedTools` + strip seeded `.claude/` (Tasks 4/5/6); `claude` CLI install + transcript wrapper + `--out` profile (Task 6); `probe` bucket + per-language `self_authored_test` + `self_test_passed` derivation (Task 7); leak-detector transcript source (Task 8); `gold-divergence` provisional (Task 10); per-corpus-family live gate + setup-cost note (Task 11); pinned Python corpus = SWE-bench Verified (config). Firewall confirmed closed by styre's capability isolation (no runtime network policy needed).

## Global Constraints

- **Firewall (design §3):** `test.patch` and `fix.patch` NEVER enter the ticket, the seeded repo, or the container styre runs in. Only the scorer/reviewer see them, post-hoc. Any task that seeds or runs styre must assert this.
- **Contamination (design §3.1):** the styre build used for the **headline** cohort has `WebSearch`/`WebFetch` removed from its agent allowlist; the patch is applied in the bench build only and is NEVER pushed to the styre repo.
- **Reuse the oracle — via TWO adapters:** SWE-bench (Python) and Multi-SWE-bench (TS) are DIFFERENT harnesses (different runners, report shapes, per-language log parsers). The scorer hands each candidate diff to the corpus-family harness **as a prediction and lets the harness do its own test-file reset + scoring** — do NOT reimplement `FAIL_TO_PASS`/`PASS_TO_PASS` and do NOT hand-roll a `git checkout` reset (that reintroduces the log-parser fragility + a weakened-`PASS_TO_PASS` hole). Both families must be exercised (one fixture each).
- **Web-off is a BEHAVIORAL guarantee, not a source grep:** a live agent must be *proven* unable to `WebFetch` (Task 4/11), because a seeded real repo can carry its own `.claude/settings.json` that re-enables tools. Pass `--disallowedTools` too, and strip `.claude/` from the seeded tree.
- **Per-corpus-family live gate:** before ANY Phase-2 number is trusted, ONE full-pipeline live run must pass **per corpus family** (≥1 Python + ≥1 TS) — a green unit suite (all external stages stubbed) is not sufficient, and the TS oracle path's first real execution must not be Phase 2.
- **Black-box styre:** the rig consumes styre's CLI (`styre setup <repo>`, `styre run <ticket> --profile <p>`) + its NDJSON stdout; it never imports or edits styre source (except the isolated web-off allowlist patch in Task 4).
- **No upstream contact:** throwaway repos under the bench org only; a dedicated throwaway Linear project; auto-cleanup.
- **Reproducibility:** every report records dataset version, sampling seed, **styre commit**, and cohort (web-off/on).
- **Pilot scope:** TS + Python × {Easy, Medium, Hard} = 6 instances. Ruby/PHP out (no corpus); multi-stack out (deferred).
- **Determinism where the exit code lies:** classify a run by `summary.outcome`, never the exit code (design §9a).

---

## File structure

```
package.json · tsconfig.json · biome.json · .env.example
config/bench.config.ts        # dataset pin, styre commit, cutoff date, budgets, concurrency, cohort
orchestrator/
  types.ts                    # Instance, TaskRecord, Cohort, Verdict
  matrix.ts                   # seeded stratified sampling + cutoff tagging
  build-styre.ts              # checkout pinned commit + web-off patch + bun build --compile
  seed-github.ts              # throwaway repo @ base_commit + origin (firewall)
  seed-linear.ts              # problem_statement -> ticket (firewall)
  run-task.ts                 # docker run + inject binary/creds/git-id/origin; setup+run; tee NDJSON
  collect.ts                  # parse summary (outcome), extract PR diff, strip docs/plans/
  pipeline.ts                 # per-task orchestration + infra-retry + budget/kill-switch
  cleanup.ts                  # tear down repo/ticket/branch/container
reviewer/
  blind-quality.ts            # role A
  ab-review.ts                # role B blind A/B (unlabeled, randomized)
report/
  render.ts                   # §8a markdown + JSON
scorer/                       # python
  controls.py                 # positive/negative oracle controls (flaky-drop + log-parser validation)
  score.py                    # test-file reset + FAIL_TO_PASS/PASS_TO_PASS -> resolved
  leak_detect.py              # diff-vs-fix similarity + transcript URL scan
  requirements.txt · conftest.py
tests/ (bun) · scorer/tests/ (pytest)
```

---

### Task 1: Scaffold + shared types + config

**Files:** Create `package.json`, `tsconfig.json`, `biome.json`, `.env.example`, `orchestrator/types.ts`, `config/bench.config.ts`, `scorer/requirements.txt`, `tests/smoke.test.ts`, `scorer/tests/test_smoke.py`.

**Interfaces — Produces:**
```ts
// orchestrator/types.ts
export type Cohort = "web-off" | "web-on";
export type Difficulty = "easy" | "medium" | "hard";
export interface Instance {
  id: string; language: "ts" | "python"; difficulty: Difficulty;
  repo: string; base_commit: string; problem_statement: string; hints?: string;
  image: string;                       // pinned Docker image ref
  fail_to_pass: string[]; pass_to_pass: string[];
  merge_date?: string;                 // ISO; for cutoff split
}
export interface TaskRecord {
  instance: string; language: string; difficulty: Difficulty;
  styre_commit: string; cohort: Cohort; post_cutoff: boolean | null;
  resolved: boolean; pr_opened: boolean;
  self_authored_test: boolean | null; self_test_passed: boolean | null;
  ticks: number; cycle_count: number; escalation_count: number; escalation_reasons: string[];
  outcome: string; status: string; exit_code: number; parked: boolean;
  cost_usd: number; tokens_in: number; tokens_out: number;
  blind_quality: string | null; ab_preference: "A(styre)" | "B(human)" | "tie" | null; ab_notes: string | null;
  suspected_leak: boolean; taxonomy: string;
}
```

- [ ] **Step 1: Write failing tests.** `tests/smoke.test.ts`: import `BENCH_CONFIG` from `config/bench.config.ts`, assert `BENCH_CONFIG.styreCommit` is a non-empty string and `BENCH_CONFIG.cohort === "web-off"` by default. `scorer/tests/test_smoke.py`: `assert 1 + 1 == 2` (proves pytest runs).
- [ ] **Step 2: Run — FAIL** (`bun test` — config missing).
- [ ] **Step 3: Implement.** `package.json` (bun, scripts: `test`/`lint`/`typecheck`, deps `zod`, `@linear/sdk`, `octokit`), `tsconfig.json` (strict), `biome.json`. `config/bench.config.ts`:
```ts
import { z } from "zod";
export const BenchConfig = z.object({
  styreRepo: z.string().default("https://github.com/Twinning-Labs/styre.git"),
  styreCommit: z.string().default("a2406a4"),           // feat/polyglot-setup HEAD (pin explicitly)
  cohort: z.enum(["web-off", "web-on"]).default("web-off"),
  pythonCorpus: z.enum(["swe-bench-verified", "swe-bench"]).default("swe-bench-verified"), // §11 pinned: Verified (human-validated)
  tsCorpus: z.literal("multi-swe-bench").default("multi-swe-bench"),
  modelCutoff: z.string().default("2025-01-01"),        // instances merged after -> post_cutoff
  seed: z.number().default(42),
  perTaskCostCapUsd: z.number().default(15),
  runBudgetUsd: z.number().default(150),
  concurrency: z.number().default(3),
  benchGithubOrg: z.string().default("styre-bench-scratch"),
  linearProjectId: z.string().default(""),              // dedicated throwaway project
});
export const BENCH_CONFIG = BenchConfig.parse({});
```
`.env.example` (ANTHROPIC_API_KEY, LINEAR_API_KEY, GITHUB_TOKEN, BENCH_GH_TOKEN). `scorer/requirements.txt` (`swebench`, `pytest`).
- [ ] **Step 4: Run — PASS** + `bun run lint` + `bun run typecheck` + `pytest scorer/tests -q`.
- [ ] **Step 5: Commit** — `chore: scaffold styre-bench (bun/ts + python scorer) + shared types + config`

---

### Task 2: `corpus.ts` (loader/normalizer) + `matrix.ts` (seeded sampling + cutoff)

**Files:** Create `orchestrator/corpus.ts`, `orchestrator/matrix.ts`, `tests/corpus.test.ts`, `tests/matrix.test.ts`, `tests/fixtures/swebench-raw.json`, `tests/fixtures/msb-raw.json`.

**Interfaces:**
- Consumes: `Instance`, `BENCH_CONFIG` (Task 1).
- Produces: `normalizeInstance(raw: unknown, family: "swe-bench" | "multi-swe-bench"): Instance` — maps each dataset's **raw** keys to the normalized `Instance` shape (**the crux-flagged gap: no task owned this**). SWE-bench(-Verified): `instance_id→id`, **`patch→fix_patch`** (the gold fix is named `patch`, NOT `fix_patch`), `test_patch→test_patch`, **UPPERCASE `FAIL_TO_PASS`/`PASS_TO_PASS`** (JSON-encoded string lists) `→ fail_to_pass/pass_to_pass`, `hints_text→hints`, `created_at→merge_date`, `image` derived by the SWE-bench convention `sweb.eval.x86_64.<instance_id>`, `language:"python"`. Multi-SWE-bench: already uses `fix_patch`/`test_patch`; map its `id`/`org+repo`/lists/image + `language` from its schema. `loadInstances(family, cfg): Instance[]` reads the pinned dataset (`pythonCorpus`/`tsCorpus`) and returns normalized instances (difficulty from the dataset label, or derived from patch size if absent).
- `selectPilot(pool: Instance[], seed: number): Instance[]` (one per language×difficulty for TS+Python → 6, deterministic); `tagCutoff(i: Instance, cutoffISO: string): boolean`.

- [ ] **Step 1: Write failing tests.** `corpus.test.ts` with the two raw fixtures (one real SWE-bench-Verified record shape + one real Multi-SWE-bench record shape): `normalizeInstance(sweRaw, "swe-bench")` maps `patch→fix_patch`, `FAIL_TO_PASS`(string)→`fail_to_pass`(string[]), `hints_text→hints`, `created_at→merge_date`, derives `image`; `normalizeInstance(msbRaw, "multi-swe-bench")` maps its shape → the SAME `Instance` fields (proving one normalized shape from two families). A missing/UPPERCASE key must NOT silently yield `fail_to_pass: []` — assert it's populated. `matrix.test.ts`: given a pool with ≥2 candidates per (lang×difficulty) cell, `selectPilot(pool, 42)` returns exactly 6, one per cell, deterministic per seed; empty cell → loud throw. `tagCutoff({merge_date:"2025-06-01"}, "2025-01-01")===true`; `"2024-06-01"→false`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `corpus.ts`: per-family key maps + `JSON.parse` for SWE-bench's stringified id-lists; throw loudly on a missing required key (never default to `[]`). `matrix.ts`: seeded PRNG (mulberry32), group by `${language}:${difficulty}`, pick per the 6 target cells; throw naming any empty cell.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(corpus+matrix): raw dataset normalizer (both families) + seeded pilot sampling`

---

### Task 3: `scorer` — two harness adapters + oracle controls (the ground truth)

Build the oracle FIRST and validate it before anything drives styre. **Reuse each corpus family's harness — do not reimplement scoring or the reset.** (Review: one `score()` for both families silently mis-scores TS; a hand-rolled `git checkout` reset both reimplements the eval loop AND misses a `PASS_TO_PASS` test living in a file `test.patch` never touches.)

**Files:** Create `scorer/adapters/base.py`, `scorer/adapters/swebench.py`, `scorer/adapters/multiswebench.py`, `scorer/controls.py`, `scorer/score.py`, `scorer/tests/test_swebench.py`, `scorer/tests/test_multiswebench.py`, `scorer/conftest.py`. Add **`swebench` AND the Multi-SWE-bench package** to `scorer/requirements.txt`.

**Interfaces (Python; invoked from TS via subprocess w/ JSON stdio):**
- `class OracleAdapter` (in `adapters/base.py`): `run_controls(instance) -> {"gold_resolved","base_fails","deterministic"}`; `score(instance, candidate_diff) -> {"resolved": bool, "fail_to_pass": {...}, "pass_to_pass": {...}}` — **hands `candidate_diff` to the family harness as the prediction; the harness applies `test.patch` and does its own test-file reset**; `run_self_test(instance, candidate_diff, added_test_paths) -> {"passed": bool|None}` — runs ONLY styre's newly-added test file(s) on `base + candidate_diff` (the rigorous producer for the §1 headline; returns `None` if no added test).
- `get_adapter(instance) -> OracleAdapter` in `score.py` dispatches on `instance.language` (`python`→`SweBenchAdapter`, else→`MultiSweBenchAdapter`). `run_controls`/`score`/`run_self_test` in `score.py` are thin dispatchers.

- [ ] **Step 1: Write failing tests.** **One fixture PER family** (≥1 pinned Python instance + ≥1 pinned TS instance — both log-parser paths must be exercised, else TS goes green untested). For each: `run_controls(inst)` → `gold_resolved and base_fails and deterministic`; `score(inst, inst["fix_patch"])` → `resolved is True`; `score(inst, "")` → `resolved is False`. `run_self_test` with a passing added test → `{"passed": True}`; no added test → `{"passed": None}`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `SweBenchAdapter` wraps the `swebench` harness; `MultiSweBenchAdapter` wraps the Multi-SWE-bench runner (its own image convention + report parse). Each parses its harness's report JSON for the id-list verdicts. No manual reset in `score` (the harness owns it). `run_self_test` builds a one-file test invocation from the family's runner (`pytest <path>` / `jest <path>`).
- [ ] **Step 4: PASS** (`pytest scorer/tests -q` — needs Docker + both fixture images).
- [ ] **Step 5: Commit** — `feat(scorer): swe-bench + multi-swe-bench oracle adapters (controls + score + self-test)`

---

### Task 4: `build-styre.ts` — web-off styre build

**Files:** Create `orchestrator/build-styre.ts`, `tests/build-styre.test.ts`.

**Interfaces:** `buildStyre(cfg): Promise<{ binaryPath: string; commit: string; webTools: "off" | "on" }>` — clones `styreRepo` at `styreCommit` into a cache dir; if `cohort === "web-off"`, applies a patch removing `"WebSearch"` and `"WebFetch"` from `src/dispatch/tool-allowlists.ts`; runs `scripts/build.sh` (bun `--compile` + macOS ad-hoc re-sign); returns the binary path. **The patch is applied to the local checkout only — never committed/pushed to styre.**

- [ ] **Step 1: Write failing tests.** `build-styre.test.ts`: after a web-off build, the patched `tool-allowlists.ts` contains neither `"WebSearch"` nor `"WebFetch"`; the returned `binaryPath` exists and `--version` runs; a `web-on` build leaves it unchanged. (Gate the heavy compile on `RUN_BUILD=1`; the patch-application assertion runs without it.) The **behavioral** web-off proof is a separate gated check (below + Task 11), not this source-grep.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `git clone --no-checkout` + `git checkout <commit>`; **`bun install --frozen-lockfile`** (else `bun build --compile` has no `node_modules` and fails); apply the allowlist edit with a precise string replace that **throws loudly if the anchor lines aren't found** (a styre refactor must not silently no-op the web-off guarantee); run `scripts/build.sh`.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5 (gated `RUN_BUILD=1`): behavioral web-off probe.** Run the built binary on a throwaway ticket whose statement is "fetch https://example.com and report its `<title>`"; assert the agent could NOT fetch (no title in the diff/transcript). Belt-and-suspenders: the container also passes `--disallowedTools WebSearch WebFetch` to `claude` and strips seeded `.claude/settings.json` (Task 5/6). A source-grep alone does NOT prove web-off.
- [ ] **Step 6: Commit** — `feat(build): build styre at pinned commit (bun install) with web-off allowlist patch + behavioral probe`

---

### Task 5: seeding — `seed-github.ts` + `seed-linear.ts` (+ firewall)

**Files:** Create `orchestrator/seed-github.ts`, `orchestrator/seed-linear.ts`, `tests/seed.test.ts`.

**Interfaces:**
- `seedGithub(inst, cfg): Promise<{ repoUrl: string; defaultBranch: string }>` — create a throwaway repo under `benchGithubOrg`, push `base_commit` as the default branch. **Assert no path from `test.patch`/`fix.patch` is present in the pushed tree.** **Strip any `.claude/` (esp. `.claude/settings.json`) from the snapshot before pushing** — a real repo's own Claude config could re-enable `WebFetch` and silently break the web-off cohort. The `GITHUB_TOKEN` used here must be a PAT scoped to `benchGithubOrg` only (blast-radius, not contamination).
- `seedLinear(inst, cfg): Promise<{ ident: string }>` — create an issue in `linearProjectId` from `problem_statement`(+`hints`) as What/Why/Scope/AC/Refs; label `Bug`. **The description contains ONLY issue text — never `test.patch`/`fix.patch` content.**

- [ ] **Step 1: Write failing tests.** `seed.test.ts` (mock Octokit + Linear SDK): `seedGithub` calls create-repo + push with the tree from `base_commit` and NO held-out test paths (assert the firewall by feeding an instance whose `test.patch` touches `tests/x_regression.py` and asserting that path is absent from the pushed set); `seedLinear` builds a description that does not contain any line from `inst.fix_patch`/`inst.test_patch` (assert with a sentinel string planted in those fields).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Use Octokit for repo create + a git push of the `base_commit` snapshot (shallow); Linear SDK for the issue. Centralize the firewall in one `assertNoHeldOut(text, inst)` used by both.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(seed): throwaway github repo + linear ticket with firewall assertions`

---

### Task 6: `run-task.ts` — containerized styre run

**Files:** Create `orchestrator/run-task.ts`, `tests/run-task.test.ts`.

**Interfaces:** `runStyre(inst, seed, binaryPath, cfg): Promise<{ ndjsonPath: string; transcriptPath: string; profilePath: string; exitCode: number }>` — `docker run` the instance `image`, entrypoint script does: (1) ensure the **`claude` CLI is installed + on PATH** (styre shells out to `claude -p` for every agent step incl. `styre setup` — SWE-bench images don't ship it; install a pinned version or bake a derived image layer); (2) install a **`claude` wrapper** first on PATH that `exec`s the real CLI with `--output-format stream-json` and tees the stream to `transcriptPath` (the leak-detector's URL-scan source — styre's NDJSON carries no tool-call transcript); (3) `git config --global user.email/user.name`; (4) set the repo's **`origin` → `seed.repoUrl`** on `defaultBranch`; (5) `styre setup <repo> --out <profilePath>` (deterministic path — setup otherwise writes to `$XDG_CONFIG_HOME/styre/<slug>/profile.json`); (6) `styre run <ident> --profile <profilePath>`; tee NDJSON to `ndjsonPath`.

- [ ] **Step 1: Write failing tests.** `run-task.test.ts`: unit-test the pure `buildDockerArgs(...)`/`buildEntrypoint(...)` — assert the entrypoint installs+PATHs `claude` (+ the tee wrapper), sets git identity + `origin`, passes `styre setup --out <path>` then `styre run --profile <path>`, mounts the binary + creds; and that `test.patch`/`fix.patch`/`.claude` are NOT mounted (firewall). (The live container run is Task 11's gated pass.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Split `buildDockerArgs`/`buildEntrypoint` (pure, tested) from `runStyre` (side-effecting).
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(run): containerized setup+run with claude CLI + transcript wrapper + git-identity/origin/--out`

---

### Task 7: `collect.ts` — parse summary + extract diff

**Files:** Create `orchestrator/collect.ts`, `tests/collect.test.ts`, `tests/fixtures/summary.ndjson`, `tests/fixtures/pr.diff`.

**Interfaces:** `collect(ndjson, prDiff, profile, ctx): Partial<TaskRecord>` — parse the last `summary` → `ticks/cycle_count/escalation_count/escalation_reasons/outcome/status/cost_usd/tokens_*/parked`; derive `taxonomy` **from `outcome`** (`parked` if exit 75; `loop-exhausted` if outcome∈{blocked,no-progress}; **`probe` if the setup `profile`'s test command is absent/`{unavailable}`** — an unrunnable detector, the §4-anticipated Python case; else pending downstream); strip `docs/plans/` hunks from `prDiff`; `self_authored_test` = a **test-file hunk** in the stripped diff matched by a **per-language** matcher (`isTestPath(path, lang)`: py `test_*.py`|`**/tests/**`, ts/js `*.{test,spec}.{ts,tsx,js}`|`**/__tests__/**`, go `*_test.go`, java `**/src/test/java/**`, rust `**/tests/**`|`#[cfg(test)]`-bearing); **`self_test_passed` = `self_authored_test && pr_opened`** (styre only opens a PR when its own verify — which runs the new test — is green; documented approximation, "passed under styre's own verify"; the rigorous per-test check is `scorer.run_self_test`, wired in the pipeline when present).

- [ ] **Step 1: Write failing tests.** `collect.test.ts`: `outcome:"pr-ready"` → fields populated, taxonomy pending; `outcome:"no-progress"` (exit 1) → `taxonomy:"loop-exhausted"`; a profile whose only component has `commands.test` `{unavailable}` → `taxonomy:"probe"`; a diff with `docs/plans/1.md`+`src/x.ts`+`tests/x_test.go` (lang go) → `docs/plans/` stripped, `self_authored_test===true`; same diff but lang python (no py test path) → `self_authored_test===false` (per-language matcher); `self_authored_test && pr_opened` → `self_test_passed===true`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Pure functions; last `type==="summary"`; the per-language `isTestPath` matcher.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(collect): summary parse + taxonomy(outcome/probe) + per-language self-test detection`

---

### Task 8: `leak_detect.py` — contamination detector

**Files:** Create `scorer/leak_detect.py`, `scorer/tests/test_leak_detect.py`.

**Interfaces:** `detect_leak(candidate_diff: str, fix_patch: str, transcript: str) -> dict` → `{"suspected": bool, "reasons": [...]}`. Flags: (a) normalized similarity(candidate, fix) ≥ threshold (default 0.9 on diff-hunk shingling); (b) any URL / `#<pr-number>` / `github.com/.../pull/` reference in `transcript`. **`transcript` is the `transcriptPath` teed by the run-task `claude` wrapper (Task 6)** — styre's NDJSON has no tool-call transcript, so without that wrapper the URL-scan has no data. If the wrapper is unavailable for a run, `detect_leak` records `reasons:["transcript-unavailable"]` and the report's validity panel must state the URL-scan didn't run (never imply a scan that didn't happen).

- [ ] **Step 1: Write failing tests.** planted-leak diff (≈ `fix_patch`) → `suspected True`, reason `high-similarity`; a transcript containing `https://github.com/org/repo/pull/123` → `suspected True`, reason `pr-url-in-transcript`; an independent diff + clean transcript → `suspected False`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Similarity via `difflib.SequenceMatcher` on sorted hunk lines; a URL/PR regex over the transcript.
- [ ] **Step 4: PASS** (`pytest scorer/tests -q`).
- [ ] **Step 5: Commit** — `feat(scorer): leak detector (diff similarity + transcript url scan)`

---

### Task 9: `reviewer` — blind quality + blind A/B

**Files:** Create `reviewer/blind-quality.ts`, `reviewer/ab-review.ts`, `tests/reviewer.test.ts`.

**Interfaces:**
- `blindQuality(issue, styreDiff): Promise<{ verdict: string; notes: string }>` — agent sees issue + styre's diff only.
- `abReview(issue, styreDiff, fixPatch, seed): Promise<{ preference: "A(styre)"|"B(human)"|"tie"; notes: string }>` — presents the two diffs as unlabeled **candidate A / candidate B**, order chosen by `seed` (so it's reproducible and label-neutral), `docs/plans/` stripped; maps the agent's A/B choice back to styre/human.

- [ ] **Step 1: Write failing tests.** Mock the model client. `abReview(..., seed=1)` puts styre as A, `seed=2` swaps to B (assert the prompt ordering flips with the seed and the returned `preference` maps back correctly regardless of position). `blindQuality` prompt contains the issue + styre diff and does NOT contain `fixPatch`. Assert neither prompt contains the string "accepted"/"human"/"gold" (label-neutrality).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Prompt assembly split from the model call (test the assembly deterministically). Use the Anthropic client; model = Opus for review.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(reviewer): blind-quality + blind A/B (label-neutral, seed-ordered)`

---

### Task 10: `report/render.ts` — §8a markdown + JSON

**Files:** Create `report/render.ts`, `tests/report.test.ts`.

**Interfaces:** `renderReport(records: TaskRecord[], meta): { markdown: string; json: TaskRecord[] }` — produces the §8a layout: headline table (resolve rate + self-report gap, split web-off/web-on/post-cutoff), the language×difficulty resolve grid, loop economics, judgment quality (review↔oracle agreement, A/B preference), the taxonomy histogram, the validity panel. **`gold-divergence` is rendered ONLY as `provisional (uncalibrated)`** until the A/B reviewer is calibrated against human labels (design §7 guard; calibration harness deferred) — never as a bare scalar. The validity panel states whether the URL-scan ran (Task 8).

- [ ] **Step 1: Write failing tests.** `report.test.ts` with a hand-built `records` array (mix of resolved/opened-but-unresolved/suspected-leak, web-off/on, pre/post-cutoff): assert the markdown contains the resolve-rate as `N/6`, the self-report gap % = opened-but-unresolved/total, a grid row per language, and a taxonomy line whose counts sum to `records.length`. Assert the JSON round-trips `records`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Pure aggregation + string templating matching the design §8a mockup shape.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(report): §8a markdown + json renderer`

---

### Task 11: `pipeline.ts` + `cleanup.ts` — end-to-end orchestration (capstone)

**Files:** Create `orchestrator/pipeline.ts`, `orchestrator/cleanup.ts`, `tests/pipeline.test.ts`, a `bin/run-pilot.ts` entrypoint.

**Interfaces:** `runInstance(inst, binaryPath, cfg): Promise<TaskRecord>` — wires the per-task pipeline (design §6): controls → (drop if flaky) → seed → run → collect → **(probe short-circuit: if `taxonomy==="probe"`, skip score/review)** → score → **`run_self_test`** (populates `self_test_passed` rigorously when an added test exists; else the `collect` approximation) → leak-detect → review → record; whole-instance **infra-retry** (capped, only on `taxonomy==="infra"`); enforces `perTaskCostCapUsd`. **Note:** the cap covers the `styre run` cost (`summary.cost_usd`); the mandatory `styre setup` Opus call emits no summary — budget it as a separate fixed per-instance estimate, don't claim the cap covers it. `runPilot(cfg)` — `selectPilot` → `buildStyre` → map `runInstance` at `concurrency` → `renderReport`; respects `runBudgetUsd` (kill-switch). `cleanup` always runs.

- [ ] **Step 1: Write failing tests.** `pipeline.test.ts` (all external stages stubbed): a stubbed instance that returns `taxonomy:"infra"` once then succeeds → retried once, final record non-infra; a flaky control (`deterministic:false`) → instance dropped with `taxonomy:"infra"`/`dropped-flaky`, styre never invoked; a run exceeding `runBudgetUsd` mid-way → kill-switch stops scheduling further instances; `cleanup` is called for every started instance even when one throws.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Compose the tested units; a small concurrency pool; try/finally cleanup; budget accounting from each record's `cost_usd`.
- [ ] **Step 4: PASS** + lint + typecheck + full `bun test` + `pytest`.
- [ ] **Step 5: Live gate (gated `RUN_LIVE=1`) — ONE full-pipeline run PER corpus family before Phase 2 is trusted.** Run ≥1 Python (SWE-bench Verified) AND ≥1 TS (Multi-SWE-bench) instance through controls→seed→run→score→self-test→leak-detect→review→report. For EACH: the oracle controls pass (`gold_resolved && base_fails && deterministic`), the **behavioral web-off probe passes** (Task 4 Step 5), the firewall held (no held-out paths / no `.claude/` in the seeded repo), and a report row rendered. A green *unit* suite is NOT this gate — the TS oracle path's first real run must not be Phase 2. Record the styre commit + both results.
- [ ] **Step 6: Commit** — `feat(pipeline): end-to-end pilot orchestration + retry + budget + cleanup`

---

## Self-review notes

- **Spec coverage:** firewall §3 → Tasks 5/6 assertions; contamination §3.1 → Task 4 (web-off patch) + Task 8 (leak-detect) + report splits (Task 10); oracle + controls + test-reset §6 → Task 3; taxonomy-on-outcome §9a → Task 7; blind A/B §7 → Task 9; report §8/§8a → Task 10; git-identity/origin/setup-Opus wiring §2 → Tasks 6/11. Web-on cohort = re-run with `cohort:"web-on"` (same rig, Task 4 branch) — no separate task.
- **Ordering rationale:** oracle (Task 3) before any styre drive (validate ground truth first); build-styre (4) + seeding (5) + run (6) are the drive path; collect/leak/review/report (7–10) are pure-ish and TDD-heavy; pipeline (11) composes tested units + the single live pass.
- **Type consistency:** `TaskRecord`/`Instance`/`Cohort` defined in Task 1, consumed throughout; `score`/`run_controls` (Task 3) and `detect_leak` (Task 8) are the Python contracts the TS pipeline calls via subprocess.
- **Integration honesty:** Docker/GitHub/Linear/model calls are stubbed in unit tests; the ONE real end-to-end validation is Task 11 Step 5 (gated), consistent with the design's "prove the rig on the pilot" purpose.
- **Deferred (not this plan):** Phase-2 breadth (more instances, same rig); the A/B reviewer human-label **calibration** harness (design §7 — publish gold-divergence only after κ is established); the web-on delta analysis writeup. These are follow-ons once the pilot rig is green.
