# Styre-Bench — end-to-end testing strategy for the harness (v3)

**Status:** Design — independently reviewed (feasibility / adversarial / scope-coherence, all SHIP-WITH-FIXES), revised to v3; pending operator approval → implementation plan.
**Date:** 2026-07-02
**Repo:** `Twinning-Labs/styre-bench` (public). Drives styre as a subprocess.
**Supersedes:** the orphaned `2026-06-28-styre-bench-testing-strategy-design.md` (pre-polyglot).

**v3 changelog (review fixes):** added **§3.1 oracle-contamination** (the blocking finding — the agent's own web tools can fetch the real merged fix); per-instance **oracle controls** + **test-file reset** (§6); **flake→infra** taxonomy + retry keyed on `summary.outcome` (§9a); **blind A/B** gold comparison (§7); container **git-identity + origin + setup-is-an-Opus-call** wiring (§2/§6); sharper **self-report-gap** framing (§1); Python corpus contradiction resolved (§11).

---

## 1. Goal & non-goals

**Goal.** Stress the styre harness across **language breadth** and a **difficulty gradient**, driving styre end-to-end (`setup → run → PR`) against a corpus with a **held-out mechanical oracle**, and localize *where and how* the loop degrades. Per the deferred open-core-boundary decision (`styre-cloud` `docs/design/2026-07-02-open-core-boundary-decision.md`, which explicitly defers the monetization axis to post-bench), this run also generates **"does the loop reliably close tickets, and where does it break"** data to inform that axis.

**Primary signals.**
- Did styre actually fix the issue? — **ground-truth pass/fail** (held-out oracle), never self-report.
- **Self-report gap (sharpened):** styre's A1 gate *forces* the implement agent to author its own test for a behavioral unit (`handlers.ts:523-546`), but that self-written test may be weak/tautological and the bug's real regression test is held out — so a PR can open "green by styre's own tests" yet the held-out oracle says unfixed. The gap between styre's self-judged pr-ready and the oracle's resolved is the headline. **Metric:** oracle-pass rate *conditioned on* styre's self-authored test existing/passing (quantifies what styre's own tests are worth).
- Loop economics — ticks/loopbacks/escalations/cost, resolved vs not. (Note: the A1 forced-test-authoring inflates `ticks`/`cycle_count` for bug-fix units — interpret accordingly.)
- Where the loop breaks by **language × difficulty**.
- **Solution quality vs the accepted human fix** — a blind A/B review agent (§7).

**Non-goals.** Not a leaderboard submission. **Not multi-stack/monorepo yet** — breadth-first single-stack (SWE-bench-family is single-repo/single-language; multi-stack has no ready oracle corpus — deferred, §10, not dropped). Never touches real upstream repos (§9). Not testing the commercial plane.

## 2. Grounding facts (verified against the current branch code)

- **Build styre from the `feat/polyglot-setup` branch commit, not the released binary** (v0.2.0 is Node/Rust-only; polyglot is unmerged per the open-core decision). `bun build --compile` with the macOS ad-hoc re-sign step (`scripts/build.sh`). CLI is exactly `styre setup <repo>` + `styre run <ticket> --profile <p>` (`src/index.ts`). Record the styre commit in every report.
- **`styre setup` is a MANDATORY Opus agent call per instance** (not a free probe): `runSetup` → `enrichRuntimeContext` (throws on failure) + agent `discoverComponents`, needs `ANTHROPIC_API_KEY` (`src/cli/setup.ts`). Budget + availability must include one Opus setup call per instance. Headless (no TTY) skips the approval prompt; without `--trust-agent-commands` (default off) verify runs only the deterministic detected commands (good for reproducibility).
- **Linear ingest + always-PR, no dry-run** (`src/daemon/run-ticket.ts`, `src/integrations/adapters/{linear,github}.ts`, projector enqueues `pr_create` unconditionally). Needs a dedicated throwaway Linear project + throwaway GitHub repos.
- **Verify runs the profile's commands on the worktree, no built-in sandbox**; isolation comes from the per-instance Docker image. Verify env **scrubs** `ANTHROPIC/LINEAR/GITHUB` tokens (`agent-env.ts`) — so test commands can't call those APIs.
- **Telemetry = NDJSON on stdout**; terminal `summary` carries `ticks`/`cycle_count`/`escalation_count`+reasons/`dispatch_*`/`cost_usd`/`tokens_*`/`stage`/`outcome`/`status`. Exit codes: `0` pr-ready · `75` parked · `65` resume-refused · `1` error/blocked. **`blocked`/`no-progress` also exit 1 but emit the `summary` (with `outcome`) first** → the taxonomy must key on `summary.outcome`, not the exit code (§9a).
- **Container wiring the bench MUST inject** (feasibility finds these missing today): (1) **git commit identity** (`git config --global user.email/user.name`) — else styre's first implement commit dies in a bare image (`worktree.ts` `git commit`); (2) the in-container repo's **`origin` → the throwaway GitHub repo** on its default branch (the GitHub adapter derives owner/repo from `origin` and throws otherwise); (3) creds; (4) a bun/node runtime + network egress for the agent API.
- **styre's PR diff always contains a `docs/plans/<n>.md`** design doc (a `design:dispatch` postcondition). Harmless to the scorer; **strip `docs/plans/` before the gold comparison** (§7) so it doesn't read as scope creep.

