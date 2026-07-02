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


def test_run_harness_propagates_subprocess_timeout_not_swallowed():
    """A hung harness invocation must raise TimeoutExpired (fail-closed: the
    instance is dropped, never scored) -- not hang forever or be swallowed
    into a fake verdict."""
    adapter = MultiSweBenchAdapter()
    inst = _instance()
    with patch(
        "subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="multi_swe_bench.harness.run_evaluation", timeout=1800),
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
