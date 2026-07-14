# Force `checksSystem: "none"` for bench scratch repos — Design

**Ticket:** ENG-295 — `[bench] Force checksSystem:"none" for SWE / Multi-SWE bench scratch repos (narrow harness override)`
**Scope:** styre-bench only. styre **core is untouched.**
**Date:** 2026-07-14

## Problem

The bench runs `styre setup <repo> --out /out/profile.json` live inside each instance
container (`orchestrator/run-task.ts:359`), then `styre run --profile /out/profile.json`
(`run-task.ts:369`). `styre setup` probes `checksSystem` by looking for `.github/workflows/`
in the checked-out repo (`detectChecksSystem`, styre `src/setup/detect.ts:40-49`): if any
workflow file exists it writes `checksSystem: "github"`, else `"none"`.

Bench instance repos (SWE-bench / Multi-SWE-bench images) commonly *do* ship
`.github/workflows/` in-tree, so setup probes them as `"github"`. But the bench pushes to a
throwaway scratch repo that **never runs CI** — no Actions are enabled, no runner ever
produces check-runs.

At the merge stage this is fatal. `styre run` drives one ticket to a terminal via
`driveToTerminal` (styre `src/daemon/run-ticket.ts`). The merge gate (`resolver.ts:231-244`)
clears in order: `merge:push` → `merge:pr-ensure` → **`external_checks` delivered** →
`human_merge_approval` delivered → advance `merge → released`. For `checksSystem: "github"`,
`pollChecks` (styre `src/daemon/poll-checks.ts:45-53`) polls the PR sha for GH-Actions
check-runs; on a CI-less scratch repo the verdict stays `pending` forever, so `external_checks`
is never delivered, the resolver never reaches the `human_merge_approval` gate, every tick
advances 0, and the run hits `no-progress` at `IDLE_CAP=3`.

**Ground truth** (2026-07-13 SMOKE=2, styre @ `9cc6c53`, SoT captured via PR #8 `--db`):
darkreader ENG-293 reached `stage=merge` cleanly — `merge:push` + `merge:pr-ensure` succeeded,
the forge `push` + `pr_create` outbox rows were both `sent`, **PR #1 was created**,
`external_pr_result` delivered — and then idled to `no-progress` on the single stuck
`external_checks=pending` signal. This corrects the earlier (unverified) "silent push
failure / no PR" hypothesis.

## Fix

Append `--checks none` to the bench's existing `styre setup` invocation in
`buildEntrypoint` (`orchestrator/run-task.ts:359`), next to `--trust-agent-commands`:

```
"${CONTAINER_BINARY_PATH}" setup "${repoDirInImage}" --out "${CONTAINER_PROFILE_PATH}" --checks none --trust-agent-commands
```

`--checks github|external|none` is an **existing, supported styre-core CLI flag**
(`src/cli/setup.ts:216`). It threads through `probeProfile`'s override path
(`src/setup/probe.ts:28`, `overrides?.checksSystem ?? detectChecksSystem(...)`) and writes the
top-level `"checksSystem"` profile key. So the override is expressed entirely through core's
public interface — **no core code changes, no detection change, and no post-hoc mutation of
the emitted `profile.json`.** (`citty` parses flags position-independently, so the flag's
placement relative to `--out`/`--trust-agent-commands` is functionally irrelevant.)

> **`checksSystem` is not the verify-stage RED-first check.** `checksSystem` is the *external
> CI polling system* — read only by `pollChecks` (`src/daemon/poll-checks.ts`), checks-adapter
> selection (`src/daemon/ports.ts:51`), a setup cred note, and telemetry. It is a **different
> concern** from styre's verify-stage `checks:dispatch` RED-first check authoring (the subject
> of ENG-296/297). Forcing `checksSystem: "none"` does **not** disable or weaken styre's
> RED-first verification, so what the bench measures is unchanged — only the merge-stage CI
> wait is removed.

### Why this is sufficient

With `checksSystem: "none"`, `pollChecks` delivers `external_checks = "skipped"` immediately
(styre `src/daemon/poll-checks.ts:41-44`) instead of polling. The resolver then advances the
merge gate to `human_merge_approval`. `driveToTerminal` checks `stage === "merge"` +
`human_merge_approval` pending (styre `src/daemon/run-ticket.ts:75-76`) and returns the
**`pr-ready`** outcome — a clean, successful terminal that is evaluated *before* the
idle/no-progress check (line 81). So the outcome flips from `no-progress` → `pr-ready`.
`human_merge_approval` is the intended OSS terminal (the operator merges manually); the bench
scorer reads the PR diff, so `pr-ready` — PR open, checks skipped — is the bench success state.
Reaching `released` is **not** in scope and is not achievable under `styre run` (it never
delivers `human_merge_approval`).

### Why unconditional (not gated)

Every current bench cohort runs throwaway scratch repos that never run CI, so honoring a
detected `github` checks-system can only ever stall. There is no bench mode where the override
would be wrong, so it is applied unconditionally rather than behind a `bench.config` toggle
(YAGNI). If a future cohort ever needs real CI, a gate can be added then.

## Scope boundaries

- **IN:** one flag added to the bench entrypoint's `styre setup` command; a test asserting it.
- **OUT (core):** no change to `detectChecksSystem`, `probeProfile`, or any core detection. A
  real repo run outside the bench (no `--checks` flag) still probes `checksSystem: "github"`
  when Actions genuinely exist.
- **No downstream harness change:** the harness's black-box `ProbeProfile`
  (`orchestrator/collect.ts:4-13`) reads only `components[].commands.test`, so nothing in the
  harness reads `checksSystem` directly. The change does move the run *outcome* from
  `no-progress` to `pr-ready`, which `deriveTaxonomy` (`collect.ts:180-185`) handles
  **favorably**: `no-progress → "loop-exhausted"` (the run is written off) versus
  `pr-ready → undefined →` score-based resolution on the PR diff / gold FAIL_TO_PASS. Scoring
  stays off the diff, independent of `checksSystem` and of whether the ticket reaches
  `released`; the flip only lets a run that actually opened a PR be scored instead of
  discarded. No harness code changes.

## Testing

`tests/run-task.test.ts`, two edits (no container run required — assertions on the emitted
entrypoint script string):

1. **Update the existing exact-match assertion at `tests/run-task.test.ts:224`.** It currently
   asserts the substring `setup "/testbed" --out "/out/profile.json" --trust-agent-commands`,
   which no longer appears once `--checks none` is inserted. Change it to the full new command:
   `setup "/testbed" --out "/out/profile.json" --checks none --trust-agent-commands`. (Leaving
   it unchanged lands a red suite while the AC claims the emitted entrypoint is verified.) The
   `/repo`-override assertion at `:230` (`setup "/repo" --out "/out/profile.json"`) is a prefix
   substring and survives unchanged.
2. **Add a focused assertion** that the generated script contains `--checks none` (mirroring the
   existing `--db "/out/sot.db"` assertion added in PR #8) — a direct guard on the override so
   an accidental removal is caught independently of the full-command string.

## Acceptance criteria (from ENG-295)

- [x] Bench runs against SWE/multi-SWE images pass `checksSystem: "none"` into `styre run`
  (via `styre setup --checks none`, verified in the emitted entrypoint).
- [x] A ticket that reaches `stage=merge` with a created PR advances past `external_checks`
  (verdict `skipped`, not `pending`) — the run terminates `pr-ready`, no longer blocked by the
  CI-wait.
- [x] styre core is untouched; a real repo with GH Actions still probes `checksSystem: "github"`.
