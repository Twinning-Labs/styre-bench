"""The JSON-stdio transport contract: stdout carries ONE JSON object and nothing else.

The swebench harness prints progress and error text to stdout. Before this guard, that text
landed in the same stream as the result, so a caller redirecting stdout to a file got harness
noise followed by JSON and could not parse it — which is exactly how the 2026-09-09 scoring
run failed to render its own error.
"""

from __future__ import annotations

import io
import json
from contextlib import redirect_stderr, redirect_stdout

import score


def _run(command: str, payload: dict, monkeypatch) -> tuple[str, str, int]:
    """Invoke score.main with stdin stubbed, capturing stdout and stderr separately."""
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = score.main([command])
    return out.getvalue(), err.getvalue(), code


def test_adapter_stdout_never_pollutes_the_result_channel(monkeypatch):
    """A command that prints to stdout must not corrupt the JSON object."""

    def noisy(instance, candidate_diff):
        print("Error building image foo: Environment image bar not found")
        print("Check (logs/run_evaluation/...) for more information.")
        return {"resolved": True}

    monkeypatch.setattr(score, "score", noisy)
    out, err, code = _run("score", {"instance": {"id": "x"}, "candidate_diff": "d"}, monkeypatch)

    assert code == 0
    assert json.loads(out) == {"resolved": True}, "stdout must parse as exactly one JSON object"
    assert "Environment image" in err, "harness noise belongs on stderr, not discarded"


def test_a_raised_error_still_yields_parseable_json_after_noisy_output(monkeypatch):
    """The failure path is the one that broke: noise, then an error object."""

    def noisy_boom(instance, candidate_diff):
        print("Error building image foo: Environment image bar not found")
        raise RuntimeError("run_instance did not complete")

    monkeypatch.setattr(score, "score", noisy_boom)
    out, err, code = _run("score", {"instance": {"id": "x"}, "candidate_diff": "d"}, monkeypatch)

    assert code == 1
    parsed = json.loads(out)
    assert "error" in parsed and "run_instance did not complete" in parsed["error"]
    assert "Environment image" in err
