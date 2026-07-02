"""SweBenchAdapter: wraps the `swebench` PyPI harness (princeton-nlp/SWE-bench).

Grounding for the report shape below is NOT a guess -- it was read directly out
of the installed `swebench==4.1.0` package source in this repo's `.venv`
(`swebench/harness/{run_evaluation,grading,reporting}.py`), not from memory or
web search:

  - The harness's per-instance report is written to
    `logs/run_evaluation/<run_id>/<model_name_or_path>/<instance_id>/report.json`
    (`swebench.harness.constants.RUN_EVALUATION_LOG_DIR` / `LOG_REPORT`), shaped as:
    ```
    {"<instance_id>": {
        "patch_is_None": bool, "patch_exists": bool,
        "patch_successfully_applied": bool, "resolved": bool,
        "tests_status": {
            "FAIL_TO_PASS": {"success": [test_id, ...], "failure": [test_id, ...]},
            "PASS_TO_PASS": {"success": [...], "failure": [...]}
        }
    }}
    ```
    (`swebench.harness.grading.get_eval_report`). `tests_status` is ABSENT
    whenever the patch is None/empty or fails to `git apply` -- that is a
    legitimate `resolved: False`, no-id-list-data outcome, not a harness error.
    `_parse_report` below still raises if `resolved: True` is claimed WITHOUT
    `tests_status` backing it -- that combination cannot happen from the real
    harness and would indicate report corruption.

DESIGN DECISION (grounded in the source above, not a guess): the harness's own
`main()` CLI (`run_evaluation.get_dataset_from_preds`) silently filters OUT any
prediction whose patch is `""`/`None` *before* ever starting a container --
i.e. it never actually executes the test command for an empty candidate. That
would break `run_controls`'s base-fails check, which needs the container to
really run with `test_patch` applied and NO fix, to prove the FAIL_TO_PASS
tests genuinely fail on base. This adapter therefore calls the harness's
lower-level per-instance API (`run_evaluation.run_instance`,
`test_spec.make_test_spec`) directly in-process instead of shelling out to the
`main()` CLI entrypoint, and mints a fresh UUID `run_id` per call so
`run_instance`'s own report-cache short-circuit (`if report_path.exists():
return cached`) can never hand back a stale verdict across calls.

ASSUMPTION (verify at live pass): `run_controls`/`score` re-fetch the
authoritative raw SWE-bench record via
`swebench.harness.utils.load_swebench_dataset(dataset_name, split,
[instance_id])` rather than trusting the normalized `Instance` passed in from
TS -- our `Instance` type (orchestrator/types.ts) does not carry the
`version`/`environment_setup_commit` fields `make_test_spec` needs to resolve
the correct eval image, so those must come from the harness's own dataset
load. This means the live path needs network access to Hugging Face (or a
local dataset cache) at score time, in addition to Docker -- flag this if the
sandboxed run environment can't reach HF.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from swebench.harness.constants import (
    FAIL_TO_PASS,
    KEY_INSTANCE_ID,
    KEY_MODEL,
    KEY_PREDICTION,
    PASS_TO_PASS,
    RUN_EVALUATION_LOG_DIR,
    LOG_REPORT,
)

from .base import OracleAdapter

_MODEL_NAME = "styre-bench-scorer"
_SELF_TEST_TIMEOUT_S = 300


def _status_bucket(tests_status: dict[str, Any], key: str) -> dict[str, bool]:
    """Flattens one `tests_status[key]` {"success": [...], "failure": [...]} bucket
    into a `{test_id: bool}` verdict map. Raises on any shape it can't map --
    never silently drops a test id into "passed"."""
    bucket = tests_status.get(key)
    if not isinstance(bucket, dict) or "success" not in bucket or "failure" not in bucket:
        raise ValueError(
            f"swebench: tests_status[{key!r}] is not the expected "
            f"{{'success': [...], 'failure': [...]}} shape (got {bucket!r})"
        )
    success, failure = bucket["success"], bucket["failure"]
    if not isinstance(success, list) or not isinstance(failure, list):
        raise ValueError(f"swebench: tests_status[{key!r}]'s success/failure must both be lists")
    out: dict[str, bool] = {}
    for test_id in failure:
        out[test_id] = False
    for test_id in success:
        out[test_id] = True
    return out


def parse_report(report: dict[str, Any], instance_id: str) -> dict[str, Any]:
    """Pure parser: swebench's report.json -> {"resolved","fail_to_pass","pass_to_pass"}.

    FAIL-CLOSED: raises on a missing/malformed report, a missing entry for
    `instance_id`, a missing/non-bool `resolved`, or a `resolved: True` claim
    with no `tests_status` evidence backing it. Never returns `resolved: True`
    on an error path.
    """
    if not isinstance(report, dict):
        raise ValueError(f"swebench: report is not a dict (got {type(report).__name__})")

    entry = report.get(instance_id)
    if not isinstance(entry, dict):
        raise ValueError(
            f"swebench: report has no entry for instance_id={instance_id!r} "
            f"(top-level keys={list(report.keys())!r}) -- unrecognized report shape"
        )

    resolved = entry.get("resolved")
    if not isinstance(resolved, bool):
        raise ValueError(
            f"swebench: report entry for {instance_id!r} is missing a boolean 'resolved' "
            f"key (got {resolved!r}) -- treating as a harness/report error, not a verdict"
        )

    tests_status = entry.get("tests_status")
    if resolved and not isinstance(tests_status, dict):
        raise ValueError(
            f"swebench: report entry for {instance_id!r} claims resolved=True but has no "
            f"'tests_status' id-list evidence -- refusing to trust an unsupported resolved claim"
        )

    if isinstance(tests_status, dict):
        fail_to_pass = _status_bucket(tests_status, FAIL_TO_PASS)
        pass_to_pass = _status_bucket(tests_status, PASS_TO_PASS)
    else:
        # Legitimate: patch was empty/None or failed to apply -- no id-list data,
        # `resolved` is (and must be) False in this branch.
        fail_to_pass = {}
        pass_to_pass = {}

    return {"resolved": resolved, "fail_to_pass": fail_to_pass, "pass_to_pass": pass_to_pass}


class SweBenchAdapter(OracleAdapter):
    def __init__(self, dataset_name: str = "princeton-nlp/SWE-bench_Verified", split: str = "test"):
        self.dataset_name = dataset_name
        self.split = split

    # -- live (Docker + HF) path -------------------------------------------------

    def _raw_instance(self, instance_id: str) -> dict[str, Any]:
        from swebench.harness.utils import load_swebench_dataset

        rows = load_swebench_dataset(self.dataset_name, self.split, [instance_id])
        if not rows:
            raise ValueError(
                f"swebench: instance_id={instance_id!r} not found in "
                f"{self.dataset_name}:{self.split}"
            )
        return rows[0]

    def score(self, instance: dict[str, Any], candidate_diff: str) -> dict[str, Any]:
        import docker
        from swebench.harness.run_evaluation import run_instance
        from swebench.harness.test_spec.test_spec import make_test_spec

        instance_id = instance["id"]
        raw = self._raw_instance(instance_id)
        test_spec = make_test_spec(raw)
        pred = {
            KEY_INSTANCE_ID: instance_id,
            KEY_MODEL: _MODEL_NAME,
            KEY_PREDICTION: candidate_diff,
        }
        client = docker.from_env()
        # Fresh run_id per call: run_instance() short-circuits on an existing
        # report.json, which would otherwise hand back a stale cached verdict
        # (e.g. the gold-patch result) for a later empty-candidate control call.
        run_id = f"styre-bench-{uuid.uuid4().hex}"
        result = run_instance(
            test_spec, pred, rm_image=False, force_rebuild=False, client=client, run_id=run_id
        )
        if not result.get("completed"):
            raise RuntimeError(
                f"swebench: run_instance did not complete for {instance_id!r} "
                f"(run_id={run_id}) -- see logs/run_evaluation/{run_id}/{_MODEL_NAME}/{instance_id}"
            )
        report_path = RUN_EVALUATION_LOG_DIR / run_id / _MODEL_NAME / instance_id / LOG_REPORT
        if not report_path.exists():
            raise RuntimeError(f"swebench: expected report at {report_path} but it does not exist")
        report = json.loads(report_path.read_text())
        return parse_report(report, instance_id)

    def run_controls(self, instance: dict[str, Any]) -> dict[str, bool]:
        gold = self.score(instance, instance["fix_patch"])
        base_a = self.score(instance, "")
        base_b = self.score(instance, "")
        deterministic = (
            base_a["resolved"] == base_b["resolved"]
            and base_a["fail_to_pass"] == base_b["fail_to_pass"]
        )
        return {
            "gold_resolved": gold["resolved"] is True,
            "base_fails": base_a["resolved"] is False,
            "deterministic": deterministic,
        }

    def run_self_test(
        self,
        instance: dict[str, Any],
        candidate_diff: str,
        added_test_paths: list[str],
    ) -> dict[str, bool | None]:
        if not added_test_paths:
            return {"passed": None}

        import docker
        from swebench.harness.constants import DOCKER_PATCH, DOCKER_USER, DOCKER_WORKDIR, UTF8
        from swebench.harness.docker_build import build_container, close_logger, setup_logger
        from swebench.harness.docker_utils import cleanup_container, copy_to_container, exec_run_with_timeout
        from swebench.harness.test_spec.test_spec import make_test_spec
        from pathlib import PurePosixPath

        instance_id = instance["id"]
        raw = self._raw_instance(instance_id)
        test_spec = make_test_spec(raw)
        client = docker.from_env()
        run_id = f"styre-bench-selftest-{uuid.uuid4().hex}"
        log_dir = RUN_EVALUATION_LOG_DIR / run_id / _MODEL_NAME / instance_id
        log_dir.mkdir(parents=True, exist_ok=True)
        logger = setup_logger(instance_id, log_dir / "self_test.log")
        container = None
        try:
            container = build_container(test_spec, client, run_id, logger, rm_image=False, force_rebuild=False)
            container.start()

            patch_file = log_dir / "candidate.diff"
            patch_file.write_text(candidate_diff or "")
            copy_to_container(container, patch_file, PurePosixPath(DOCKER_PATCH))
            apply_result = container.exec_run(
                f"git apply --verbose {DOCKER_PATCH}", workdir=DOCKER_WORKDIR, user=DOCKER_USER
            )
            if apply_result.exit_code != 0:
                raise RuntimeError(
                    f"swebench: run_self_test could not apply candidate_diff for "
                    f"{instance_id!r}: {apply_result.output.decode(UTF8)}"
                )

            # ASSUMPTION (verify at live pass): a bare `pytest <paths>` invocation is
            # a reasonable default for a Python instance's own added test file(s), but
            # some SWE-bench repos need repo-specific pytest args/plugins (mirrored in
            # MAP_REPO_VERSION_TO_SPECS's test_cmd) that this simple invocation ignores.
            test_cmd = "pytest " + " ".join(added_test_paths)
            marker = "STYRE_BENCH_SELF_TEST_EXIT"
            output, timed_out, _ = exec_run_with_timeout(
                container,
                f"bash -lc '{test_cmd}; echo {marker}:$?'",
                _SELF_TEST_TIMEOUT_S,
            )
            if timed_out:
                raise RuntimeError(
                    f"swebench: run_self_test timed out after {_SELF_TEST_TIMEOUT_S}s for {instance_id!r}"
                )
            if f"{marker}:0" in output:
                return {"passed": True}
            if marker in output:
                return {"passed": False}
            raise RuntimeError(
                f"swebench: run_self_test could not find the exit marker in test output for "
                f"{instance_id!r} -- refusing to guess pass/fail from raw output"
            )
        finally:
            cleanup_container(client, container, logger)
            close_logger(logger)