## 3. The firewall — what the bench must not place

Every instance carries the landed solution; validity depends on styre never seeing it.
- styre + the bench driver see **only** the `problem_statement` (→ ticket) + the repo at `base_commit`.
- **`test.patch` (oracle) and `fix.patch` (accepted fix) are NEVER** in the ticket, the seeded repo, or the container. They're applied/read only post-hoc by the scorer/reviewer. Seed `base_commit` **without** the held-out tests (how SWE-bench/Multi-SWE-bench store the eval patch — verify per-instance). With the regression test absent, styre's verify runs only base tests → can go green unfixed → the self-report gap (§1).

### 3.1 Oracle contamination — the agent can retrieve the answer (BLOCKING)

**The §3 firewall governs only what the bench *places*; it does not govern what styre's *agent pulls in* — and the code shows the agent can pull in the fix.** `design:dispatch` runs with `WebSearch` + `WebFetch` in its allowlist (`src/dispatch/tool-allowlists.ts:10`), passed verbatim to `claude -p --allowedTools` (`run-dispatch.ts` → `claude.ts`) with the API channel live. Since the corpus is **real merged issues from real public repos** and `problem_statement` is the verbatim issue text, the design agent can web-search the issue, land on the actual merged PR, and read `fix.patch` **and** the held-out regression test — then reproduce them. The oracle passes; the resolve-rate is fiction; and role-B gold-comparison would be measuring plagiarism.

Two channels, two floors:
- **Active retrieval** — `WebSearch` is *server-side* (Anthropic runs it; a container egress block does **not** stop it) so it must be closed by **removing the tool from the allowlist**; `WebFetch` also dropped (+ egress rules as defense-in-depth).
- **Memorization floor** — popular public repos' issues/PRs are likely in the model's pretraining set, so even with all web tools off and the network sealed, the fix may be *in the weights*. A public-real-repo corpus is **never** airtight by construction.

**Mitigations (all required):**
1. **Bench-only allowlist override** dropping `WebSearch`/`WebFetch` from `design:dispatch` (and any agent step) — a bench config layer, **never shipped into the released binary**. The **headline resolve-rate is the web-off number.** Explicitly: this benches a slightly capability-reduced styre.
2. **Web-on cohort** run separately; report the web-on − web-off **delta** as its own experiment (never folded into the headline).
3. **Leakage detector** (runs regardless of web state): (a) similarity of styre's diff to `fix.patch` above a threshold → flag; (b) scan the dispatch transcript for fetched URLs / PR references. Emit a `suspected-leak` bucket.
4. **Bound the memorization floor:** prefer instances merged **after the model's training cutoff** (SWE-bench "recent"/Verified splits carry merge dates); report resolve-rate **split by pre/post-cutoff** so the memorization component is visible.

## 4. Corpus — single-stack, breadth-first

**Languages = styre-supported ∩ oracle-corpus-available:** **JS, TS, Go, Java (JVM), Rust** (Multi-SWE-bench) + **Python** (SWE-bench / SWE-bench Verified). **Excluded:** Ruby, PHP (styre supports them but no ready held-out-oracle corpus — **known coverage gap**, revisit if one appears); C/C++ (unsupported).

Each instance provides `repo`, `base_commit`, `problem_statement`, `hints`, `test.patch` (oracle), `fix.patch` (accepted fix — scoring/review only), `FAIL_TO_PASS`, `PASS_TO_PASS`, a pinned Docker image, and (preferred) a merge date for the §3.1 cutoff split.

