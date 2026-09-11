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
    def flag_value(cmd, flag):
        return cmd[cmd.index(flag) + 1] if flag in cmd else None

    # The VALUE, not just the token: `"--patch_files", ""` satisfied the old assertion and dies
    # live with `No files found matching pattern:`. And both invocations must name the SAME file
    # — the patch is the build's instance SELECTOR (CliArgs.instances filters on patch_numbers),
    # so a build pointed at a different patch would select no instances, build nothing, and
    # still exit 0 reporting success.
    build_patch = flag_value(calls[0]["cmd"], "--patch_files")
    eval_patch = flag_value(calls[1]["cmd"], "--patch_files")
    assert build_patch, "the harness rejects --mode image without a patch file"
    assert build_patch == eval_patch, "build and eval must select the same instance"


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

    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            with pytest.raises(subprocess.TimeoutExpired):
                MultiSweBenchAdapter()._run_harness({"id": "o__r-1", "language": "ts"}, "d")


def test_EVERY_score_call_builds__caching_it_moved_a_git_clone_into_the_eval_budget():
    """The build invocation must run on every call, including the second gold run.

    An earlier version cached it per instance in a module-level set, believing it saved "~60s of
    harness startup". An independent review showed it saves more than that, and the difference is
    the bug: `run_dir` is a fresh `mkdtemp` per call, so `run_dir/repo` is EMPTY every time, and
    `run_mode_image` opens with `check_commit_hashes()`, which git-clones the repo when absent.

    Skipping the build for `run_controls`' second gold run therefore pushed a multi-GB clone of
    mui/material-ui into EVAL_TIMEOUT_SEC, next to an 11-18 minute suite — recreating the exact
    "one budget for setup and measurement" failure this module exists to delete.
    """
    calls: list = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd[cmd.index("--mode") + 1])
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            a = MultiSweBenchAdapter()
            for _ in range(2):
                try:
                    a._run_harness({"id": "o__r-1", "language": "ts"}, "d")
                except Exception:
                    pass  # no report.json from a stubbed run; the invocations are the point
    assert calls.count("image") == 2, "each call must build, so each call's repo dir is populated"
    assert calls.count("evaluation") == 2


@pytest.mark.run_live
@pytest.mark.skipif(
    not __import__("os").environ.get("RUN_LIVE"),
    reason="invokes the real multi-swe-bench harness; gated for the operator's live pass",
)
def test_live_the_ADAPTER_can_build_images(tmp_path, monkeypatch):
    """Drive `_build_images_or_raise` FOR REAL and require it not to raise.

    An earlier version of this test hand-built its own argv and invoked the harness directly.
    That proved the harness accepts THAT argv — not the adapter's — so dropping `--patch_files`
    from `_build_images_or_raise` again would have left it green. Which is precisely the flaw
    that shipped ENG-431: asserting against a construction of my own rather than the real call.

    So this one calls the adapter's own method, with the adapter's own argv.
    """
    import json

    from adapters.multiswebench import MultiSweBenchAdapter

    corpus = json.load(open(Path(__file__).resolve().parents[2] / "data" / "multi-swe-bench.json"))
    rec = next(r for r in corpus if r.get("instance_id") == "mui__material-ui-33777")

    for name in ("work", "repo", "output"):
        (tmp_path / name).mkdir(parents=True, exist_ok=True)
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps(rec) + "\n")
    patch = tmp_path / "patch.json"
    patch.write_text(
        json.dumps(
            {"org": rec["org"], "repo": rec["repo"], "number": rec["number"], "fix_patch": ""}
        )
        + "\n"
    )

    # Not raising IS the assertion: the method raises RuntimeError on a non-zero exit and lets
    # TimeoutExpired through.
    MultiSweBenchAdapter()._build_images_or_raise(
        rec["instance_id"], tmp_path, dataset, patch
    )


def test_nix_swe_is_pre_created_BEFORE_the_build_dispatches():
    """ENG-419's race is reachable again the moment the build actually runs.

    The harness's `__main__` does its check-then-act on the fixed-name `nix_swe` container
    BEFORE parsing a single argument, for every mode including `image`. Under ENG-431 that was
    unreachable — the build died on `Invalid patch_files: None` before touching Docker — so
    adding the argument is what makes the race live: at concurrency 3, two of three builds lose
    it and exit 1, which is the ENG-419 symptom wearing a new error string.
    """
    order: list = []

    def fake_ensure():
        order.append("nix_swe")
        return "present"

    def fake_run(cmd, **kwargs):
        order.append(cmd[cmd.index("--mode") + 1])
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("adapters.multiswebench.ensure_nix_swe", side_effect=fake_ensure):
            with patch("subprocess.run", side_effect=fake_run):
                try:
                    MultiSweBenchAdapter()._run_harness({"id": "o__r-1", "language": "ts"}, "d")
                except Exception:
                    pass
    assert order[0] == "nix_swe", f"nix_swe must be pre-created first, got {order}"
    assert "image" in order and order.index("nix_swe") < order.index("image")


def test_a_failed_build_carries_the_nix_swe_hint():
    """The build is now the FIRST harness invocation, so it is where a lost 409 actually lands —
    the hint written for exactly that error belongs on this path more than on the eval path."""

    def fake_run(cmd, **kwargs):
        if cmd[cmd.index("--mode") + 1] == "image":
            return subprocess.CompletedProcess(
                args=cmd, returncode=1, stdout="",
                stderr="409 Client Error: Conflict ... container name \"/nix_swe\" is already in use",
            )
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("adapters.multiswebench._raw_instance", return_value=RAW):
        with patch("subprocess.run", side_effect=fake_run):
            with pytest.raises(RuntimeError) as exc:
                MultiSweBenchAdapter()._run_harness({"id": "o__r-1", "language": "ts"}, "d")
    assert "image build failed" in str(exc.value)
    assert "nix_swe" in str(exc.value)
