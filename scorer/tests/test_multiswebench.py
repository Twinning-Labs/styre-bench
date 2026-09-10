"""Tests for `adapters/multiswebench.py`.

Two tiers (see test_swebench.py's docstring for the same split):
  - Unit tests (no Docker, no network): exercise the pure `parse_report`
    function against fixture report JSON captured from the CONFIRMED
    `multi-swe-bench==1.1.2` report shape (see adapters/multiswebench.py's
    module docstring for where that shape was verified). These always run.
  - `run_live` tests: exercise `MultiSweBenchAdapter.run_controls`/`score`/
    `run_self_test` against a real Docker image. Gated behind `RUN_LIVE`.
    NOTE: several MSB integration details remain flagged ASSUMPTIONs (see the
    adapter's module docstring) -- these live tests are expected to need
    fixing, not just enabling, at the operator's live pass.
"""

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from adapters.multiswebench import MultiSweBenchAdapter, parse_report

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _instance() -> dict:
    return _load("msb_instance.json")


# -- unit tests: pure report parser (no Docker) ------------------------------


def test_parse_report_resolved_maps_fail_to_pass_and_pass_to_pass():
    report = _load("msb_report_resolved.json")
    result = parse_report(
        report,
        fail_to_pass_ids=["test.js::negative odd numbers"],
        pass_to_pass_ids=["test.js::positive odd numbers", "test.js::even numbers"],
    )
    assert result["resolved"] is True
    assert result["fail_to_pass"] == {"test.js::negative odd numbers": True}
    assert result["pass_to_pass"] == {
        "test.js::positive odd numbers": True,
        "test.js::even numbers": True,
    }


def test_parse_report_empty_candidate_is_unresolved_and_fail_to_pass_still_fails():
    report = _load("msb_report_unresolved.json")
    result = parse_report(
        report,
        fail_to_pass_ids=["test.js::negative odd numbers"],
        pass_to_pass_ids=["test.js::positive odd numbers", "test.js::even numbers"],
    )
    assert result["resolved"] is False
    assert result["fail_to_pass"] == {"test.js::negative odd numbers": False}
    assert result["pass_to_pass"] == {
        "test.js::positive odd numbers": True,
        "test.js::even numbers": True,
    }


@pytest.mark.parametrize(
    "fixture_name",
    [
        "msb_report_error_missing_valid.json",
        "msb_report_error_unsupported_resolved.json",
        "msb_report_error_empty.json",
    ],
)
def test_parse_report_raises_on_error_report_never_resolved(fixture_name):
    report = _load(fixture_name)
    with pytest.raises(ValueError):
        parse_report(report, fail_to_pass_ids=["test.js::negative odd numbers"], pass_to_pass_ids=[])


def test_parse_report_missing_target_test_id_defaults_false_not_true():
    """A fail_to_pass id the harness never mentions at all must never read as passed."""
    report = _load("msb_report_resolved.json")
    result = parse_report(
        report,
        fail_to_pass_ids=["test.js::some test the harness never ran"],
        pass_to_pass_ids=[],
    )
    assert result["fail_to_pass"] == {"test.js::some test the harness never ran": False}


def test_parse_report_raises_on_non_dict_report():
    """Mirrors test_swebench.py's equivalent -- test symmetry (Task-3 review)."""
    with pytest.raises(ValueError):
        parse_report(["not", "a", "dict"], fail_to_pass_ids=[], pass_to_pass_ids=[])  # type: ignore[arg-type]


# -- _org_repo_number: prefer corpus.ts's org/repo_name/pr_number, fall back to id-parse ------


def test_org_repo_number_prefers_explicit_fields_over_id_parse():
    """When `orchestrator/corpus.ts`'s normalizeMultiSweBench-populated org/repo_name/pr_number
    are present, use them directly -- even if they'd disagree with what an id-parse would
    produce (proves the explicit fields win, not just that they're consistent)."""
    adapter = MultiSweBenchAdapter()
    inst = {
        "id": "some-other-instance-id-999",
        "repo": "wrong-org/wrong-repo",
        "org": "sindresorhus",
        "repo_name": "is-odd",
        "pr_number": 42,
    }
    assert adapter._org_repo_number(inst) == ("sindresorhus", "is-odd", 42)


def test_org_repo_number_falls_back_to_id_parse_when_explicit_fields_absent():
    """Older/hand-built instance dicts (e.g. this repo's own fixtures) that predate the
    org/repo_name/pr_number fields must still work via the KNOWN-BROKEN-UNTIL-LIVE fallback."""
    adapter = MultiSweBenchAdapter()
    inst = _instance()
    assert "org" not in inst and "repo_name" not in inst and "pr_number" not in inst
    assert adapter._org_repo_number(inst) == ("sindresorhus", "is-odd", 42)


