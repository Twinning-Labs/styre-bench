# Styre-Bench — end-to-end testing strategy for the harness (v2)

**Status:** Design (brainstorm output) — pending independent review + operator approval
**Date:** 2026-07-02
**Repo:** `Twinning-Labs/styre-bench` (public). Black-box-ish: drives styre as a subprocess.
**Supersedes:** `styre/.../docs/brainstorms/2026-06-28-styre-bench-testing-strategy-design.md` (orphaned draft, pre-polyglot). This v2 keeps ~90% of it and updates for: (a) styre now probes 8 languages + multi-stack, (b) the monetization axis is deferred and the bench should generate "where does value live" data, (c) a gold-comparison review dimension (operator ask, §7).

---

## 1. Goal & non-goals

**Goal.** Stress the styre harness across **language breadth** and a **difficulty gradient**, driving styre end-to-end (`setup → run → PR`) against a corpus where **success is mechanically verifiable by a held-out oracle**, and produce a report that localizes *where and how* the control loop degrades — and, per the deferred open-core decision, generates **"where does value live"** data (does the loop reliably close tickets? where does it break by language × difficulty?).

**Primary signals.**
- Did styre actually fix the issue? — **ground-truth pass/fail, not self-report** (held-out oracle).
- Loop economics — ticks / loopbacks / escalations / cost, resolved vs not.
- Where the loop breaks as a function of **language × difficulty**.
- **Self-report gap** — % of PRs styre opened as "done" that the oracle says are NOT fixed (styre's own verify only sees tests present at `base_commit`; the bug's regression test is held out).
- **Solution quality vs the accepted human fix** — an outside review agent compares styre's diff to the real merged `fix.patch` (§7).

**Non-goals.**
- Not a leaderboard submission (reuses leaderboard infra).
- **Not multi-stack/monorepo yet** — this first corpus is single-stack (operator: breadth-first). SWE-bench-family instances are single-repo/single-primary-language, so multi-stack has no ready oracle corpus; it's a later, harder-sourcing phase (§10).
- Never touches real upstream repos (throwaway repos only; §9).
- Not testing the commercial plane (daemon/scheduling/inbox).

## 2. Grounding facts (current styre, verify before relying)

