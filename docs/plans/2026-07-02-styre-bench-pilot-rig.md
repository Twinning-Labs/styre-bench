# Styre-Bench Pilot Rig — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint/typecheck/suite → commit. Suite green after each task.

**Goal:** stand up the end-to-end Phase-1 rig that drives styre (built from the `feat/polyglot-setup` branch, **web-off**) against ~6 Multi-SWE-bench/SWE-bench instances (TS + Python × Easy/Medium/Hard), scores each against the **held-out oracle**, runs the leak detector + blind reviews, and emits the §8a report — all behind the firewall.

**Architecture:** a bun/TS **orchestrator** owns control flow and drives styre as an opaque subprocess inside the instance's pinned Docker image; a Python **scorer** shells out to the real Multi-SWE-bench/SWE-bench eval harness (never reimplements the oracle); a **reviewer** does two blind agent passes; a **report** renderer produces markdown + JSON keyed by styre commit. Pure logic is TDD'd; external-integration glue (Docker/GitHub/Linear) is contract-tested against one real pilot instance.

**Tech Stack:** Bun + TypeScript (orchestrator/reviewer/report), Python 3.11 + the SWE-bench harness (scorer), Docker, `gh`/Octokit (GitHub), Linear SDK. `bun test` · `bun run lint` (biome) · `bun run typecheck` (tsc) · `pytest`.

**Design:** `docs/design/2026-07-02-styre-bench-strategy.md` (v3). Read §3/§3.1 (firewall + contamination), §6 (pipeline), §8/§8a (metrics + report mockup), §9a (taxonomy).

## Global Constraints

- **Firewall (design §3):** `test.patch` and `fix.patch` NEVER enter the ticket, the seeded repo, or the container styre runs in. Only the scorer/reviewer see them, post-hoc. Any task that seeds or runs styre must assert this.
- **Contamination (design §3.1):** the styre build used for the **headline** cohort has `WebSearch`/`WebFetch` removed from its agent allowlist; the patch is applied in the bench build only and is NEVER pushed to the styre repo.
- **Reuse the oracle:** the scorer invokes the SWE-bench/Multi-SWE-bench harness; do NOT reimplement `FAIL_TO_PASS`/`PASS_TO_PASS` scoring.
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

### Task 2: `matrix.ts` — seeded stratified sampling + cutoff tagging

**Files:** Create `orchestrator/matrix.ts`, `tests/matrix.test.ts`.

**Interfaces:**
- Consumes: `Instance`, `BENCH_CONFIG` (Task 1).
- Produces: `selectPilot(pool: Instance[], seed: number): Instance[]` (one per language×difficulty for TS+Python → 6, deterministic); `tagCutoff(i: Instance, cutoffISO: string): boolean` (true iff `merge_date` > cutoff; `null`-safe → tagged `post_cutoff:null` upstream when absent).

