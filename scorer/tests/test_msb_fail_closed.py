"""MSB: "nothing measured" is not a verdict, and the old controls measured nothing (ENG-430).

Every report shape below is taken from the retained harness output of the 2026-09-11 matrix on
the bench host (`/tmp/styre-bench-msb-*/**/report.json`), not invented.
"""

from __future__ import annotations

import pytest

from scorer.adapters.multiswebench import f2p_fails_before_fix, parse_report

F2P = ["/home/material-ui/packages/x/A.test.js:<A /> does the thing"]
P2P = ["/home/material-ui/packages/x/B.test.js:<B /> keeps working"]


def _report(valid, fix_stage, error_msg=None):
    r = {"valid": valid, "fix_patch_result": fix_stage}
    if error_msg:
        r["error_msg"] = error_msg
    return r


# ── "nothing measured" must raise ──────────────────────────────────────────────────────────

#: The EMPTY-candidate report, verbatim from mui-33777's control run.
EMPTY_CANDIDATE = _report(
    False,
    {"passed_count": 0, "failed_count": 0, "skipped_count": 0,
     "passed_tests": [], "failed_tests": [], "skipped_tests": []},
    "After applying the fix patch, no test results were captured when executing the test command.",
)

#: The GOLD report for the same instance: 5,828 tests ran and a PASS_TO_PASS regressed.
GOLD_REGRESSED = _report(
    False,
    {"passed_count": 5828, "failed_count": 12, "skipped_count": 754,
     "passed_tests": [P2P[0]], "failed_tests": [F2P[0]], "skipped_tests": []},
    "Before applying the fix patch, the test passed; however, after applying it ...",
)


def test_a_fix_stage_that_captured_nothing_RAISES():
    # THE DEFECT. Both of these carry `valid: False`; only one is a verdict. Recording the other
    # as `resolved: False` is how a candidate diff that breaks the build gets scored as
    # "ran and did not resolve".
    with pytest.raises(ValueError) as exc:
        parse_report(EMPTY_CANDIDATE, F2P, P2P)
    assert "captured NO test results" in str(exc.value)
    # The harness's own sentence is the most useful thing an operator can read.
    assert "no test results were captured" in str(exc.value)


def test_a_real_regression_is_still_a_verdict():
    # The mirror: the fail-closed rule must not swallow genuine results.
    out = parse_report(GOLD_REGRESSED, F2P, P2P)
    assert out["resolved"] is False
    assert out["fail_to_pass"][F2P[0]] is False
    assert out["pass_to_pass"][P2P[0]] is True


def test_an_absent_fix_patch_result_RAISES():
    with pytest.raises(ValueError):
        parse_report({"valid": False}, F2P, P2P)


def test_counts_beat_id_lists_when_both_are_present():
    # A stage can report thousands of tests while listing only the handful the corpus tracks.
    stage = {"passed_count": 5000, "failed_count": 0, "skipped_count": 0, "passed_tests": []}
    out = parse_report(_report(False, stage), F2P, P2P)
    assert out["fail_to_pass"][F2P[0]] is False  # absent from passed → False, never True


def test_id_lists_are_the_fallback_when_no_counts_are_reported():
    # Raising here would turn a legible verdict into an infra error over a missing field.
    stage = {"passed_tests": [P2P[0]], "failed_tests": [F2P[0]]}
    out = parse_report(_report(False, stage), F2P, P2P)
    assert out["pass_to_pass"][P2P[0]] is True


# ── base_fails, re-derived ─────────────────────────────────────────────────────────────────

def test_base_fails_is_true_when_no_f2p_test_passes_before_the_fix():
    raw = {"f2p_tests": {F2P[0]: {}}, "test_patch_result": {"passed_tests": [P2P[0]]}}
    assert f2p_fails_before_fix(raw) is True


def test_base_fails_is_FALSE_when_an_f2p_test_already_passes():
    # The control's whole purpose: an instance already passing its target test proves nothing.
    raw = {"f2p_tests": {F2P[0]: {}}, "test_patch_result": {"passed_tests": [F2P[0], P2P[0]]}}
    assert f2p_fails_before_fix(raw) is False


@pytest.mark.parametrize(
    "raw",
    [
        {"f2p_tests": {}, "test_patch_result": {"passed_tests": []}},          # no f2p at all
        {"f2p_tests": {F2P[0]: {}}},                                           # no stage to check
        {"f2p_tests": {F2P[0]: {}}, "test_patch_result": {}},                  # stage without lists
        {"f2p_tests": {F2P[0]: {}}, "test_patch_result": {"passed_tests": None}},
    ],
)
def test_an_unverifiable_claim_is_not_a_passed_control(raw):
    # Fail-closed: dropped upstream rather than waved through.
    assert f2p_fails_before_fix(raw) is False


