"""Tests for `adapters/swebench.py`.

Two tiers:
  - Unit tests (no Docker, no network): exercise the pure `parse_report`
    function against fixture report JSON captured from the CONFIRMED
    `swebench==4.1.0` report shape (see adapters/swebench.py's module
    docstring for where that shape was verified). These always run.
  - `run_live` tests: exercise `SweBenchAdapter.run_controls`/`score`/
    `run_self_test` against a real Docker image. Gated behind the `RUN_LIVE`
    env var -- these are for the operator's live pass, not this build.
"""

import json
import os
from pathlib import Path

import pytest

from adapters.swebench import SweBenchAdapter, parse_report

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _instance() -> dict:
    return _load("swebench_instance.json")


# -- unit tests: pure report parser (no Docker) ------------------------------


def test_parse_report_resolved_maps_fail_to_pass_and_pass_to_pass():
    report = _load("swebench_report_resolved.json")
    result = parse_report(report, "pallets__flask-5063")
    assert result["resolved"] is True
    assert result["fail_to_pass"] == {"tests/test_json.py::test_decimal_serialization": True}
    assert result["pass_to_pass"] == {
        "tests/test_json.py::test_basic_serialization": True,
        "tests/test_json.py::test_datetime_serialization": True,
    }


def test_parse_report_empty_candidate_is_unresolved_with_no_id_lists():
    report = _load("swebench_report_unresolved.json")
    result = parse_report(report, "pallets__flask-5063")
    assert result["resolved"] is False
    assert result["fail_to_pass"] == {}
    assert result["pass_to_pass"] == {}


def test_parse_report_partial_fail_reports_false_verdict_for_failing_test():
    report = _load("swebench_report_partial_fail.json")
    result = parse_report(report, "pallets__flask-5063")
    assert result["resolved"] is False
    assert result["fail_to_pass"] == {"tests/test_json.py::test_decimal_serialization": False}


@pytest.mark.parametrize(
    "fixture_name",
    [
        "swebench_report_error_missing_entry.json",
        "swebench_report_error_unsupported_resolved.json",
        "swebench_report_error_empty.json",
    ],
)
def test_parse_report_raises_on_error_report_never_resolved(fixture_name):
    report = _load(fixture_name)
    with pytest.raises(ValueError):
        parse_report(report, "pallets__flask-5063")


def test_parse_report_raises_on_non_dict_report():
    with pytest.raises(ValueError):
        parse_report(["not", "a", "dict"], "pallets__flask-5063")  # type: ignore[arg-type]


# -- run_live tests: real harness + Docker -----------------------------------

_run_live = pytest.mark.skipif(
    not os.environ.get("RUN_LIVE"),
    reason="requires Docker + the swebench eval image; gated for the operator's live pass",
)


@_run_live
def test_run_controls_gold_resolves_base_fails_deterministic():
    adapter = SweBenchAdapter()
    result = adapter.run_controls(_instance())
    assert result["gold_resolved"] is True
    assert result["base_fails"] is True
    assert result["deterministic"] is True


@_run_live
def test_score_gold_patch_resolves():
    adapter = SweBenchAdapter()
    inst = _instance()
    result = adapter.score(inst, inst["fix_patch"])
    assert result["resolved"] is True


@_run_live
def test_score_empty_candidate_does_not_resolve():
    adapter = SweBenchAdapter()
    result = adapter.score(_instance(), "")
    assert result["resolved"] is False


@_run_live
def test_run_self_test_with_passing_added_test():
    adapter = SweBenchAdapter()
    inst = _instance()
    result = adapter.run_self_test(
        inst, inst["fix_patch"], ["tests/test_json.py::test_decimal_serialization"]
    )
    assert result == {"passed": True}


@_run_live
def test_run_self_test_with_no_added_test_returns_none():
    adapter = SweBenchAdapter()
    inst = _instance()
    result = adapter.run_self_test(inst, inst["fix_patch"], [])
    assert result == {"passed": None}