def test_org_repo_number_falls_back_when_explicit_fields_are_partial():
    """A partially-populated set (e.g. org present but pr_number missing/wrong-typed) must not
    be trusted piecemeal -- fall back to the id-parse rather than raising or guessing."""
    adapter = MultiSweBenchAdapter()
    inst = {
        "id": "sindresorhus__is-odd-42",
        "repo": "sindresorhus/is-odd",
        "org": "sindresorhus",
        # repo_name/pr_number deliberately absent
    }
    assert adapter._org_repo_number(inst) == ("sindresorhus", "is-odd", 42)


def test_run_harness_propagates_subprocess_timeout_not_swallowed():
    """A hung harness invocation must raise TimeoutExpired (fail-closed: the
    instance is dropped, never scored) -- not hang forever or be swallowed
    into a fake verdict."""
    adapter = MultiSweBenchAdapter()
    inst = _instance()
    # `_raw_instance` now fetches the corpus record from Hugging Face (the firewall payload cannot
    # carry it). Stub it so this test stays offline and keeps testing the timeout, not the network.
    with patch(
        "adapters.multiswebench._raw_instance",
        return_value={"org": "o", "repo": "r", "number": 1, "f2p_tests": {}, "p2p_tests": {}},
    ):
        with patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired(
                cmd="multi_swe_bench.harness.run_evaluation", timeout=1800
            ),
        ):
            with pytest.raises(subprocess.TimeoutExpired):
                adapter._run_harness(inst, "")


# -- run_live tests: real harness + Docker -----------------------------------

_run_live = pytest.mark.skipif(
    not os.environ.get("RUN_LIVE"),
    reason="requires Docker + the multi-swe-bench eval image; gated for the operator's live "
    "pass -- multiple ASSUMPTIONs in adapters/multiswebench.py need live verification first",
)


@_run_live
def test_run_controls_gold_resolves_base_fails_deterministic():
    adapter = MultiSweBenchAdapter()
    result = adapter.run_controls(_instance())
    assert result["gold_resolved"] is True
    assert result["base_fails"] is True
    assert result["deterministic"] is True


@_run_live
def test_score_gold_patch_resolves():
    adapter = MultiSweBenchAdapter()
    inst = _instance()
    result = adapter.score(inst, inst["fix_patch"])
    assert result["resolved"] is True


@_run_live
def test_score_empty_candidate_does_not_resolve():
    adapter = MultiSweBenchAdapter()
    result = adapter.score(_instance(), "")
    assert result["resolved"] is False


@_run_live
def test_run_self_test_with_no_added_test_returns_none():
    adapter = MultiSweBenchAdapter()
    inst = _instance()
    result = adapter.run_self_test(inst, inst["fix_patch"], [])
    assert result == {"passed": None}


@_run_live
def test_run_self_test_with_passing_added_test():
    """Documents the required behavior per the Task 3 spec. As of this build,
    `MultiSweBenchAdapter.run_self_test` with a non-empty `added_test_paths`
    deliberately raises `NotImplementedError` (see adapters/multiswebench.py's
    module docstring) rather than guess an unconfirmed per-repo jest
    invocation -- this test documents the target contract for the live pass
    to implement against, and is expected to fail loudly (not silently pass)
    until that's done."""
    adapter = MultiSweBenchAdapter()
    inst = _instance()
    result = adapter.run_self_test(inst, inst["fix_patch"], ["test.js::negative odd numbers"])
    assert result == {"passed": True}


# -- firewall-payload compatibility -------------------------------------------


def test_parse_instance_id_splits_org_repo_number():
    from adapters.multiswebench import parse_instance_id

    assert parse_instance_id("darkreader__darkreader-7241") == ("darkreader", "darkreader", 7241)
    assert parse_instance_id("mui__material-ui-39962") == ("mui", "material-ui", 39962)


def test_parse_instance_id_rejects_malformed_ids():
    from adapters.multiswebench import parse_instance_id

    for bad in ["darkreader__darkreader", "darkreader-7241", "no-separator-x", ""]:
        with pytest.raises(ValueError):
            parse_instance_id(bad)


def test_parse_instance_id_keeps_a_hyphenated_repo_name_intact():
    # `mui__material-ui-39962` must not split on the FIRST hyphen — the repo name has one.
    from adapters.multiswebench import parse_instance_id

    org, repo, number = parse_instance_id("mui__material-ui-39962")
    assert repo == "material-ui"
    assert number == 39962