- **styre is driven from the `feat/polyglot-setup` branch, not the released binary.** Released `v0.2.0` is Node/Rust-only; the 8-language + non-root capability is on that (unmerged, per the open-core decision) branch. The bench **pins and builds styre at a recorded branch commit** — this replaces the prior doc's "brew-install the released binary" framing. (Records the styre commit in every report for reproducibility.)
- **Linear is mandatory + GitHub PR is mandatory.** `styre run` ingests the ticket from Linear (`LINEAR_API_KEY`; title/description/label → `Bug|Feature|Improvement`) and the projector always pushes a branch + opens a GitHub PR (no dry-run). So the bench needs a **dedicated throwaway Linear project** + **throwaway GitHub repos** under a bench org.
- **Verify runs the profile's commands on the worktree — no built-in sandbox.** The bench provides isolation + a runnable toolchain via **Multi-SWE-bench's per-instance Docker images** (deps baked → per-language test commands, incl. those needing installed deps, actually run). This also neatly covers the Ruby/PHP "inert-until-install" caveat — though Ruby/PHP aren't in this corpus (§4).
- **Telemetry = NDJSON on stdout.** Terminal `summary`: `ticks`, `cycle_count` (loopbacks), `escalation_count`+reasons, `dispatch_*`, `cost_usd`, `tokens_*`, final `stage`/`outcome`/`status`. Exit codes: `0` pr-ready · `75` parked · `65` resume-refused · `1` error.
- **Creds (headless):** `ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, `GITHUB_TOKEN`. Model tiers: design/review Opus, implement Sonnet, cheap Haiku.

## 3. The firewall (the load-bearing integrity rule)

Every instance carries the landed solution; the bench's validity depends on **styre never seeing it.**

- **styre + the bench driver see ONLY** the `problem_statement` (→ synthetic ticket) and the repo at `base_commit`.
- **`test.patch` (oracle) and `fix.patch` (accepted solution) are NEVER** placed in the ticket, the seeded repo, or the container styre runs in. They live only in the bench's scoring/review stage, applied/read **after** styre has produced its PR.
- Consequence for seeding: the throwaway repo is `base_commit` only; the Docker image must not contain the held-out test files in a location styre's `setup`/verify would discover. (Multi-SWE-bench separates the eval test patch from the base image — confirm per-instance during rig build.)

## 4. Corpus — single-stack, breadth-first

**Languages = styre-supported ∩ has-an-oracle-corpus:** **JS, TS, Go, Java (JVM), Rust** (Multi-SWE-bench) + **Python** (SWE-bench / SWE-bench Verified). **Excluded:** Ruby, PHP (styre supports them but no ready held-out-oracle corpus — **known coverage gap**, revisit if a corpus appears); C/C++ (styre doesn't support).

Each instance provides: `repo`, `base_commit`, `problem_statement`, `hints`, `test.patch` (held-out oracle), `fix.patch` (accepted human solution — analysis/review only), `FAIL_TO_PASS`, `PASS_TO_PASS`, and a pinned Docker image.

**Sampling — stratified by language × difficulty (Easy/Medium/Hard), seeded/deterministic, recorded** (so a run is reproducible and one instance can be re-run in isolation).
- **Phase 1 — rig-proving pilot (~6):** **TS + Python × {Easy, Medium, Hard}**, one each. TS exercises the Node detector via **Multi-SWE-bench**; Python exercises a new M-B detector via a **second corpus source (SWE-bench)** — so the pilot proves both corpus paths + both detectors cheaply before scale.
- **Phase 2 — full breadth matrix:** all 6 languages × 3 difficulties, with depth per cell so failures localize to a (language, difficulty) coordinate.

**Pre-flight (from the prior doc's open Q, now mandatory):** before committing a language to the corpus, spot-check that `styre setup` on a few of that language's instances yields a **runnable** test command (probe-validation). If the detector produces a command-less/wrong profile, that's a styre finding — record it, don't silently drop the language.

## 5. Architecture (`styre-bench` repo)

```
styre-bench/
  orchestrator/     # bun/TS — owns control flow (consistent w/ styre's stack)
    matrix.ts       #   seeded sampling + stratification
    build-styre.ts  #   build styre at the pinned feat/polyglot-setup commit
    seed-github.ts  #   throwaway repo @ base_commit (never upstream)
    seed-linear.ts  #   problem_statement -> ticket (dedicated project); NEVER test/fix.patch
    run-task.ts     #   docker run <image> + inject styre binary+creds; styre setup/run; tee NDJSON
    collect.ts      #   parse telemetry summary + extract the PR diff
    cleanup.ts      #   tear down repo/ticket/branch/container
  scorer/           # invokes the Multi-SWE-bench/SWE-bench eval harness (do NOT reimplement the oracle)
    score.py        #   apply test.patch on (base + styre diff) -> FAIL_TO_PASS/PASS_TO_PASS -> resolved?
  reviewer/         # two review roles (§7): (A) blind-quality, (B) gold-comparison
  report/           # per-run markdown + machine-readable JSON (trend across styre commits)
  config/           # creds wiring, budget caps, concurrency, dataset + styre-commit pins