**Sampling — stratified by language × difficulty, seeded/deterministic, recorded.**
- **Phase 1 — rig-proving pilot (~6):** **TS + Python × {Easy, Medium, Hard}**. TS exercises the Node detector via **Multi-SWE-bench**; Python exercises a new M-B detector via a **second corpus family (SWE-bench)** — proving both corpus paths + both detectors cheaply.
- **Phase 2 — full breadth matrix:** all 6 languages × 3 difficulties + depth per cell.

**Language-admission gate (strengthened pre-flight — the acceptance test for a cell):** before any styre verdict in a language cell is trusted, (a) `styre setup` must yield a **runnable** test command on sample instances (else it's a recorded `probe` finding, not a silent drop), **and** (b) the **oracle positive/negative controls (§6) must pass** on gold for that language — this is what validates the per-language **log parser** (pytest vs `go test` vs JUnit/Maven vs `cargo test` vs jest; the non-pytest parsers are far less battle-tested and a mis-parse yields a wrong `resolved`).

**Python-cell caveat:** styre's Python detector is root-only and pytest-biased (`src/setup/lang/python.ts`); custom-runner repos (e.g. Django's `runtests.py`) get a wrong command → spurious loopbacks concentrated in the Python cell. This does **not** invalidate the oracle (the SWE-bench harness scores independently) — but read Phase-1 Python numbers as **detector-coverage** data, not loop performance.

## 5. Architecture (`styre-bench`)

```
orchestrator/   # bun/TS
  matrix.ts        # seeded sampling + stratification + pre/post-cutoff tagging
  build-styre.ts   # build styre at the pinned branch commit; apply the web-off allowlist override
  seed-github.ts   # throwaway repo @ base_commit; set origin
  seed-linear.ts   # problem_statement -> ticket (dedicated project); NEVER test/fix.patch
  run-task.ts      # docker run <image> + inject binary/creds/git-identity/origin; setup/run; tee NDJSON
  collect.ts       # parse summary (key outcome, not exit code); extract PR diff; strip docs/plans/
  cleanup.ts
scorer/          # invoke the Multi-SWE-bench/SWE-bench harness (do NOT reimplement the oracle)
  controls.py      # per-instance positive/negative oracle controls (validate log parser + flake-drop)
  score.py         # reset test files to (base+test.patch); run FAIL_TO_PASS/PASS_TO_PASS -> resolved?
  leak-detect.py   # diff-vs-fix.patch similarity + transcript URL scan -> suspected-leak
reviewer/        # role A blind-quality; role B blind A/B vs fix.patch (§7)
report/          # markdown + JSON, keyed by styre commit; resolve-rate split web-on/off + pre/post-cutoff
config/          # creds, budgets (incl. per-instance setup Opus call), concurrency, dataset+styre-commit pins
```

## 6. Per-task pipeline

1. **Build styre** at the pinned commit **with the web-off allowlist override** (§3.1). Cache across tasks.
2. **Oracle controls FIRST** (`controls.py`): run the harness on `base` alone (`FAIL_TO_PASS` must fail) and on `base + fix.patch` (`FAIL_TO_PASS`→pass, `PASS_TO_PASS` green), N times. **Non-deterministic → drop the instance as flaky** before it can mis-score styre. (Also validates the per-language log parser — §4 gate.)
3. **Seed GitHub** — throwaway repo, push `base_commit` as default branch; **set `origin`**. Upstream never touched.
4. **Seed Linear** — `problem_statement`(+`hints`) → ticket in a dedicated throwaway project; **never** `test.patch`/`fix.patch`.
5. **Containerized run** — `docker run` the image; inject styre binary + creds + **git identity** + **`origin`**; `styre setup` → `styre run`; tee NDJSON.
6. **Collect** — parse the `summary` (key `outcome`, not exit code); extract the PR diff; **strip `docs/plans/`**.
7. **Score** — reset all test files to `(base + test.patch)` (discard styre's test-file hunks); run `FAIL_TO_PASS`+`PASS_TO_PASS` → **resolved/not**. Run `leak-detect.py`.
8. **Review** (§7) — roles A + B.
9. **Cleanup** (retain-on-failure for triage).

## 7. Independent review — two roles, both downstream of styre

**(A) Blind-quality** — sees issue + styre's diff, **not** the oracle verdict, **not** `fix.patch`. Judges: addresses the issue? test-gaming? styre-invariant violations? **Purpose:** review↔oracle agreement (how well an independent reviewer predicts ground truth — proxy for styre's own review stage).

