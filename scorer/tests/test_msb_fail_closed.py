"""MSB: "nothing measured" is not a verdict, and the old controls measured nothing (ENG-430).

Every report shape below is taken from the retained harness output of the 2026-09-11 matrix on
the bench host (`/tmp/styre-bench-msb-*/**/report.json`), not invented.
"""

from __future__ import annotations

import pytest

from adapters.multiswebench import parse_base_report, parse_report, UnmeasuredResult

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


# ── Independent native base results, not corpus-derived truth ─────────────────────────────

@pytest.mark.parametrize("status,expected", [("failed_tests", True), ("passed_tests", False), ("skipped_tests", None)])
def test_base_requires_explicit_target_outcomes(status, expected):
    stage = {"passed_tests": [P2P[0]], "failed_tests": [], "skipped_tests": []}
    stage[status].append(F2P[0])
    result = parse_base_report(_report(False, stage), F2P)
    assert result["base_fails"] is expected
    assert result["base_provenance"] == ("independent" if expected is not None else "not-measured")


def test_absent_target_is_not_observed_failure():
    assert parse_base_report(_report(False, {"passed_tests": [P2P[0]], "failed_tests": [], "skipped_tests": []}), F2P)["base_fails"] is None


def test_contradictory_base_evidence_raises():
    with pytest.raises(ValueError, match="contradictory"):
        parse_base_report(_report(False, {"passed_tests": F2P, "failed_tests": F2P, "skipped_tests": []}), F2P)


def test_zero_result_origin_is_unknown_and_is_not_an_infra_exception(monkeypatch):
    from adapters import multiswebench as m
    def no_results(*args, **kwargs):
        raise UnmeasuredResult("captured NO test results")
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", no_results)
    result = m.MultiSweBenchAdapter().score({}, "candidate breaks build OR harness broke")
    assert result["resolved"] is None
    assert result["measurement_error"]["origin"] == "unknown"


def test_malformed_report_is_still_a_transport_error(monkeypatch):
    from adapters import multiswebench as m
    def malformed(*args, **kwargs):
        raise ValueError("malformed report")
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", malformed)
    with pytest.raises(ValueError, match="malformed"):
        m.MultiSweBenchAdapter().score({}, "candidate")


# ── run_controls: the PATH, not just the pieces ────────────────────────────────────────────

def _controls_with(monkeypatch, *, gold_results, raw, base_fails=True):
    """Drive `run_controls` with `score` and the corpus fetch both stubbed."""
    from adapters import multiswebench as m

    calls: list[str] = []
    results = list(gold_results)

    def fake_score(_self, _instance, diff):
        calls.append("gold" if diff else "EMPTY")
        return results.pop(0)

    def fake_base(_self, _instance, diff, *, base=False):
        assert base is True and diff == ""
        calls.append("native-base")
        return {"base_fails": base_fails, "base_provenance": "independent" if base_fails is not None else "not-measured"}

    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", fake_base)
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
    assert calls == ["gold", "gold", "native-base"]
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
    assert out == {"gold_resolved": True, "base_fails": True, "base_provenance": "independent", "deterministic": True, "gold_runs": [RESOLVED, RESOLVED]}


def test_base_control_uses_fresh_measurement_even_if_corpus_claims_failure(monkeypatch):
    out, _ = _controls_with(monkeypatch, gold_results=[RESOLVED, RESOLVED], raw=RAW_OK, base_fails=False)
    assert out["base_fails"] is False


def test_unmeasured_base_does_not_qualify_instance(monkeypatch):
    out, _ = _controls_with(monkeypatch, gold_results=[RESOLVED, RESOLVED], raw=RAW_OK, base_fails=None)
    assert out["base_fails"] is None
    assert out["base_provenance"] == "not-measured"


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


def test_no_gold_measurement_does_not_establish_determinism(monkeypatch):
    no_result = {"resolved": None, "fail_to_pass": {}, "pass_to_pass": {}, "measurement_error": {"origin": "unknown", "detail": "zero"}}
    out, _ = _controls_with(monkeypatch, gold_results=[no_result, no_result], raw=RAW_OK)
    assert out["gold_resolved"] is None
    assert out["deterministic"] is None
    assert out["gold_runs"] == [no_result, no_result]


def test_native_base_uses_fresh_log_and_harness_command(monkeypatch, tmp_path):
    """Drive subprocess orchestration, proving no stored corpus stage supplies base."""
    import json
    from pathlib import Path
    from subprocess import CompletedProcess
    from adapters import multiswebench as m

    raw = {**RAW_OK, "org": "mui", "repo": "material-ui", "number": 33777}
    # Corpus says pass; only the independently emitted fix stage says fail.
    raw["test_patch_result"] = {"passed_tests": F2P}
    calls = []
    monkeypatch.setattr(m, "_raw_instance", lambda *_: raw)
    monkeypatch.setattr(m, "native_test_patch_command", lambda r: "bash /home/test-run.sh")
    monkeypatch.setattr(m, "ensure_nix_swe", lambda: "ready")
    monkeypatch.setattr("tempfile.mkdtemp", lambda **_: str(tmp_path))

    def run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[cmd.index("--mode") + 1] == "evaluation":
            assert cmd[cmd.index("--fix_patch_run_cmd") + 1] == "bash /home/test-run.sh"
            patch = json.loads(Path(cmd[cmd.index("--patch_files") + 1]).read_text())
            assert patch["fix_patch"] == ""
            report = _report(False, {"passed_tests": P2P, "failed_tests": F2P, "skipped_tests": []})
            (tmp_path / "work" / "report.json").write_text(json.dumps(report))
        return CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("subprocess.run", run)
    out = m.MultiSweBenchAdapter()._run_harness({"id": "mui__material-ui-33777"}, "", base=True)
    assert out["base_fails"] is True
    assert out["base_provenance"] == "independent"
    assert raw["test_patch_result"]["passed_tests"] == F2P
    assert "--fix_patch_run_cmd" not in calls[0]  # image construction is unchanged


def test_base_transport_failure_retains_observed_gold_facts(monkeypatch):
    from adapters import multiswebench as m
    monkeypatch.setattr(m, "_raw_instance", lambda *_: RAW_OK)
    monkeypatch.setattr(m.MultiSweBenchAdapter, "score", lambda *_: RESOLVED)
    def base_error(*args, **kwargs):
        raise RuntimeError("Docker unavailable during base")
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", base_error)
    out = m.MultiSweBenchAdapter().run_controls({"id": "mui__material-ui-33777"})
    assert out["gold_runs"] == [RESOLVED, RESOLVED]
    assert out["gold_resolved"] is True
    assert out["base_fails"] is None
    assert "Docker unavailable" in out["base_error"]


def test_gold_transport_failure_preserves_other_repetition(monkeypatch):
    from adapters import multiswebench as m
    monkeypatch.setattr(m, "_raw_instance", lambda *_: RAW_OK)
    outcomes = [RESOLVED, RuntimeError("broken second invocation")]
    def gold(*args):
        item = outcomes.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
    monkeypatch.setattr(m.MultiSweBenchAdapter, "score", gold)
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", lambda *a, **k: {"base_fails": True, "base_provenance": "independent"})
    out = m.MultiSweBenchAdapter().run_controls({"id": "mui__material-ui-33777"})
    assert out["gold_runs"][0] == RESOLVED
    assert out["gold_runs"][1]["resolved"] is None
    assert out["gold_resolved"] is None
    assert out["deterministic"] is None
