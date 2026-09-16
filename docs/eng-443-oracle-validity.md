# ENG-443: fix forward with independent controls and visible uncertainty

ENG-430 fixed an actual fail-closed hole but conflated unknown measurement failures with
infrastructure and treated the corpus's selection criterion as a negative control. Reverting
would restore the original empty-stage verdict bug. This change fixes forward.

## Evidence and decision

Matrix 4 retained gold reports have FAIL_TO_PASS passing in all six executions, but changing
PASS_TO_PASS failures. Their overall gold verdicts are all false and their target statuses
are nondeterministic. They must be labelled `dropped-flaky` while retaining the failed gold
facts; this does not imply that the human fixes or TypeScript instances are now qualified.

The pinned `multi-swe-bench==1.1.2` source, rather than current upstream assumptions, establishes:

- `run_evaluation.CliArgs.run_mode_evaluation` passes stored dataset run/test stages to
  `gen_report`; comparing those with dataset F2P merely rechecks dataset selection.
- `Instance.test_patch_run()` supplies the native test-only command; `--fix_patch_run_cmd`
  overrides the command executed during evaluation. MUI returns `bash /home/test-run.sh`,
  which applies **only** `/home/test.patch` and runs its version-specific pnpm/yarn suite.
- Default `human_mode=True` uses `docker_util.run`: each invocation creates a new container
  from the image, mounts that invocation's fix patch, and removes the container in `finally`.
  `_run_harness` also uses a fresh work directory per call. A prior gold container is not reused.
  The native base script never reads the mounted empty fix patch.
- The report's fresh `fix_patch_result` therefore contains the independently executed base
  statuses when the native test-only command is used. Base qualification requires every F2P
  target to be explicitly failed; missing/skipped targets produce null, never true. An observed
  passing target fails the control. Contradictory statuses fail closed.

The source is the installed pinned wheel's `harness/{run_evaluation,gen_report,instance}.py`,
`harness/repos/typescript/mui/material_ui.py` and `utils/docker_util.py`. Upstream reference:
https://github.com/multi-swe-bench/multi-swe-bench (the README documents the command override;
operational behavior must be checked against the pin).

## Candidate measurement and retries

The pinned report carries test statuses/counts, not causal command-phase provenance. In MUI,
test and candidate patches are applied together; even an apply-error string cannot prove
which patch failed. Zero results may be caused by a candidate build failure, harness failure,
or an empty patch causing the script to exit before tests. Do not guess the cause.

A structurally valid zero-result stage becomes `resolved: null`, `origin: unknown` and
`oracle-unmeasured`, with no automatic retry of this observed no-result. Missing/malformed
reports and subprocess exceptions remain errors and receive bounded scorer-only retries of
exactly the same diff. These retries cannot recreate a repo/ticket, rerun Styre, or charge a
second authored attempt. Exhaustion also remains an unknown submitted candidate, not a
silently excluded infra attempt. CI goes red unless a boolean verdict was actually produced.

The report shows the measured-only rate alongside explicit lower/upper resolve bounds across
measured plus unknown submissions, separately for each cohort. Explicit `score_attempted`
provenance keeps submitted parked runs in these bounds regardless of the verdict, while
the measured headline retains its existing parked exclusion. Failed controls are excluded
from these bounds because Styre never submitted a candidate for them. Proven unresolved test
verdicts remain false and count in the ordinary denominator. The schema does **not** claim to
identify candidate-caused build failures: causal phase instrumentation remains a gap. The
bounds prevent that unknown class from silently improving the headline.

## Live validation, without running Styre

Offline fixtures verify command routing, corpus-stage independence, explicit target failures,
gold disagreement, absent/skipped statuses, retained partial controls, unknown-score report
bounds and identical-candidate retries. They do not establish Linux image qualification.

On the Linux bench checkout with pinned dependencies, first check the actual native API:

```bash
PYTHONPATH=scorer .venv/bin/python - <<'PY'
from adapters.multiswebench import _raw_instance, native_test_patch_command
raw = _raw_instance('mui__material-ui-33777', 'ts')
print(native_test_patch_command(raw))
PY
```

Then run only the independent negative control; this builds/evaluates the image but invokes
no agent or LLM. Keep its JSON and the `base_report_path` it returns:

```bash
PYTHONPATH=scorer .venv/bin/python - <<'PY'
import json
from adapters.multiswebench import MultiSweBenchAdapter
print(json.dumps(MultiSweBenchAdapter()._run_harness(
    {'id': 'mui__material-ui-33777', 'language': 'ts'}, '', base=True
), indent=2))
PY
```

Inspect the raw log to confirm the test-only script actually ran and targets are present.
Only after that, run `score.py run_controls` for all three selected MUI instances, with retained
reports/logs, to evaluate current gold twice plus base. Qualification requires all controls
true. This change neither filters flaky tests nor changes the benchmark's success criteria.
