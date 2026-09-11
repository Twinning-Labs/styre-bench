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
import sys
import uuid
from pathlib import Path
from typing import Any

from .base import OracleAdapter
from .nix_swe import ensure_nix_swe, nix_swe_failure_hint

_SELF_TEST_TIMEOUT_S = 300

# TWO BUDGETS, NOT ONE (ENG-431).
#
# The harness builds images and then evaluates, in a single invocation, and both used to share
# one 1800s ceiling. On `mui__material-ui-39108` the build ran 04:05:09 -> 04:21:52 -- 15m43s,
# more than half the budget -- leaving ~13 minutes for a suite that takes 11-18. It timed out,
# and the cell was recorded as infra with nothing measured. The evaluation was never the problem:
# a warm-image run of the same repo evaluated in 11 minutes inside the same ceiling.
#
# A budget shared between a one-time setup cost and the measurement itself is really a budget for
# neither. Images are now built by a separate `--mode image` invocation with its own ceiling, so
# the evaluation ceiling covers only evaluation.
#
# On expiry, subprocess.TimeoutExpired propagates unmodified from either phase (fail-closed): the
# instance is dropped, never scored. The phase is identifiable from the raised `cmd`.
IMAGE_BUILD_TIMEOUT_SEC = 3600
EVAL_TIMEOUT_SEC = 1800

#: Images already built in THIS process, keyed by instance id. The second gold run of
#: `run_controls` (ENG-430) would otherwise pay the build invocation again -- a no-op that still
#: costs ~60s of harness startup per call.
_IMAGES_BUILT: set[str] = set()


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


def _stage_counts(stage: Any) -> str:
    """`(passed, failed, skipped)` for a stage result, for error text. Never raises."""
    if not isinstance(stage, dict):
        return "no fix_patch_result at all"
    return (
        f"passed={stage.get('passed_count')}, failed={stage.get('failed_count')}, "
        f"skipped={stage.get('skipped_count')}"
    )


def _measured_nothing(stage: dict[str, Any]) -> bool:
    """True iff this stage captured zero test results (ENG-430).

    Reads the COUNTS first — that is what a real harness report carries, and what the
    `fix = (0, 0, 0)` summary is printed from. Falls back to the id-list lengths when no counts
    are present: a stage listing ten passed tests has plainly measured something, whatever it
    did or did not choose to count, and raising there would turn a legible verdict into an infra
    error over a missing field.

    Both empty means nothing ran. That is the only case this returns True for.
    """
    total = 0
    saw_count = False
    for key in ("passed_count", "failed_count", "skipped_count"):
        value = stage.get(key)
        if isinstance(value, int):
            saw_count = True
            total += value
    if saw_count:
        return total == 0
    listed = sum(
        len(stage.get(key) or [])
        for key in ("passed_tests", "failed_tests", "skipped_tests")
        if isinstance(stage.get(key), list)
    )
    return listed == 0


def f2p_fails_before_fix(raw: dict[str, Any]) -> bool:
    """Do the FAIL_TO_PASS tests genuinely fail with the test patch applied and no fix? (ENG-430)

    Read from the corpus's `test_patch_result` rather than measured here, because the harness
    will not measure it for us: it is handed `run_result`/`test_patch_result` in `dataset.json`
    and executes only the fix stage. This checks the corpus's own claim for coherence — every
    FAIL_TO_PASS test must be absent from the pre-fix passed set — which is a real check, just
    not an independent one.

    Fail-closed: an instance with no FAIL_TO_PASS tests, or no `test_patch_result` to check
    against, returns False and is dropped upstream. An unverifiable claim is not a passed control.
    """
    f2p = test_ids(raw.get("f2p_tests"))
    if not f2p:
        return False
    stage = raw.get("test_patch_result")
    if not isinstance(stage, dict):
        return False
    passed = stage.get("passed_tests")
    if not isinstance(passed, list):
        return False
    passed_set = set(passed)
    return all(t not in passed_set for t in f2p)