**(B) Gold comparison — BLIND A/B** (revised per review to kill authority-anchoring). Present styre's patch and `fix.patch` as **unlabeled candidate A / candidate B, order randomized** (`docs/plans/` stripped from styre's), ask which better addresses the issue and why. **Do not label the human fix as "accepted."** **Purpose:** a defensible preference measure + triage signal. **Guards:** calibrate the reviewer against a human-labeled sample and report inter-rater agreement **before** publishing any "gold-divergence" rate; use role B for **flagging + human adjudication**, **not** as a raw fine-tuning scalar (an uncalibrated LLM preference trained on would teach styre to *mimic* `fix.patch`, abandoning valid alternatives). Firewall holds: role B is the only stage besides the scorer that sees `fix.patch`, strictly post-hoc.

Three orthogonal verdicts recorded — **oracle** (mechanical), **blind-quality** (gold-unaware), **A/B preference** — their disagreements are signal.

## 8. Metrics & report

**Per task:** `resolved` (oracle) · `ticks`/`cycle_count` · `escalation_count`+reasons · `outcome`/`status` · parked? · `cost_usd`/tokens · PR-opened? · blind-quality verdict · A/B preference + notes · `suspected-leak`? · web-on/off · pre/post-cutoff · (language, difficulty) · styre commit.

**Rolled up by language × difficulty:** resolve-rate grid; **self-report gap** (% PR-opened-but-unresolved); **oracle-pass conditioned on styre's self-authored test**; loop economics (median/p90 ticks+loopbacks, resolved vs not); failure-taxonomy histogram (§9a); **review↔oracle agreement**; **A/B preference rate** (with calibration caveat); **resolve-rate split web-on/off and pre/post-cutoff** (§3.1). Markdown + JSON, keyed by styre commit for cross-build trends.

## 8a. Report mockup (illustrative — sample *shape*, numbers are fabricated)

The per-run markdown report renders roughly as below (a Phase-2 full-breadth run). Numbers are placeholders to show layout, not results.

```markdown
# Styre-Bench Report — Phase 2 (full breadth)

styre: feat/polyglot-setup @ a2406a4 · dataset: Multi-SWE-bench v1 + SWE-bench Verified · seed: 42
run: 2026-07-15 · instances: 36 (6 langs × 3 difficulty × 2) · cohort: web-OFF (headline) · budget: $180 / $250

## Headline
| metric                              | web-off (headline) | web-on (Δ)   | post-cutoff only |
|-------------------------------------|--------------------|--------------|------------------|
| Resolve rate (oracle)               | 47% (17/36)        | 61% (+14pp)  | 39% (7/18)       |
| Self-report gap (opened-unresolved) | 33% (12/36)        | 21%          | 39%              |
| PR-opened rate                      | 89% (32/36)        | 92%          | 83%              |

> web-on +14pp is a CONTAMINATION signal, not capability (4 web-on runs flagged suspected-leak).
> post-cutoff 39% is the memorization-bounded floor — the most honest number.

## Resolve rate — language × difficulty (web-off)
| lang   | Easy | Medium | Hard | cell |
|--------|------|--------|------|------|
| TS     | 3/3  | 2/3    | 0/3  | 56%  |
| JS     | 2/3  | 1/3    | 0/3  | 33%  |
| Go     | 3/3  | 2/3    | 1/3  | 67%  |
| Java   | 2/3  | 1/3    | 0/3  | 33%  |
| Rust   | 2/3  | 1/3    | 1/3  | 44%  |
| Python | 1/3  | 0/3    | 0/3  | 11% ⚠ |
| by-diff| 72%  | 39%    | 17%  |      |

⚠ Python 11%: 5/9 got a non-runnable test command from `styre setup` (root-only pytest bias)
  → spurious loopbacks. Read as DETECTOR-COVERAGE, not loop performance.

## Loop economics (web-off)
| metric                | resolved | unresolved |
|-----------------------|----------|------------|
| ticks (median / p90)  | 6 / 11   | 14 / 22    |
| loopbacks (median)    | 1        | 4          |
| escalations / run     | 0.2      | 1.3        |
| cost / instance (med) | $3.10    | $6.40      |
top escalation reasons: verify-red-exhausted (9), scope-diff (3), no-progress (2)

## Judgment quality
- Review↔oracle agreement: 0.78 (blind reviewer predicts ground truth 78% — styre's own review stage is a decent-but-imperfect gate)
- A/B gold preference (blind, calibrated κ=0.61 vs human labels): human 64% · styre 22% · tie 14%
- Gold-divergence: 6/17 oracle-resolved (35%) still prefer the human fix → resolved-but-suboptimal (fine-tuning triage set)

## Failure taxonomy (36)
resolved 17 · opened-but-unresolved 12 · loop-exhausted 3 · probe 2 (Python) · parked 1 · infra 1 · suspected-leak 0 (web-off)

## Validity panel
- web-on suspected-leak: 4/36 (diff≈fix.patch, or a PR URL in the transcript)
- pre-cutoff 55% vs post-cutoff 39% resolve → ~16pp memorization lift, isolated
- flaky instances dropped by oracle controls before scoring: 2 (Rust log-parser nondeterminism)
```

