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


def _id_list(value: Any) -> list[str]:
    """SWE-bench stores FAIL_TO_PASS/PASS_TO_PASS as a JSON-encoded STRING in the HF dataset and
    as a real list elsewhere. Normalised here so the fail-closed seeding works from either."""
    if isinstance(value, list):
        return [t for t in value if isinstance(t, str)]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return []
        return [t for t in parsed if isinstance(t, str)] if isinstance(parsed, list) else []
    return []


def _status_bucket(
    tests_status: dict[str, Any], key: str, expected_ids: list[str] | None = None
) -> dict[str, bool]:
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
    # Seed every EXPECTED id as False first. base.py: "A missing test id in a harness's post-fix
    # test-status data must never be read as 'passed' -- default such gaps to False, never True."
    # Deriving the keys solely from the report's own lists let a target test vanish from the
    # verdict entirely, which a downstream `all(...)` reads as vacuously green.
    for test_id in expected_ids or []:
        out[test_id] = False
    for test_id in failure:
        out[test_id] = False
    for test_id in success:
        out[test_id] = True
    return out


def parse_report(
    report: dict[str, Any],
    instance_id: str,
    fail_to_pass_ids: list[str] | None = None,
    pass_to_pass_ids: list[str] | None = None,
) -> dict[str, Any]:
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
        fail_to_pass = _status_bucket(tests_status, FAIL_TO_PASS, fail_to_pass_ids)
        pass_to_pass = _status_bucket(tests_status, PASS_TO_PASS, pass_to_pass_ids)
    else:
        # Legitimate: patch was empty/None or failed to apply -- no id-list data,
        # `resolved` is (and must be) False in this branch.
        fail_to_pass = {t: False for t in fail_to_pass_ids or []}
        pass_to_pass = {t: False for t in pass_to_pass_ids or []}

    return {"resolved": resolved, "fail_to_pass": fail_to_pass, "pass_to_pass": pass_to_pass}


# swebench applies a candidate patch by trying these in order, logging one line per failure:
#     git apply --verbose
#     git apply --verbose --reject
#     patch --batch --fuzz=5 -p1 -i
# Only the FIRST is a clean application. `--reject` tolerates dropped hunks, and the `patch`
# fallback will report
#     "Reversed (or previously applied) patch detected!  Assuming -R."
# and REVERT hunks rather than apply them. In either case the container no longer holds the
# candidate's changes -- yet swebench still records patch_successfully_applied: True, the tests
# then fail against unmodified source, and the run yields a confident `resolved: false` for a
# change that was never under test.
#
# Observed for real in run 34432706755: the candidate diff carried a pyproject.toml hunk the
# SWE-bench image had already applied, so `git apply` failed, the fallback reverted the actual
# fix in separable.py, and a correctly-solved instance scored resolved:false.
#
# A false negative corrupts a capability measurement exactly as badly as a false positive, so
# this is an ERROR, never a verdict. score.py turns it into {"error": ...} and the workflow's
# verdict gate takes the job red.
_APPLY_FAILURE_MARKER = "Failed to apply patch to container"

_APPLY_REMEDY = (
    "The candidate diff must apply cleanly with plain `git apply` against the instance's base "
    "commit. The usual cause is the diff carrying changes the image already has -- capture the "
    "candidate diff against the image's own working-tree state, not just the base commit."
)