- [ ] **Step 1: Write failing tests.** `matrix.test.ts`: given a pool with ≥2 candidates in each of the 6 (lang×difficulty) cells, `selectPilot(pool, 42)` returns exactly 6 with one per cell; the SAME seed returns the SAME 6 (determinism); a DIFFERENT seed may differ. `tagCutoff({merge_date:"2025-06-01"}, "2025-01-01") === true`; `"2024-06-01" → false`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** A seeded PRNG (mulberry32 on `seed`), group `pool` by `${language}:${difficulty}`, pick the seed-th element per the 6 target cells (`ts|python` × `easy|medium|hard`); throw a clear error naming any empty cell (so a missing corpus cell is loud, not silently short).
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(matrix): seeded stratified pilot sampling + cutoff tagging`

---

### Task 3: `scorer` — oracle controls + scoring (the ground truth)

Build the oracle FIRST and validate it before anything drives styre. Reuse the SWE-bench harness; do not reimplement scoring.

**Files:** Create `scorer/controls.py`, `scorer/score.py`, `scorer/tests/test_score.py`, `scorer/conftest.py`.

**Interfaces (Python, invoked from TS via subprocess with JSON stdio):**
- `run_controls(instance: dict, n: int = 3) -> dict` → `{"gold_resolved": bool, "base_fails": bool, "deterministic": bool}`. Positive control: apply `fix.patch` on base → `FAIL_TO_PASS` must pass + `PASS_TO_PASS` green. Negative: base alone → `FAIL_TO_PASS` must fail. Run `n` times; `deterministic` iff identical each time. This validates the per-language log parser AND flags flaky instances.
- `score(instance: dict, candidate_diff: str) -> dict` → `{"resolved": bool, "fail_to_pass": {...}, "pass_to_pass": {...}}`. **Reset all test files to `(base + test.patch)` — discard any test-file hunks in `candidate_diff`** — then apply `test.patch`, run the id lists via the harness.

- [ ] **Step 1: Write failing tests.** `test_score.py` (uses one real, small pinned instance recorded as a fixture id): `run_controls(inst)` → `gold_resolved and base_fails and deterministic`. `score(inst, inst["fix.patch"])` → `resolved is True`; `score(inst, "")` (empty diff) → `resolved is False`. A `candidate_diff` that edits a `pass_to_pass` test file → the test-file reset discards it → `pass_to_pass` still scored against the pristine test (resolved reflects source, not the weakened test).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Shell out to the `swebench` harness (or Multi-SWE-bench's runner for TS) inside the instance image; parse its report JSON; implement the test-file reset via `git checkout -- <test paths from test.patch>` before applying `test.patch`. Keep image invocation behind one `_run_in_image(image, script)` helper.
- [ ] **Step 4: PASS** (`pytest scorer/tests -q` — needs Docker + the fixture image).
- [ ] **Step 5: Commit** — `feat(scorer): oracle controls + scoring with test-file reset`

---

### Task 4: `build-styre.ts` — web-off styre build

**Files:** Create `orchestrator/build-styre.ts`, `tests/build-styre.test.ts`.

**Interfaces:** `buildStyre(cfg): Promise<{ binaryPath: string; commit: string; webTools: "off" | "on" }>` — clones `styreRepo` at `styreCommit` into a cache dir; if `cohort === "web-off"`, applies a patch removing `"WebSearch"` and `"WebFetch"` from `src/dispatch/tool-allowlists.ts`; runs `scripts/build.sh` (bun `--compile` + macOS ad-hoc re-sign); returns the binary path. **The patch is applied to the local checkout only — never committed/pushed to styre.**

- [ ] **Step 1: Write failing tests.** `build-styre.test.ts`: after a web-off build, read the patched `tool-allowlists.ts` in the checkout and assert it contains neither `"WebSearch"` nor `"WebFetch"`; assert the returned `binaryPath` exists and `--version` runs; a `web-on` build leaves the allowlist unchanged. (Gate on a `RUN_BUILD=1` env so CI can skip the heavy build; the patch-application assertion runs without the full compile.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Checkout via `git clone --no-checkout` + `git checkout <commit>`; apply the allowlist edit with a precise string replace (fail loudly if the anchor lines aren't found — a styre refactor must not silently no-op the web-off guarantee); build.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(build): build styre at pinned commit with web-off allowlist patch`

---

### Task 5: seeding — `seed-github.ts` + `seed-linear.ts` (+ firewall)

**Files:** Create `orchestrator/seed-github.ts`, `orchestrator/seed-linear.ts`, `tests/seed.test.ts`.

**Interfaces:**
- `seedGithub(inst, cfg): Promise<{ repoUrl: string; defaultBranch: string }>` — create a throwaway repo under `benchGithubOrg`, push `base_commit` as the default branch. **Assert no path from `test.patch`/`fix.patch` is present in the pushed tree.**
- `seedLinear(inst, cfg): Promise<{ ident: string }>` — create an issue in `linearProjectId` from `problem_statement`(+`hints`) as What/Why/Scope/AC/Refs; label `Bug`. **The description contains ONLY issue text — never `test.patch`/`fix.patch` content.**