# ── run_controls: the PATH, not just the pieces ────────────────────────────────────────────

def _controls_with(monkeypatch, *, gold_results, raw):
    """Drive `run_controls` with `score` and the corpus fetch both stubbed."""
    from scorer.adapters import multiswebench as m

    calls: list[str] = []
    results = list(gold_results)

    def fake_score(_self, _instance, diff):
        calls.append("gold" if diff else "EMPTY")
        return results.pop(0)

    monkeypatch.setattr(m.MultiSweBenchAdapter, "score", fake_score)
    monkeypatch.setattr(m, "_raw_instance", lambda *_a, **_k: raw)
    out = m.MultiSweBenchAdapter().run_controls({"id": "mui__material-ui-33777", "language": "ts"})
    return out, calls


RESOLVED = {"resolved": True, "fail_to_pass": {F2P[0]: True}, "pass_to_pass": {P2P[0]: True}}
UNRESOLVED = {"resolved": False, "fail_to_pass": {F2P[0]: False}, "pass_to_pass": {P2P[0]: True}}
RAW_OK = {
    "fix_patch": "diff --git a/x b/x\n",
    "f2p_tests": {F2P[0]: {}},
    "test_patch_result": {"passed_tests": [P2P[0]]},
}


def test_the_empty_candidate_is_never_scored_again(monkeypatch):
    # It measured nothing: the harness executes only the fix stage, and an empty patch yields
    # `fix = (0, 0, 0)` — which ENG-430 now RAISES on, so the old control would crash rather
    # than quietly report vacuous Trues.
    _out, calls = _controls_with(monkeypatch, gold_results=[RESOLVED, RESOLVED], raw=RAW_OK)
    assert calls == ["gold", "gold"]
    assert "EMPTY" not in calls


def test_determinism_is_gold_run_twice_and_catches_disagreement(monkeypatch):
    # mui's `preset-safe` codemod tests failed at gold on two unrelated instances. THIS is the
    # flakiness the control is supposed to see; two empty runs could never have seen it.
    out, _ = _controls_with(monkeypatch, gold_results=[RESOLVED, UNRESOLVED], raw=RAW_OK)
    assert out["deterministic"] is False
    # And a gold that did not resolve on BOTH runs is not a passed positive control.
    assert out["gold_resolved"] is False


def test_two_agreeing_gold_runs_pass_every_control(monkeypatch):
    out, _ = _controls_with(monkeypatch, gold_results=[RESOLVED, RESOLVED], raw=RAW_OK)
    assert out == {"gold_resolved": True, "base_fails": True, "deterministic": True}


def test_base_fails_comes_from_the_corpus_stage_not_from_a_run(monkeypatch):
    # Same two resolving gold runs; only the corpus claim changes.
    raw = {**RAW_OK, "test_patch_result": {"passed_tests": [F2P[0], P2P[0]]}}
    out, _ = _controls_with(monkeypatch, gold_results=[RESOLVED, RESOLVED], raw=raw)
    assert out["base_fails"] is False


def test_the_corpus_derived_control_is_announced(monkeypatch, capsys):
    # A control we did not measure ourselves must say so, rather than leaving a reader to infer
    # it from a `True`.
    _controls_with(monkeypatch, gold_results=[RESOLVED, RESOLVED], raw=RAW_OK)
    assert "read from the corpus" in capsys.readouterr().err


@pytest.mark.parametrize(
    "second, label",
    [
        ({**RESOLVED, "resolved": False}, "only the verdict differs"),
        ({**RESOLVED, "fail_to_pass": {F2P[0]: False}}, "only a FAIL_TO_PASS test differs"),
        ({**RESOLVED, "pass_to_pass": {P2P[0]: False}}, "only a PASS_TO_PASS test differs"),
    ],
)
def test_determinism_compares_EVERY_field_independently(monkeypatch, second, label):
    """Each clause of the agreement check needs its own case.

    The first disagreement test used two results that differed in all three fields at once, so
    mutating any single comparison away still produced `deterministic: False` through the
    others — it survived the sweep. A conjunction is only pinned by cases that vary one term.
    """
    out, _ = _controls_with(monkeypatch, gold_results=[RESOLVED, second], raw=RAW_OK)
    assert out["deterministic"] is False, label
