# Reporting evidence contracts

A report must distinguish measured results, workflow outcomes, declarations, and unavailable
evidence. `report/measurement.ts` owns the population rules; `report/render.ts` produces both
human-readable Markdown and `metrics.json` with explicit numerators and denominators.

## Populations

- **Oracle resolve rate:** resolved candidates / candidates with a boolean oracle verdict.
  `score_attempted=true` establishes submission, including parked candidates. A submitted
  candidate with `resolved=null` stays outside that measured rate and inside the reported
  lower/upper bounds. An unsubmitted workflow failure is not a measured oracle failure.
- **Confirmed ticket-to-PR delivery:** control-qualified runs with both an opened PR and an
  oracle-resolved candidate / all control-qualified runs. This includes failures to deliver
  a candidate. It measures confirmed end-to-end success, not a substitute oracle rate.
- **PR-opened rate:** opened PRs / all records whose PR state is known. This includes records
  outside the oracle population. A pre-run drop has known no-run/no-PR state; a failed forge
  lookup is unknown and excluded. No-run records have no Styre self-report and cannot
  count as agreement with one.
- **Opened-unresolved (historically “self-report gap”):** opened, oracle-unresolved candidates /
  records with both a measured oracle verdict and known PR state. PR existence is not itself
  a test-pass claim. The separate PR self-report comparison checks Styre telemetry against
  known PR state and reports its actual comparison count.
- **Review agreement:** recognized reviewer predictions compared only with measured oracle
  verdicts. Unknown/unparsed labels are not negative predictions.

No observations renders `n/a`, not zero. Web-on deltas require a measured web-off baseline.
Each cohort reports recorded, control-qualified, submitted, measured, and qualification-unknown
counts. This exposes admission losses rather than hiding them behind a scored-only percentage.

## Collection and legacy records

A workflow summary determines workflow taxonomy. `probe` means the recorded setup-failure exit;
missing test declarations cannot establish setup failure. Primary components are those whose
role is absent or `primary`; fixture, example, and vendored components are excluded. A declared
launcher is reported as configuration only. `self_test_passed` requires the independent
self-test scorer, never a PR or profile declaration.

Missing required NDJSON, profile, or candidate-diff artifacts fail collection. An existing empty
diff is a valid observation and differs from a missing diff. A malformed final summary fails;
a valid earlier summary cannot replace it. A missing summary yields an explicit infra outcome.

Collection is judged on the artifacts the container produced. If an artifact exists but does not
match the contract this rig reads (a profile or NDJSON shape it cannot interpret), the record is
`collect-error`: logged, never retried (re-running the paid attempt reproduces it), not scored,
and its evidence directory, including the in-container `candidate.raw.diff`, is kept for offline
scoring once the reader is fixed. A missing artifact (for example from a killed container) stays
`infra` and may be retried. Either way an attempt whose container ran is charged its measured
transcript cost, so the per-task cost cap sees it. The profile reader validates only what it
consumes (component name, role, launcher) and treats any non-string test command as "no declared
launcher", so an additive change to Styre's command values cannot fail collection.

A run's outcome label never claims a PR the forge did not confirm. `opened-but-unresolved`
requires the PR lookup to have found one (`pr_opened=true`); an unresolved candidate without that
confirmation is `unresolved-pr-unconfirmed`. A Styre run that paused `needs_you` at stage `merge`
while the PR lookup found no PR finished its work and failed to deliver the PR (for example GitHub
rejected the PR base), so it is `pr-undelivered`, not `loop-exhausted`. When the lookup found a PR
the pause had another cause (a failed tracker update also escalates), and the label stays
`loop-exhausted`; when the lookup failed, the label relies on Styre's own pause.

New unmeasured records use `resolved=null`, `score_attempted=false`. Historical records without
submission metadata retain boolean verdicts only for the old scored terminal taxonomies
(`resolved`, `opened-but-unresolved`, `loop-exhausted`). Other legacy defaults become null with
an evidence note. This is a documented compatibility rule, not newly recovered oracle evidence.
Contradictory explicit submission/verdict metadata is rejected. Offline taxonomy correction
preserves unsubmitted status before relabeling, so relabeling cannot manufacture a score.

## Validity indicators

Detector state (`not-run`, `error`, `completed`) and parser coverage (`complete`, `partial`,
`unstructured`, `unavailable`) are independent of findings. Missing legacy detector state is
unknown. Complete parser coverage means the retained stream was recognized, not that it captures
all execution. Both web cohorts display findings and coverage. Malformed Python responses and
malformed archived scan metadata fail validation; detector errors remain explicit and do not
erase an otherwise valid oracle verdict.

`tool_use` is a request; `tool_result` carries the response. A URL mention, network-tool request,
or shell-command pattern is an indicator for investigation, not proof of execution, successful
retrieval, or solution exposure. Shell patterns can match quoted examples. Bare issue references
are neutral, and exact URLs supplied in the issue are exempt from URL-reference findings; actual
typed network requests remain visible. These distinctions follow the [Anthropic tool contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

Diff similarity and changed-line containment are uncalibrated lexical indicators. Identical
solutions can be independently derived. Python's [SequenceMatcher](https://docs.python.org/3.11/library/difflib.html#difflib.SequenceMatcher.ratio)
reports sequence similarity, not a probability of exposure. Detector output therefore keeps
`exposure="unknown"` even when an indicator fires.

Ticket overlap v2 counts distinct added patch lines of at least 20 characters that exactly equal
a trimmed ticket line. The rule is versioned as `exact-trimmed-added-lines-v2`; older records used
substring matching. The report says “zero measured ticket/patch overlap”, never “clean ticket”.
Neither zero nor nonzero overlap proves solution disclosure. The separate conservative firewall
guard is unchanged. Corpus patches and overlap excerpts remain host-side and must not be committed
or sent to the agent.

## Correcting an archived report

Use explicit inputs and a new output directory:

```sh
BENCH_PYTHON=/path/to/.venv/bin/python bun bin/reprocess-report.ts \
  /archive/report/report.json /archive/runs /path/to/data \
  /archive/meta.json /archive/corrected-report
```

Metadata includes `styreRef`, `dataset`, integer `seed`, `runDate`, nonnegative `budgetUsd`, and
optional `spentUsd`, `skippedCount`, `title`. It describes the original run, not a new benchmark.
The CLI performs no oracle run, model call, ticket action, or forge lookup. It uses exact evidence
directory basenames, parses retained summaries/profiles, recomputes lexical overlap locally,
and rescans retained transcripts. Missing artifacts are listed explicitly. It refuses to overwrite
an existing destination.

Outputs are `report.md`, `report.json`, `metrics.json`, and `corrections.json`. The latter records
input/corpus/metadata hashes, evaluator commit and source hashes, per-artifact hashes, unavailable
artifacts, and every before/after field change. Original inputs remain untouched. The source hashes
identify the actual evaluator even if its working tree differs from the recorded commit.

Retrospective checks are labeled `scope="transcript-only"` in both JSON and Markdown. They do not
pretend the original pipeline performed a check. The original assessment is preserved in
`prior_leak_assessment`; diff-similarity flags are retained because the transcript rescan cannot
reevaluate them. An incomplete rescan cannot clear a previous positive finding. Interpret any
changed flags with their provenance and retained tool results, not just the compatibility boolean.