def test_test_ids_normalises_the_dict_shape_msb_actually_uses():
    # MSB stores f2p/p2p as a DICT keyed by test id ({"path:name": {"run":..,"test":..,"fix":..}}),
    # while parse_report takes id LISTS. Passing the dict straight through silently misreads it.
    from adapters.multiswebench import test_ids

    assert test_ids({"a.ts:x": {"fix": "PASS"}, "b.ts": {"fix": "PASS"}}) == ["a.ts:x", "b.ts"]
    assert test_ids(["a.ts:x"]) == ["a.ts:x"]
    assert test_ids(None) == []
    assert test_ids({}) == []


def test_score_uses_the_FETCHED_record_not_the_payload():
    """The firewall payload is `{id, language}` only — every corpus field must come from the fetch.

    Before this, the adapter read `instance["f2p_tests"]` / `instance["fix_patch"]` off the dict it
    was handed and wrote that dict out as the harness dataset, so scoring died with a KeyError
    behind the firewall before the harness even started.
    """
    adapter = MultiSweBenchAdapter()
    raw = {
        "org": "darkreader",
        "repo": "darkreader",
        "number": 7241,
        "base": {"sha": "abc"},
        "f2p_tests": {"tests/x.tests.ts:case": {"fix": "PASS"}},
        "p2p_tests": {"tests/y.tests.ts": {"fix": "PASS"}},
    }
    seen: dict = {}

    def fake_run(cmd, **kwargs):
        # capture the dataset the harness was handed
        idx = cmd.index("--dataset_files")
        # JSONL now: one record per line, not an array.
        seen["dataset"] = [json.loads(l) for l in open(cmd[idx + 1]).read().splitlines() if l.strip()]
        raise subprocess.TimeoutExpired(cmd="x", timeout=1)

    with patch("adapters.multiswebench._raw_instance", return_value=raw):
        with patch("subprocess.run", side_effect=fake_run):
            with pytest.raises(subprocess.TimeoutExpired):
                # NOTE: only id + language, exactly what the firewall permits
                adapter._run_harness({"id": "darkreader__darkreader-7241", "language": "ts"}, "d")
    assert seen["dataset"] == [raw], "the harness must receive the FETCHED record"


def test_run_harness_creates_the_dirs_the_harness_REQUIRES_to_exist():
    """`workdir` and `repo_dir` must pre-exist; the harness raises rather than creating them.

    `_check_output_dir` / `_check_log_dir` mkdir on demand, but `_check_workdir` and
    `_check_repo_dir` do not -- so creating only `output` killed every invocation with
    "ValueError: Workdir not found" before the harness started.
    """
    adapter = MultiSweBenchAdapter()
    seen: dict = {}

    def fake_run(cmd, **kwargs):
        for flag in ("--workdir", "--repo_dir", "--output_dir", "--log_dir"):
            seen[flag] = Path(cmd[cmd.index(flag) + 1])
        raise subprocess.TimeoutExpired(cmd="x", timeout=1)

    raw = {"org": "o", "repo": "r", "number": 1, "f2p_tests": {}, "p2p_tests": {}}
    with patch("adapters.multiswebench._raw_instance", return_value=raw):
        with patch("subprocess.run", side_effect=fake_run):
            with pytest.raises(subprocess.TimeoutExpired):
                adapter._run_harness({"id": "o__r-1", "language": "ts"}, "d")

    assert seen["--workdir"].is_dir(), "workdir must exist before the harness runs"
    assert seen["--repo_dir"].is_dir(), "repo_dir must exist before the harness runs"


def test_dataset_and_patch_files_are_JSONL_not_json_arrays():
    """The harness reads both files LINE BY LINE (`Dataset.from_json(line)` / `Patch.from_json`).

    A JSON array makes the first line a list, and the harness dies with
    `AttributeError: 'list' object has no attribute 'items'` — which is exactly how the second
    live scoring attempt failed.
    """
    adapter = MultiSweBenchAdapter()
    seen: dict = {}

    def fake_run(cmd, **kwargs):
        for flag in ("--dataset_files", "--patch_files"):
            seen[flag] = Path(cmd[cmd.index(flag) + 1]).read_text()
        raise subprocess.TimeoutExpired(cmd="x", timeout=1)

    raw = {"org": "o", "repo": "r", "number": 1, "f2p_tests": {}, "p2p_tests": {}}
    with patch("adapters.multiswebench._raw_instance", return_value=raw):
        with patch("subprocess.run", side_effect=fake_run):
            with pytest.raises(subprocess.TimeoutExpired):
                adapter._run_harness({"id": "o__r-1", "language": "ts"}, "d")

    for flag, text in seen.items():
        lines = [ln for ln in text.splitlines() if ln.strip()]
        assert len(lines) == 1, f"{flag}: expected exactly one JSONL record"
        parsed = json.loads(lines[0])
        assert isinstance(parsed, dict), f"{flag}: each line must be an OBJECT, not a list"
    assert json.loads([l for l in seen["--dataset_files"].splitlines() if l.strip()][0]) == raw