- [ ] **Step 1: Write failing tests.** `seed.test.ts` (mock Octokit + Linear SDK): `seedGithub` calls create-repo + push with the tree from `base_commit` and NO held-out test paths (assert the firewall by feeding an instance whose `test.patch` touches `tests/x_regression.py` and asserting that path is absent from the pushed set); `seedLinear` builds a description that does not contain any line from `inst.fix_patch`/`inst.test_patch` (assert with a sentinel string planted in those fields).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Use Octokit for repo create + a git push of the `base_commit` snapshot (shallow); Linear SDK for the issue. Centralize the firewall in one `assertNoHeldOut(text, inst)` used by both.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(seed): throwaway github repo + linear ticket with firewall assertions`

---

### Task 6: `run-task.ts` — containerized styre run

**Files:** Create `orchestrator/run-task.ts`, `tests/run-task.test.ts`.

**Interfaces:** `runStyre(inst, seed: {repoUrl,ident,defaultBranch}, binaryPath, cfg): Promise<{ ndjsonPath: string; exitCode: number }>` — `docker run` the instance `image` with: the styre binary mounted, creds as env (`ANTHROPIC/LINEAR/GITHUB`), **`git config --global user.email/user.name` set**, the checked-out repo's **`origin` set to `seed.repoUrl`** on `defaultBranch`; run `styre setup <repo>` then `styre run <ident> --profile <p>`; tee NDJSON to `ndjsonPath`.

- [ ] **Step 1: Write failing tests.** `run-task.test.ts`: unit-test the **docker command assembly** (a pure `buildDockerArgs(...)` helper) — asserts the args include the git-identity env, the `origin` setup, the binary mount, and the creds env; and that `test.patch`/`fix.patch` are NOT mounted (firewall). (The live container run is exercised in Task 11's integration pass, gated on `RUN_LIVE=1`.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Split `buildDockerArgs` (pure, tested) from `runStyre` (side-effecting). Inside the container entrypoint script: set git identity, set `origin`, `styre setup`, `styre run`, tee stdout.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(run): containerized styre setup+run with git-identity/origin injection`

---

### Task 7: `collect.ts` — parse summary + extract diff

**Files:** Create `orchestrator/collect.ts`, `tests/collect.test.ts`, `tests/fixtures/summary.ndjson`, `tests/fixtures/pr.diff`.

**Interfaces:** `collect(ndjson: string, prDiff: string, ctx): Partial<TaskRecord>` — parse the last `summary` event → `ticks/cycle_count/escalation_count/escalation_reasons/outcome/status/cost_usd/tokens_*/parked`; derive `taxonomy` (design §9a) **from `outcome`** (`parked` if exit 75; `loop-exhausted` if outcome∈{blocked,no-progress}; else pending downstream); strip `docs/plans/` hunks from `prDiff`; detect `self_authored_test` (a test-file hunk present in the stripped diff).

- [ ] **Step 1: Write failing tests.** `collect.test.ts` with the fixtures: a summary with `outcome:"pr-ready"` → record fields populated, `taxonomy` not yet terminal; a summary with `outcome:"no-progress"` → `taxonomy:"loop-exhausted"` even if exit_code is 1; a PR diff containing `docs/plans/1.md` + `src/x.ts` + `tests/x.test.ts` → stripped diff excludes `docs/plans/`, `self_authored_test===true`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Pure functions; JSON-parse each NDJSON line, take the last `type==="summary"`.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(collect): summary parse + taxonomy(outcome) + docs/plans strip`

---

### Task 8: `leak_detect.py` — contamination detector

**Files:** Create `scorer/leak_detect.py`, `scorer/tests/test_leak_detect.py`.

**Interfaces:** `detect_leak(candidate_diff: str, fix_patch: str, transcript: str) -> dict` → `{"suspected": bool, "reasons": [...]}`. Flags: (a) normalized similarity(candidate, fix) ≥ threshold (default 0.9 on a diff-hunk shingling); (b) any URL / `#<pr-number>` / `github.com/.../pull/` reference in `transcript`.

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

**Interfaces:** `renderReport(records: TaskRecord[], meta): { markdown: string; json: TaskRecord[] }` — produces the §8a layout: headline table (resolve rate + self-report gap, split web-off/web-on/post-cutoff), the language×difficulty resolve grid, loop economics, judgment quality (review↔oracle agreement, A/B preference, gold-divergence), the taxonomy histogram, the validity panel.