def _assert_patch_applied_cleanly(run_id: str, instance_id: str, candidate_diff: str) -> None:
    """Raise unless the candidate patch applied with plain `git apply`.

    An empty candidate diff is exempt: there is nothing to apply, and the empty-patch control
    run in `run_controls` depends on it staying a legitimate scoring path.
    """
    if not candidate_diff.strip():
        return
    log_path = RUN_EVALUATION_LOG_DIR / run_id / _MODEL_NAME / instance_id / "run_instance.log"
    if not log_path.exists():
        raise RuntimeError(
            f"swebench: cannot verify patch application for {instance_id!r} -- expected "
            f"{log_path} but it does not exist. Refusing to report a verdict that has not been "
            f"shown to test the candidate diff."
        )
    log = log_path.read_text(errors="replace")
    if _APPLY_FAILURE_MARKER not in log:
        return
    detail = [ln.strip() for ln in log.splitlines() if _APPLY_FAILURE_MARKER in ln or "Assuming -R" in ln]
    raise RuntimeError(
        f"swebench: the candidate patch for {instance_id!r} did not apply cleanly, so the "
        f"container did not hold the candidate's changes and any verdict would be fabricated. "
        f"swebench fell back past `git apply` and may have REVERTED hunks. "
        f"Evidence from {log_path}: {' | '.join(detail) or '(marker present, no detail lines)'}. "
        f"{_APPLY_REMEDY}"
    )


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
        from swebench.harness.docker_build import build_env_images
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
        # BUILD THE ENVIRONMENT IMAGE FIRST. `run_instance` -> `build_container` ->
        # `build_instance_image` RAISES if the env image is absent; it never builds one. In the
        # harness's own flow that phase is performed by `main()`, which this adapter
        # deliberately bypasses (see the module docstring: `main()` filters empty patches out
        # before starting a container, which would break `run_controls`). Bypassing `main()`
        # skipped the build phase with it, so EVERY scoring attempt failed with "Environment
        # image sweb.env.* not found" -- on x86-64 Linux as well as arm64, which is why the
        # architecture was a red herring. `build_env_images` calls `build_base_images` itself,
        # so this one call covers both layers, and it is a no-op when the images already exist.
        # Tags MUST be passed explicitly. swebench 4.1.0 has a positional-argument mismatch:
        # `get_test_specs_from_dataset` calls
        #     make_test_spec(x, namespace, instance_image_tag, env_image_tag)
        # positionally, while that signature is
        #     (instance, namespace, base_image_tag, env_image_tag, instance_image_tag, arch)
        # -- so the third positional lands in the `base_image_tag` slot. `build_env_images`
        # defaults its tag arguments to None, so relying on those defaults makes
        # base_image_tag None and trips `assert base_image_tag is not None`
        # (swebench/harness/test_spec/test_spec.py). The harness's own main() never hits this
        # because it passes "latest"; we pass it for the same reason. Do not tidy these away.
        build_env_images(
            client,
            [raw],
            force_rebuild=False,
            max_workers=1,
            namespace=None,
            instance_image_tag="latest",
            env_image_tag="latest",
        )
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
        # HARD-FAIL ON A DEGRADED APPLY. Must run BEFORE parse_report: a degraded apply still
        # yields a well-formed report with patch_successfully_applied: True, so the verdict
        # would look like a real answer.
        _assert_patch_applied_cleanly(run_id, instance_id, candidate_diff)
        report_path = RUN_EVALUATION_LOG_DIR / run_id / _MODEL_NAME / instance_id / LOG_REPORT
        if not report_path.exists():
            raise RuntimeError(f"swebench: expected report at {report_path} but it does not exist")
        report = json.loads(report_path.read_text())
        # Pass the EXPECTED id lists so a target test missing from the harness report defaults to
        # False rather than vanishing from the verdict (base.py's fail-closed clause).
        return parse_report(
            report,
            instance_id,
            _id_list(raw.get(FAIL_TO_PASS)),
            _id_list(raw.get(PASS_TO_PASS)),
        )

    def run_controls(self, instance: dict[str, Any]) -> dict[str, bool]:
        # FIREWALL: the gold patch is never in the payload ({id, language} only), so it comes
        # from the re-fetched corpus record — the same rule `score` already follows. Reading it
        # off `instance` made run_controls unusable in CI; it went unnoticed because only
        # `score` is exercised there.
        gold = self.score(instance, self._raw_instance(instance["id"])["patch"])
        base_a = self.score(instance, "")
        base_b = self.score(instance, "")
        # NOTE: 2 base-only runs is a weak flake guard -- revisit N at the live pass.
        deterministic = (
            base_a["resolved"] == base_b["resolved"]
            and base_a["fail_to_pass"] == base_b["fail_to_pass"]
            and base_a["pass_to_pass"] == base_b["pass_to_pass"]
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
        from swebench.harness.docker_build import (
            build_container,
            build_env_images,
            close_logger,
            setup_logger,
        )
        from swebench.harness.docker_utils import cleanup_container, copy_to_container, exec_run_with_timeout
        from swebench.harness.test_spec.test_spec import make_test_spec
        from pathlib import PurePosixPath

        instance_id = instance["id"]
        raw = self._raw_instance(instance_id)
        test_spec = make_test_spec(raw)
        client = docker.from_env()
        # Same prerequisite as `score`: `build_container` -> `build_instance_image` raises when
        # the env image is absent and never builds one. No-op once the images exist.
        # Tags MUST be passed explicitly. swebench 4.1.0 has a positional-argument mismatch:
        # `get_test_specs_from_dataset` calls
        #     make_test_spec(x, namespace, instance_image_tag, env_image_tag)
        # positionally, while that signature is
        #     (instance, namespace, base_image_tag, env_image_tag, instance_image_tag, arch)
        # -- so the third positional lands in the `base_image_tag` slot. `build_env_images`
        # defaults its tag arguments to None, so relying on those defaults makes
        # base_image_tag None and trips `assert base_image_tag is not None`
        # (swebench/harness/test_spec/test_spec.py). The harness's own main() never hits this
        # because it passes "latest"; we pass it for the same reason. Do not tidy these away.
        build_env_images(
            client,
            [raw],
            force_rebuild=False,
            max_workers=1,
            namespace=None,
            instance_image_tag="latest",
            env_image_tag="latest",
        )
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