def parse_report(report: dict[str, Any], fail_to_pass_ids: list[str], pass_to_pass_ids: list[str]) -> dict[str, Any]:
    """Pure parser: multi-swe-bench's report.json -> {"resolved","fail_to_pass","pass_to_pass"}.

    FAIL-CLOSED: raises on a missing/malformed report or a missing/non-bool
    `valid` key. A `valid: True` claim with no `fix_patch_result` evidence also
    raises, as does a fix stage that captured NO test results at all (ENG-430) --
    "the harness could not measure this" is not a `resolved: False` verdict. A
    target test id absent from the post-fix result defaults to `False`, never
    silently `True`.
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
    # ENG-430: NOTHING MEASURED IS NOT A VERDICT.
    #
    # `valid: False` covers two completely different things, and the adapter used to record both
    # as `resolved: False`:
    #
    #   GOLD on mui-33777:  fix = (5828, 12, 754)   "Before applying the fix patch, the test
    #                                                passed; however, after ..."
    #   EMPTY candidate:    fix = (0, 0, 0)         "After applying the fix patch, no test
    #                                                results were captured when executing the
    #                                                test command."
    #
    # The first is a real verdict: 5,828 tests ran and a PASS_TO_PASS regressed. The second is
    # the harness telling us the test command produced no output at all — an infra failure
    # wearing a verdict's clothes. Scoring it `resolved: False` is exactly the fail-closed
    # violation `base.py` forbids, and it is how a candidate diff that breaks the build would be
    # recorded as "ran and did not resolve".
    #
    # Keyed on the COUNTS, not on `error_msg`: the counts are structural, the message is upstream
    # prose that can be reworded. The message is quoted in the error because it is the most
    # useful thing an operator can read.
    if not isinstance(fix_result, dict) or _measured_nothing(fix_result):
        raise ValueError(
            "multi-swe-bench: the fix stage captured NO test results "
            f"({_stage_counts(fix_result)}) -- the harness could not measure this candidate, "
            "which is a harness error and not a `resolved: False` verdict"
            + (f". Harness said: {report['error_msg'].splitlines()[0]}" if report.get("error_msg") else "")
        )

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
        # ENG-431: build FIRST, on its own clock. Once the images exist the evaluation
        # invocation's own build phase is a no-op, so `EVAL_TIMEOUT_SEC` is spent on evaluating.
        self._build_images_or_raise(instance["id"], run_dir, dataset_file)
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
        # ENG-419: create the harness's fixed-name `nix_swe` container BEFORE invoking it. The
        # harness does this itself with a check-then-act that is not concurrency-safe, and under
        # `concurrency: 3` two of three instances lost the race and exited 1 before evaluating
        # anything. Best-effort by contract -- see `ensure_nix_swe`; it never raises, so a Docker
        # problem still surfaces from the harness's own attempt rather than from here.
        outcome = ensure_nix_swe()
        if outcome.startswith("unavailable"):
            print(f"multi-swe-bench: could not pre-create nix_swe ({outcome})", file=sys.stderr)

        # No except around this: subprocess.TimeoutExpired must propagate
        # unmodified (fail-closed) -- never swallow a hang into a fake verdict.
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=EVAL_TIMEOUT_SEC)
        if result.returncode != 0:
            hint = nix_swe_failure_hint(result.stdout, result.stderr)
            raise RuntimeError(
                f"multi-swe-bench: harness invocation failed (exit {result.returncode}) for "
                f"{instance['id']!r}:"
                + (f"\n{hint}" if hint else "")
                + f"\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
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

    def _build_images_or_raise(self, instance_id: str, run_dir: Any, dataset_file: Any) -> None:
        """Build this instance's images in their own invocation, on their own clock (ENG-431).

        `--mode image` is the harness's own build-only entrypoint. Running it first means the
        evaluation invocation finds its images present and spends `EVAL_TIMEOUT_SEC` evaluating
        rather than sharing it with a 15-minute build.

        Skipped for an instance already built in this process: `run_controls` scores gold twice
        (ENG-430), and the second call would otherwise pay ~60s of harness startup to be told the
        images are there.
        """
        import subprocess

        if instance_id in _IMAGES_BUILT:
            return
        cmd = [
            sys.executable,
            "-m",
            "multi_swe_bench.harness.run_evaluation",
            "--mode",
            "image",
            "--workdir",
            str(run_dir / "work"),
            "--dataset_files",
            str(dataset_file),
            "--repo_dir",
            str(run_dir / "repo"),
            "--output_dir",
            str(run_dir / "output"),
            "--log_dir",
            str(run_dir / "logs"),
        ]
        # Same fail-closed contract as the evaluation phase: a TimeoutExpired here propagates
        # unmodified rather than being folded into a verdict.
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=IMAGE_BUILD_TIMEOUT_SEC
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"multi-swe-bench: image build failed (exit {result.returncode}) for "
                f"{instance_id!r} -- no evaluation was attempted, so this is a build failure and "
                f"not a verdict.\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )
        _IMAGES_BUILT.add(instance_id)

    def run_controls(self, instance: dict[str, Any]) -> dict[str, bool]:
        """MSB's controls, re-derived (ENG-430).

        THE EMPTY-CANDIDATE CONTROL DOES NOT WORK HERE, and the 2026-09-11 matrix proved it. The
        old implementation scored `""` twice and read `base_fails` and `deterministic` off the
        results. Both were vacuously true, for two compounding reasons:

          1. The harness only EXECUTES the fix stage. We hand it `dataset.json` built from the
             corpus record, which already carries `run_result` and `test_patch_result`; it reads
             those and runs only the third stage. So an empty candidate never exercises the base
             at all — it finished in ~60 seconds against gold's ~20 minutes.
          2. An empty patch therefore produces `fix = (0, 0, 0)` — no test results captured. Two
             such runs agree with each other trivially, which is what `deterministic` was
             reading. Since ENG-430 that is a raise, not a False, so the old code would now blow
             up rather than quietly report nothing.

        `base_fails` is now computed from the corpus's own `test_patch_result`: the FAIL_TO_PASS
        tests must NOT be passing with the test patch applied and no fix. That is a real check of
        a real claim — it is just the corpus's measurement rather than ours, and it is the only
        one available, because the harness will not re-run that stage for us. Said out loud below
        rather than left for a reader to infer from a `True`.

        `deterministic` is now GOLD run twice. That measures the thing that actually threatens
        these instances — mui's `preset-safe` codemod tests, which failed at gold on two
        unrelated instances — where two empty runs measured nothing. It costs a second gold run
        (~20 minutes on mui) and removes two ~60-second runs that told us nothing.
        """
        raw = _raw_instance(instance["id"], instance.get("language") or "ts")
        gold_a = self.score(instance, raw["fix_patch"])
        gold_b = self.score(instance, raw["fix_patch"])
        deterministic = (
            gold_a["resolved"] == gold_b["resolved"]
            and gold_a["fail_to_pass"] == gold_b["fail_to_pass"]
            and gold_a["pass_to_pass"] == gold_b["pass_to_pass"]
        )
        base_fails = f2p_fails_before_fix(raw)
        print(
            f"[controls] multi-swe-bench {instance['id']}: base_fails={base_fails} is read from "
            "the corpus's own test_patch_result -- the harness executes only the fix stage, so it "
            "is not re-measured here",
            file=sys.stderr,
        )
        return {
            "gold_resolved": gold_a["resolved"] is True and gold_b["resolved"] is True,
            "base_fails": base_fails,
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