```

## 6. Per-task pipeline (fully isolated, independently re-runnable)

1. **Build styre** at the pinned branch commit (cached across tasks).
2. **Seed GitHub** — throwaway repo, push `base_commit` as default branch (styre's PR origin). Upstream never touched.
3. **Seed Linear** — `problem_statement` (+ `hints`) → styre ticket (What/Why/Scope/AC/Refs), `Bug` ⇒ `fix/<ident>`, in a dedicated throwaway project. **Reveals only the issue — never `test.patch`/`fix.patch`.**
4. **Containerized run** — `docker run` the instance image; inject styre binary + creds; inside: `styre setup <repo>` → `profile.json`, then `styre run <ident> --profile <p>`. Tee NDJSON; record exit code.
5. **Extract the PR diff** styre opened.
6. **Score (held-out oracle)** — apply `test.patch` on (base + styre's diff), run `FAIL_TO_PASS`+`PASS_TO_PASS` via the Multi-SWE-bench/SWE-bench harness → deterministic **resolved / not-resolved**.
7. **Independent review** (§7) — both roles.
8. **Cleanup** (retain-on-failure configurable for triage).

## 7. Independent review — two distinct roles

Both are separate agents/workflows; both are strictly downstream of styre (styre never sees their inputs).

**(A) Blind-quality review** — sees the issue + styre's diff, **not** the oracle verdict and **not** `fix.patch`. Judges: does it address the issue, test-gaming, styre-invariant violations, obvious scope creep. **Purpose:** measure **review↔oracle agreement** (how well an independent reviewer — proxy for styre's own review stage — predicts ground truth).

**(B) Gold-comparison review** (operator ask) — sees the issue + styre's diff + **the accepted `fix.patch`**. Compares styre's solution to what actually landed: same root cause or a workaround? narrower/broader? equivalent/better/worse? scope creep vs the human fix? **Purpose:** a rich qualitative signal + **fine-tuning input** — where does styre diverge from accepted human solutions, even when the oracle passes? (A PR can pass the oracle yet take a worse approach than the merged fix; this catches that.) **Firewall:** role B is the *only* stage besides the scorer that ever sees `fix.patch`; it runs post-hoc, never in styre's environment.

The three verdicts are orthogonal and all recorded: **oracle** (mechanical resolved), **blind-quality** (independent, gold-unaware), **gold-comparison** (vs the accepted fix). Their disagreements are themselves signal (e.g. oracle-pass + gold-comparison-"worse" = styre resolved it but sub-optimally).

## 8. Metrics & report

**Per task:** `resolved` (oracle) · `ticks` · `cycle_count` · `escalation_count`+reasons · final `stage`/`outcome`/`status` · exit code (parked?) · `cost_usd`/tokens · PR-opened? · blind-quality verdict · **gold-comparison verdict + notes** · (language, difficulty) · styre commit.

**Rolled up by language × difficulty:**
- Resolve-rate grid (breadth × depth).
- **Self-report gap** — % PR-opened-but-not-resolved.
- Loop economics — median/p90 ticks + loopbacks, resolved vs not.
- Failure taxonomy histogram (§9a).
- **Review↔oracle agreement** (calibrates trust in styre's review stage).
- **Gold-divergence rate** — % oracle-resolved-but-gold-comparison-flags-worse/broader (the fine-tuning target).

Output: human-readable markdown + machine-readable JSON, keyed by styre commit for trend tracking across builds.

## 9. Safety & hygiene (hard rules)

- **No upstream contact** — throwaway repos only; PRs never target real projects.
- **Dedicated throwaway Linear project**; auto-cleanup; never the real Styre/Harness boards.
- **The firewall (§3)** — `test.patch`/`fix.patch` never reach styre.
- **Budget cap + kill-switch** — per-task `cost_usd` ceiling + overall run budget; bounded concurrency (default small, ~3 — each run is a full agent pipeline).
- **Secrets** injected into containers at runtime, never baked/committed.
- **Reproducibility** — dataset version, sampling seed, **styre commit** recorded in every report.

### 9a. Failure taxonomy (one bucket per task)
`infra` (bench bug) · `probe` (`styre setup` unusable profile) · `parked` (exit 75, re-runnable) · `loop-exhausted` (escalated/retry-bound, no PR) · `opened-but-unresolved` (PR opened, oracle says no — the interesting case) · `resolved`.

## 10. Phasing

1. **Phase 1 — rig-proving pilot (~6):** TS + Python × 3 difficulties. Prove Docker glue, GitHub/Linear seeding, telemetry capture, oracle scoring, both review roles, the firewall. Surfaces harness bugs before scale.
2. **Phase 2 — full breadth matrix:** 6 languages × 3 difficulties + depth per cell → first breadth×depth report + gold-divergence data.
3. **Later:** larger sweeps for gradient curves; **multi-stack/monorepo** (the deferred open-core-axis question) — needs a self-authored or synthesized multi-language oracle corpus; a materially harder sourcing problem, scoped separately.

## 11. Open questions for review

- **Firewall mechanics per corpus:** confirm Multi-SWE-bench and SWE-bench each keep `test.patch` out of the base image so styre can't discover the held-out tests (§3) — verify per-instance, not assume.
- **Python corpus:** SWE-bench vs SWE-bench Verified vs Multi-SWE-bench's Python slice — which oracle harness + image set, and does styre's Python detector yield a runnable command on them (pre-flight §4)?
- **Gold-comparison reviewer rigor:** single pass vs N-perspective panel; how to make "better/worse than gold" a calibrated, non-hand-wavy judgment.
- **styre run needs live Linear + GitHub** at scale (25+ tickets/repos): confirm the throwaway-org + dedicated-project approach + cleanup is robust, and the per-run cost/rate-limit budget.
- **Repo seeding fidelity:** flat `base_commit` snapshot vs preserved history — does styre's design stage benefit from real history? (Probably snapshot; confirm.)
- **Difficulty labels:** trust the dataset's Easy/Med/Hard, or re-derive from golden-patch size / #files / #hunks for consistency across the two corpus sources?
