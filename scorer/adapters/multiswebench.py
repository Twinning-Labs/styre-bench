"""MultiSweBenchAdapter: wraps the `multi-swe-bench` PyPI harness (ByteDance
Seed Team, https://github.com/multi-swe-bench/multi-swe-bench).

PACKAGE PIN (confirmed, not guessed): `pip install multi-swe-bench` resolves
to PyPI project `multi-swe-bench` (import name `multi_swe_bench`), currently
`1.1.2`. Verified in this build by downloading and inspecting the actual wheel
(`multi_swe_bench-1.1.2-py3-none-any.whl`) -- the report/dataclass shapes
below are read directly from that package's source
(`multi_swe_bench/harness/{report,test_result,pull_request,run_evaluation}.py`),
NOT from web search or memory. `scorer/requirements.txt` pins it.

CONFIRMED report shape (per-instance `report.json`, `Report` dataclass in
`multi_swe_bench/harness/report.py`):
```
{
  "org": str, "repo": str, "number": int,
  "valid": bool,                # overall resolved-equivalent verdict
  "error_msg": str,
  "fixed_tests": {test_id: {"run": TestStatus, "test": TestStatus, "fix": TestStatus}, ...},
  "p2p_tests": {...}, "f2p_tests": {...}, "s2p_tests": {...}, "n2p_tests": {...},
  "run_result": TestResult, "test_patch_result": TestResult, "fix_patch_result": TestResult
}
```
where `TestResult` (`multi_swe_bench/harness/test_result.py`) is:
```
{"passed_count": int, "failed_count": int, "skipped_count": int,
 "passed_tests": [test_id, ...], "failed_tests": [...], "skipped_tests": [...]}
```
`valid` is computed by `Report.check()`: False if the fix patch produced zero
test results, if any PASS_TO_PASS regressed (test passed pre-fix, failed
post-fix), or if no FAIL_TO_PASS test transitioned to passing. The `f2p_tests`/
`p2p_tests`/etc buckets on the report are ONLY populated when `check()` reaches
that far (i.e. often EMPTY on an invalid/failed report) -- see DESIGN DECISION
below for why this adapter does not rely on them directly.

This also CONFIRMS two assumptions `orchestrator/corpus.ts` flagged as
unconfirmed for Task 3 to verify (both corrected here, in comments only --
corpus.ts's actual parsing logic already matched):
  - `f2p_tests`/`p2p_tests` on a record ARE dicts keyed by fully-qualified test
    id (matches `testNamesFromDict`'s `Object.keys()` assumption exactly --
    `corpus.ts`'s own logic never reads the *values*, so it's correct
    regardless of whether those values are the `{run,test,fix}` triples the
    harness's Report uses or the raw HF dataset's own possibly-simpler shape).
  - `base.sha` IS the real field name for the PR's base commit
    (`multi_swe_bench.harness.pull_request.Base(label, ref, sha)`), confirming
    `readBaseCommit`'s primary lookup path.

DESIGN DECISION (grounded in the source above): rather than trusting the
report's `f2p_tests`/`p2p_tests` buckets (which the harness leaves EMPTY on an
invalid report, before it would otherwise reach the bucketing step in
`check()`), this adapter derives the per-test-id fail_to_pass/pass_to_pass
verdicts directly from `fix_patch_result.{passed_tests,failed_tests,skipped_tests}`
-- those `TestResult` sets are ALWAYS populated (populated before `check()`
runs), so this works whether or not the overall run was "valid". A target test
id absent from `fix_patch_result` entirely defaults to `False` (fail-closed --
never silently "passed").

ASSUMPTION (verify at live pass, genuinely unconfirmed from static reading):
  - This adapter's internal instance id (`org/repo:pr-<number>`, from
    `PullRequestBase.id`) differs from the corpus's `instance_id` field used
    by `orchestrator/corpus.ts`'s normalized `Instance.id` (e.g.
    `sindresorhus__is-odd-42` in the Task-2 fixture). `instance["id"]` as
    handed to this adapter from TS is therefore NOT directly usable as the
    harness's instance id -- `_org_repo_number` now PREFERS the `org`/
    `repo_name`/`pr_number` fields `normalizeMultiSweBench` populates directly
    on the Instance (it already reads all three off the raw record to build
    the image tag), and only falls back to parsing `instance["repo"]` +
    `instance["id"].rsplit("-", 1)` when those fields are absent (e.g. an
    older hand-built instance dict). The org/repo_name/pr_number values
    themselves still trace back to the same raw-record fields as the
    fallback parse, so this is a robustness fix (no more fragile id-parsing
    in the common case), not yet a live-verified mapping -- still confirm
    against a real Multi-SWE-bench dataset sample before the live pass
    trusts it fully.
  - The harness's CLI (`python -m multi_swe_bench.harness.run_evaluation
    --mode evaluation ...`) expects a running `nix_swe` base container
    (`docker run --name nix_swe mswebench/nix_swe:v1.0`) as an implicit
    dependency (seen in the package's own `__main__` block) -- not yet wired
    up here; the live pass must provision it before invoking this adapter.
  - Predictions are supplied via `--patch_files` (glob of JSON files shaped
    like `Patch(PullRequestBase)` = `{org, repo, number, fix_patch}`), and the
    per-instance output lands at
    `<workdir>/<org>/<repo>/<EVALUATION_WORKDIR>/<instance.dependency().workdir()>/report.json`
    -- `instance.dependency().workdir()` is an MSB-internal path segment this
    adapter has not resolved without a live `Instance`/`Image` construction;
    treat the exact output path as unconfirmed until checked against a real run.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from .base import OracleAdapter

_SELF_TEST_TIMEOUT_S = 300

# Ceiling for one `run_evaluation` harness invocation (subprocess). Without a
# timeout, a hung/wedged harness (stuck container, deadlocked build, etc.)
# blocks the whole scorer run forever. 1800s (30min) roughly matches styre's
# verify-step budget ballpark. On expiry, subprocess.TimeoutExpired propagates
# unmodified (fail-closed): the instance is dropped, never scored.
HARNESS_TIMEOUT_SEC = 1800


MSB_DATASET = "ByteDance-Seed/Multi-SWE-bench"
_RAW_CACHE: dict[str, dict[str, Any]] = {}


def parse_instance_id(instance_id: str) -> tuple[str, str, int]:
    """`<org>__<repo>-<number>` -> (org, repo, number).

    The FIREWALL payload carries only an instance id and a language, so org/repo/number cannot be
    read off the instance dict — every other route needs corpus fields the payload is forbidden to
    contain (`.github/workflows/score.yml` actively rejects them).
    """
    head, sep, number_str = instance_id.rpartition("-")
    if not sep or not number_str.isdigit():
        raise ValueError(
            f"multi-swe-bench: instance id {instance_id!r} does not end in '-<number>'"
        )
    org, sep2, repo = head.partition("__")
    if not sep2 or not org or not repo:
        raise ValueError(
            f"multi-swe-bench: instance id {instance_id!r} is not '<org>__<repo>-<number>'"
        )
    return org, repo, int(number_str)


def _raw_instance(instance_id: str, language: str = "ts") -> dict[str, Any]:
    """Fetch the corpus record for `instance_id` from the PUBLIC Multi-SWE-bench dataset.

    WHY THIS EXISTS. The adapter previously read `instance["f2p_tests"]`, `instance["fix_patch"]`
    and friends straight off the dict it was handed, and wrote that dict out as the harness
    dataset. That cannot work behind the firewall: the payload is `{instance: {id, language},
    candidate_diff}` and nothing else, so those keys are simply absent and scoring dies with a
    KeyError before the harness starts. `SweBenchAdapter` already solves this by re-fetching from
    Hugging Face; this is the same move for MSB.

    Only the ONE repo file is downloaded (`<language>/<org>__<repo>_dataset.jsonl`), not the whole
    multilingual dataset — the instance id names the repo, so there is no reason to pull the rest.

    `language` is the dataset's own subdirectory. MSB publishes nine (c, cpp, go, java, js,
    kotlin, python, rust, ts) and this repo currently only routes `ts` (`corpus.ts` hardcodes it,
    and `bench.config.ts` pins `tsCorpus` to multi-swe-bench), but taking it as a parameter means
    adding another language is a corpus change rather than an adapter change. A wrong or
    unpublished language fails loudly with the list of real ones instead of 404-ing opaquely.
    """
    cache_key = f"{language}/{instance_id}"
    if cache_key in _RAW_CACHE:
        return _RAW_CACHE[cache_key]
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import EntryNotFoundError

    org, repo, number = parse_instance_id(instance_id)
    fname = f"{language}/{org}__{repo}_dataset.jsonl"
    try:
        local = hf_hub_download(MSB_DATASET, fname, repo_type="dataset")
    except EntryNotFoundError as exc:
        raise ValueError(
            f"multi-swe-bench: {fname} not found in {MSB_DATASET}. Either language "
            f"{language!r} is not one this dataset publishes, or {org}/{repo} is not in it."
        ) from exc
    with open(local, encoding="utf8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("number") == number:
                _RAW_CACHE[cache_key] = record
                return record
    raise ValueError(
        f"multi-swe-bench: PR #{number} not found in {fname} of {MSB_DATASET} "
        f"(instance_id={instance_id!r})"
    )


def test_ids(bucket: Any) -> list[str]:
    """MSB stores f2p/p2p as a DICT keyed by test id, not a list.

    `parse_report` takes id lists, so passing the dict straight through would iterate its keys by
    accident in some places and fail in others. Normalised here, once.
    """
    if isinstance(bucket, dict):
        return list(bucket.keys())
    if isinstance(bucket, list):
        return [t for t in bucket if isinstance(t, str)]
    return []


def parse_report(report: dict[str, Any], fail_to_pass_ids: list[str], pass_to_pass_ids: list[str]) -> dict[str, Any]:
    """Pure parser: multi-swe-bench's report.json -> {"resolved","fail_to_pass","pass_to_pass"}.

    FAIL-CLOSED: raises on a missing/malformed report or a missing/non-bool
    `valid` key. A `valid: True` claim with no `fix_patch_result` evidence also
    raises. A target test id absent from the post-fix result defaults to
    `False`, never silently `True`.
    """
    if not isinstance(report, dict):
        raise ValueError(f"multi-swe-bench: report is not a dict (got {type(report).__name__})")

    resolved = report.get("valid")
    if not isinstance(resolved, bool):
        raise ValueError(
            f"multi-swe-bench: report is missing a boolean 'valid' key (got {resolved!r}) -- "
            f"treating as a harness/report error, not a verdict"
        )

    fix_result = report.get("fix_patch_result")
    if resolved and not isinstance(fix_result, dict):
        raise ValueError(
            "multi-swe-bench: report claims valid=True but has no 'fix_patch_result' evidence "
            "-- refusing to trust an unsupported resolved claim"
        )
    if not isinstance(fix_result, dict):
        # Legitimate on an invalid/errored run: no id-list data, resolved must be False.
        fix_result = {}

    passed_tests = fix_result.get("passed_tests", [])
    failed_tests = fix_result.get("failed_tests", [])
    if fix_result and not (isinstance(passed_tests, list) and isinstance(failed_tests, list)):
        raise ValueError(
            "multi-swe-bench: fix_patch_result.passed_tests/failed_tests must both be lists "
            f"(got passed={type(passed_tests).__name__}, failed={type(failed_tests).__name__})"
        )
    passed = set(passed_tests)

    def verdict(test_id: str) -> bool:
        # Fail-closed: only an explicit appearance in passed_tests counts as passed.
        # Missing entirely, or present in failed_tests/skipped_tests, is False.
        return test_id in passed

    fail_to_pass = {t: verdict(t) for t in fail_to_pass_ids}
    pass_to_pass = {t: verdict(t) for t in pass_to_pass_ids}
    return {"resolved": resolved, "fail_to_pass": fail_to_pass, "pass_to_pass": pass_to_pass}


class MultiSweBenchAdapter(OracleAdapter):
    """Wraps the `multi_swe_bench.harness.run_evaluation` CLI (mode=evaluation).

    Confirmed end-to-end against a live image on 2026-09-11
    (`mswebench/darkreader_m_darkreader:pr-7241`: 2/2 FAIL_TO_PASS, 45/45 PASS_TO_PASS),
    so the instance-id mapping and output-path resolution below are measured, not assumed.
    In-process unit coverage is still `parse_report` plus the shared conformance suite; the
    Docker-touching methods run only under the `RUN_LIVE` gate.
    """

    def preflight(self) -> None:
        """Import the harness this adapter otherwise only ever runs as a subprocess.

        This is the whole reason `preflight` exists. `run_controls` shells out to
        `python -m multi_swe_bench.harness.run_evaluation`, so an unrunnable harness is
        invisible to this process until that subprocess dies -- which on macOS it always does:
        the `multi_swe_bench` wheel ships BOTH `repos/python/Qiskit/` and `repos/python/qiskit/`,
        and a case-insensitive filesystem collapses them into one directory, so
        `Qiskit/qiskit/` never exists and the import fails outright. Linux is case-sensitive
        and the problem does not arise. Hence: run the matrix on Linux.
        """
        try:
            import multi_swe_bench.harness.run_evaluation  # noqa: F401
        except Exception as exc:  # noqa: BLE001 - report the cause, whatever it is
            raise RuntimeError(
                f"the multi-swe-bench harness is not runnable on this host "
                f"({type(exc).__name__}: {exc}). On macOS this is expected and unfixable here: "
                f"the wheel ships case-colliding `Qiskit/` and `qiskit/` directories that a "
                f"case-insensitive filesystem merges. Run the matrix on Linux — "
                f"`./infra/provision-bench-host.sh create` provisions a host that can."
            ) from exc

    def _org_repo_number(self, instance: dict[str, Any]) -> tuple[str, str, int]:
        # PREFERRED PATH: `orchestrator/corpus.ts`'s `normalizeMultiSweBench` now populates
        # `org`/`repo_name`/`pr_number` directly on the normalized Instance (it already reads
        # all three off the raw record to build the image tag) -- use them verbatim when
        # present, no re-parsing needed.
        org = instance.get("org")
        repo = instance.get("repo_name")
        number = instance.get("pr_number")
        if isinstance(org, str) and org and isinstance(repo, str) and repo and isinstance(number, int):
            return org, repo, number

        # FALLBACK (KNOWN-BROKEN, see module docstring): older/hand-built instance dicts that
        # predate the org/repo_name/pr_number fields (e.g. this repo's own test fixtures) --
        # reconstruct from instance["repo"] ("org/repo" per corpus.ts) and a PR number parsed
        # off the trailing id segment. ASSUMPTION about id format is unconfirmed against a live
        # dataset; fix at live pass if it's wrong.
        org, _, repo = instance["repo"].partition("/")
        if not org or not repo:
            raise ValueError(f"multi-swe-bench: cannot split instance repo {instance['repo']!r} into org/repo")
        number_str = instance["id"].rsplit("-", 1)[-1]
        if not number_str.isdigit():
            raise ValueError(
                f"multi-swe-bench: could not parse a PR number off instance id {instance['id']!r} "
                f"-- ASSUMPTION about id format is wrong, fix at live pass"
            )
        return org, repo, int(number_str)

    def _run_harness(self, instance: dict[str, Any], candidate_diff: str) -> dict[str, Any]:
        import subprocess
        import sys
        import tempfile

        raw = _raw_instance(instance["id"], instance.get("language") or "ts")
        org, repo, number = raw["org"], raw["repo"], raw["number"]
        run_dir = Path(tempfile.mkdtemp(prefix="styre-bench-msb-"))
        patch_file = run_dir / "patch.json"
        patch_file.write_text(
            json.dumps({"org": org, "repo": repo, "number": number, "fix_patch": candidate_diff or ""})
            + "\n"
        )
        dataset_file = run_dir / "dataset.json"
        # The harness needs the FULL corpus record (base sha, test_patch, test lists); the
        # firewall payload carries none of it, so the fetched record is what goes here.
        #
        # JSONL, NOT a JSON array. `CliArgs.dataset` reads the file line by line and calls
        # `Dataset.from_json(line)` on each, so an array makes the first (only) line a list and
        # the harness dies with `AttributeError: 'list' object has no attribute 'items'`. Same
        # for `--patch_files`, which `patches` reads the same way -- a single object on one line
        # is already valid JSONL there.
        dataset_file.write_text(json.dumps(raw) + "\n")
        output_dir = run_dir / "output"
        output_dir.mkdir()
        # The harness REQUIRES workdir and repo_dir to already exist -- `_check_workdir` and
        # `_check_repo_dir` raise `ValueError: ... not found` rather than creating them, unlike
        # `_check_output_dir` / `_check_log_dir` which mkdir on demand. Creating only `output`
        # meant every invocation died before the harness started:
        #     ValueError: Workdir not found: /tmp/styre-bench-msb-.../work
        (run_dir / "work").mkdir(parents=True, exist_ok=True)
        (run_dir / "repo").mkdir(parents=True, exist_ok=True)
        cmd = [
            sys.executable,
            "-m",
            "multi_swe_bench.harness.run_evaluation",
            "--mode",
            "evaluation",
            "--workdir",
            str(run_dir / "work"),
            "--patch_files",
            str(patch_file),
            "--dataset_files",
            str(dataset_file),
            "--repo_dir",
            str(run_dir / "repo"),
            "--output_dir",
            str(output_dir),
            "--log_dir",
            str(run_dir / "logs"),
        ]
        # No except around this: subprocess.TimeoutExpired must propagate
        # unmodified (fail-closed) -- never swallow a hang into a fake verdict.
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=HARNESS_TIMEOUT_SEC)
        if result.returncode != 0:
            raise RuntimeError(
                f"multi-swe-bench: harness invocation failed (exit {result.returncode}) for "
                f"{instance['id']!r}:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )

        # ASSUMPTION (see module docstring): exact per-instance report.json path
        # under output_dir/workdir is not yet confirmed against a live run.
        report_candidates = list(run_dir.glob("**/report.json"))
        if not report_candidates:
            raise RuntimeError(
                f"multi-swe-bench: no report.json produced under {run_dir} for {instance['id']!r} "
                f"-- harness ran but emitted no report (treat as harness error, not a verdict)"
            )
        report = json.loads(report_candidates[0].read_text())
        return parse_report(report, test_ids(raw.get("f2p_tests")), test_ids(raw.get("p2p_tests")))

    def score(self, instance: dict[str, Any], candidate_diff: str) -> dict[str, Any]:
        return self._run_harness(instance, candidate_diff)

    def run_controls(self, instance: dict[str, Any]) -> dict[str, bool]:
        # Same firewall reason as `score`: the gold patch is never in the payload, so it comes
        # from the fetched corpus record.
        gold = self.score(
            instance, _raw_instance(instance["id"], instance.get("language") or "ts")["fix_patch"]
        )
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

        # ASSUMPTION (verify at live pass): `jest <paths>` is a reasonable default
        # test-runner invocation for a TS/JS instance's own added test file(s), but
        # the real per-repo test command (npm/yarn/pnpm test runner, config location)
        # is not confirmed here -- this raises rather than silently invoking a
        # runner that might not exist in the image.
        raise NotImplementedError(
            "multi-swe-bench: run_self_test's one-file jest invocation is not yet wired to a "
            "confirmed per-repo test command -- implement against a real Multi-SWE-bench image "
            "at the live pass rather than guessing a runner that may not match the repo"
        )