- [ ] **Step 1: Write failing tests.** `report.test.ts` with a hand-built `records` array (mix of resolved/opened-but-unresolved/suspected-leak, web-off/on, pre/post-cutoff): assert the markdown contains the resolve-rate as `N/6`, the self-report gap % = opened-but-unresolved/total, a grid row per language, and a taxonomy line whose counts sum to `records.length`. Assert the JSON round-trips `records`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Pure aggregation + string templating matching the design §8a mockup shape.
- [ ] **Step 4: PASS** + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(report): §8a markdown + json renderer`

---

### Task 11: `pipeline.ts` + `cleanup.ts` — end-to-end orchestration (capstone)

**Files:** Create `orchestrator/pipeline.ts`, `orchestrator/cleanup.ts`, `tests/pipeline.test.ts`, a `bin/run-pilot.ts` entrypoint.

**Interfaces:** `runInstance(inst, binaryPath, cfg): Promise<TaskRecord>` — wires the per-task pipeline (design §6): controls → (drop if flaky) → seed → run → collect → score → leak-detect → review → record; whole-instance **infra-retry** (capped, only on `taxonomy==="infra"`); enforces `perTaskCostCapUsd`. `runPilot(cfg)` — `selectPilot` → `buildStyre` → map `runInstance` at `concurrency` → `renderReport` → write to `report/out/`; respects `runBudgetUsd` (kill-switch). `cleanup(handles)` always runs (retain-on-failure configurable).

- [ ] **Step 1: Write failing tests.** `pipeline.test.ts` (all external stages stubbed): a stubbed instance that returns `taxonomy:"infra"` once then succeeds → retried once, final record non-infra; a flaky control (`deterministic:false`) → instance dropped with `taxonomy:"infra"`/`dropped-flaky`, styre never invoked; a run exceeding `runBudgetUsd` mid-way → kill-switch stops scheduling further instances; `cleanup` is called for every started instance even when one throws.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Compose the tested units; a small concurrency pool; try/finally cleanup; budget accounting from each record's `cost_usd`.
- [ ] **Step 4: PASS** + lint + typecheck + full `bun test` + `pytest`.
- [ ] **Step 5: Live pilot (gated `RUN_LIVE=1`, manual):** run `bin/run-pilot.ts` on the 6 pinned instances; confirm a report is produced, the firewall held (no held-out paths in any seeded repo), and web-off was used. Record the styre commit + results.
- [ ] **Step 6: Commit** — `feat(pipeline): end-to-end pilot orchestration + retry + budget + cleanup`

---

## Self-review notes

- **Spec coverage:** firewall §3 → Tasks 5/6 assertions; contamination §3.1 → Task 4 (web-off patch) + Task 8 (leak-detect) + report splits (Task 10); oracle + controls + test-reset §6 → Task 3; taxonomy-on-outcome §9a → Task 7; blind A/B §7 → Task 9; report §8/§8a → Task 10; git-identity/origin/setup-Opus wiring §2 → Tasks 6/11. Web-on cohort = re-run with `cohort:"web-on"` (same rig, Task 4 branch) — no separate task.
- **Ordering rationale:** oracle (Task 3) before any styre drive (validate ground truth first); build-styre (4) + seeding (5) + run (6) are the drive path; collect/leak/review/report (7–10) are pure-ish and TDD-heavy; pipeline (11) composes tested units + the single live pass.
- **Type consistency:** `TaskRecord`/`Instance`/`Cohort` defined in Task 1, consumed throughout; `score`/`run_controls` (Task 3) and `detect_leak` (Task 8) are the Python contracts the TS pipeline calls via subprocess.
- **Integration honesty:** Docker/GitHub/Linear/model calls are stubbed in unit tests; the ONE real end-to-end validation is Task 11 Step 5 (gated), consistent with the design's "prove the rig on the pilot" purpose.
- **Deferred (not this plan):** Phase-2 breadth (more instances, same rig); the A/B reviewer human-label **calibration** harness (design §7 — publish gold-divergence only after κ is established); the web-on delta analysis writeup. These are follow-ons once the pilot rig is green.