Each task also emits one machine-readable record (the JSON the markdown rolls up):

```json
{
  "instance": "microsoft__TypeScript-53421",
  "language": "ts", "difficulty": "medium",
  "styre_commit": "a2406a4", "cohort": "web-off",
  "merge_date": "2024-11-02", "post_cutoff": true,
  "resolved": false, "pr_opened": true,
  "self_authored_test": true, "self_test_passed": true,
  "ticks": 13, "cycle_count": 4,
  "escalation_count": 1, "escalation_reasons": ["verify-red-exhausted"],
  "outcome": "pr-ready", "status": "ok", "exit_code": 0, "parked": false,
  "cost_usd": 5.80, "tokens_in": 210400, "tokens_out": 38200,
  "blind_quality": "addresses-issue-partial",
  "ab_preference": "B(human)",
  "ab_notes": "styre narrows the type guard but misses the union case the accepted fix handles",
  "suspected_leak": false,
  "taxonomy": "opened-but-unresolved"
}
```

## 9. Safety & hygiene (hard rules)

No upstream contact (throwaway repos only). Dedicated throwaway Linear project + auto-cleanup. The firewall (§3) **and** the web-off/leak-detect contamination controls (§3.1). Budget cap + kill-switch (per-task `cost_usd` ceiling incl. the setup Opus call; overall run budget; bounded concurrency ~3). Secrets injected at runtime, never baked/committed. Reproducibility: dataset version, sampling seed, **styre commit**, web-on/off recorded per report.

### 9a. Failure taxonomy (keyed on `summary.outcome`, not exit code)
`infra` (bench/Docker/seed **or a flaked Anthropic/Linear/GitHub call on the critical path** — Docker seals only the *test toolchain*, not these live deps) · `probe` (`styre setup` unusable profile) · `parked` (exit 75, re-runnable) · `loop-exhausted` (`summary.outcome` = blocked/no-progress) · `suspected-leak` (§3.1) · `opened-but-unresolved` (the interesting case) · `resolved`. **Whole-instance infra-retry** (capped, counted) on classified infra/transient/forge/tracker failures before an instance counts toward the quality denominator.

## 10. Phasing
1. **Pilot (~6):** TS + Python × 3. Prove Docker glue, git-identity/origin wiring, seeding, telemetry, **oracle controls + leak-detect + web-off override**, both review roles, the firewall.
2. **Full breadth:** 6 languages × 3 + depth → first breadth×depth + gold-divergence + web-delta report.
3. **Later:** larger sweeps; **multi-stack/monorepo** (the deferred open-core-axis question) — needs a self-authored/synthesized multi-language oracle corpus; scoped separately.

## 11. Open questions for the plan
- **Web-off override mechanism:** cleanest way to drop `WebSearch`/`WebFetch` from the bench build's allowlist without shipping it (config layer vs build flag).
- **Memorization split:** which corpus splits carry reliable merge dates for the pre/post-cutoff cut; what fraction is post-cutoff (is the honest denominator big enough?).
- **Python corpus variant:** SWE-bench vs **SWE-bench Verified** (the *variant* — NOT Multi-SWE-bench's Python slice, which is out of scope per the language split so the "second corpus family" pilot rationale holds).
- **Live Linear+GitHub at scale:** throwaway-org + dedicated-project robustness + cost/rate-limit budget at 25+ instances (incl. the per-instance setup Opus call).
- **A/B reviewer calibration:** size of the human-labeled calibration sample; agreement threshold before publishing.
- **Repo seeding fidelity:** flat `base_commit` snapshot vs preserved history (probably snapshot; confirm).
