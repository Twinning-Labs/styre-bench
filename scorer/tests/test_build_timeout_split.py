"""Building and evaluating get separate budgets (ENG-431).

On `mui__material-ui-39108` the harness built images 04:05:09 -> 04:21:52 — 15m43s of a single
1800s ceiling shared with the evaluation — leaving ~13 minutes for a suite that takes 11-18. It
timed out and the cell was recorded as infra with nothing measured. A warm-image run of the same
repo evaluated in 11 minutes inside that same ceiling: the evaluation was never the problem.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from adapters import multiswebench as m
from adapters.multiswebench import (
    EVAL_TIMEOUT_SEC,
    IMAGE_BUILD_TIMEOUT_SEC,
    MultiSweBenchAdapter,
)

RAW = {"org": "o", "repo": "r", "number": 1, "f2p_tests": {}, "p2p_tests": {}, "fix_patch": "d"}


def _ok(**over):
    return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="", **over)


def _drive(calls: list, *, build_rc=0, then=None):
    """Run `_run_harness`, recording each subprocess invocation."""

    def fake_run(cmd, **kwargs):
        calls.append({"mode": cmd[cmd.index("--mode") + 1], "timeout": kwargs.get("timeout"), "cmd": cmd})
        if cmd[cmd.index("--mode") + 1] == "image":
            return subprocess.CompletedProcess(args=cmd, returncode=build_rc, stdout="", stderr="boom")
        if then is not None:
            raise then
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    m._IMAGES_BUILT.clear()
    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            return MultiSweBenchAdapter()._run_harness({"id": "o__r-1", "language": "ts"}, "d")


def test_the_build_runs_FIRST_and_on_its_own_clock():
    calls: list = []
    with pytest.raises(Exception):
        _drive(calls, then=subprocess.TimeoutExpired(cmd="x", timeout=1))
    assert [c["mode"] for c in calls] == ["image", "evaluation"]
    assert calls[0]["timeout"] == IMAGE_BUILD_TIMEOUT_SEC
    assert calls[1]["timeout"] == EVAL_TIMEOUT_SEC


def test_the_two_budgets_are_actually_different():
    # A "split" that hands both phases the same number has not split anything.
    assert IMAGE_BUILD_TIMEOUT_SEC != EVAL_TIMEOUT_SEC
    # And the evaluation budget must still cover a slow suite: mui evaluated in 11-18 minutes.
    assert EVAL_TIMEOUT_SEC >= 1080


def test_the_build_phase_carries_the_patch_the_harness_DEMANDS():
    """`--mode image` requires `--patch_files` even though it never reads one.

    THIS TEST USED TO ASSERT THE OPPOSITE, and was wrong in the way that matters: I reasoned
    that a build phase has no business carrying a candidate patch, wrote that as an invariant,
    and it passed — because it was checking argv I had constructed myself, against a harness
    contract I had only read `--help` for. `CliArgs.__post_init__` calls `_check_patch_files()`
    UNCONDITIONALLY, before the per-mode branch, so every call raised

        ValueError: Invalid patch_files: None

    and all three TypeScript cells of bench matrix #3 were dropped as infra within seconds.

    Passing it changes nothing about the image: `run_mode_image` builds from `self.instances`
    and their dependency graph and never reads a patch (checked in the harness source, and by
    running the real invocation — see `test_live_mode_image_actually_runs`).
    """
    calls: list = []
    with pytest.raises(Exception):
        _drive(calls, then=subprocess.TimeoutExpired(cmd="x", timeout=1))
    assert "--patch_files" in calls[0]["cmd"], "the harness rejects --mode image without it"
    assert "--patch_files" in calls[1]["cmd"]


def test_a_failed_build_raises_and_says_nothing_was_evaluated():
    calls: list = []
    with pytest.raises(RuntimeError) as exc:
        _drive(calls, build_rc=1)
    assert "image build failed" in str(exc.value)
    # Fail-closed, in the same words as the rest of the module: a build failure is not a verdict.
    assert "not a verdict" in str(exc.value)
    # And evaluation was never attempted.
    assert [c["mode"] for c in calls] == ["image"]


def test_a_build_TIMEOUT_propagates_unmodified():
    # Same contract as the evaluation phase — never swallowed into a fake verdict.
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd="build", timeout=IMAGE_BUILD_TIMEOUT_SEC)

    m._IMAGES_BUILT.clear()
    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            with pytest.raises(subprocess.TimeoutExpired):
                MultiSweBenchAdapter()._run_harness({"id": "o__r-1", "language": "ts"}, "d")


def test_an_instance_already_built_in_this_process_is_not_rebuilt():
    # `run_controls` scores gold twice (ENG-430); the second call would otherwise pay ~60s of
    # harness startup to be told the images are already there.
    calls: list = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd[cmd.index("--mode") + 1])
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    m._IMAGES_BUILT.clear()
    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            a = MultiSweBenchAdapter()
            for _ in range(2):
                try:
                    a._run_harness({"id": "o__r-1", "language": "ts"}, "d")
                except Exception:
                    pass  # no report.json from a stubbed run; the build calls are the point
    assert calls.count("image") == 1, "the image build must not repeat for the same instance"
    assert calls.count("evaluation") == 2


def test_a_FAILED_build_is_not_cached_as_built():
    """A retry must rebuild, not skip straight to evaluating against a missing image.

    The bench retries an infra failure (`runInstance`'s infra-retry loop), so a poisoned cache
    would turn one bad build into an evaluation against nothing — for every remaining attempt in
    the process. Marking the instance built before checking the exit code survived the first
    mutation sweep: the "not rebuilt" case above only covers the SUCCESS path.
    """
    calls: list = []

    def fake_run(cmd, **kwargs):
        mode = cmd[cmd.index("--mode") + 1]
        calls.append(mode)
        rc = 1 if mode == "image" else 0
        return subprocess.CompletedProcess(args=cmd, returncode=rc, stdout="", stderr="boom")

    m._IMAGES_BUILT.clear()
    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            a = MultiSweBenchAdapter()
            for _ in range(2):
                with pytest.raises(RuntimeError):
                    a._run_harness({"id": "o__r-1", "language": "ts"}, "d")

    assert calls.count("image") == 2, "a failed build must be retried, never remembered as done"
    assert "evaluation" not in calls, "evaluation must not run against an image that failed to build"


# ── the test that would have caught it ─────────────────────────────────────────────────────

@pytest.mark.skipif(
    not __import__("os").environ.get("RUN_LIVE"),
    reason="invokes the real multi-swe-bench harness; gated for the operator's live pass",
)
def test_live_mode_image_actually_runs(tmp_path):
    """Invoke `--mode image` FOR REAL and require exit 0.

    Every other test in this file stubs `subprocess.run`, so all of them pass against an argv
    the harness would reject — which is exactly what happened. A stub-only suite proves argv
    construction; it cannot prove the call works. This one costs a live harness invocation and
    is the only thing here that could have caught ENG-431.
    """
    import json
    import os
    import subprocess as sp
    import sys

    corpus = json.load(open("data/multi-swe-bench.json"))
    rec = next(r for r in corpus if r.get("instance_id") == "mui__material-ui-33777")
    work = tmp_path / "work"
    repo = tmp_path / "repo"
    for d in (work, repo, tmp_path / "output"):
        d.mkdir(parents=True, exist_ok=True)
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps(rec) + "\n")
    patch = tmp_path / "patch.json"
    patch.write_text(
        json.dumps({"org": rec["org"], "repo": rec["repo"], "number": rec["number"], "fix_patch": ""})
        + "\n"
    )

    out = sp.run(
        [sys.executable, "-m", "multi_swe_bench.harness.run_evaluation",
         "--mode", "image", "--workdir", str(work), "--patch_files", str(patch),
         "--dataset_files", str(dataset), "--repo_dir", str(repo),
         "--output_dir", str(tmp_path / "output"), "--log_dir", str(tmp_path / "logs")],
        capture_output=True, text=True, timeout=3600,
    )
    assert out.returncode == 0, f"--mode image rejected our arguments:\n{out.stdout}\n{out.stderr}"
