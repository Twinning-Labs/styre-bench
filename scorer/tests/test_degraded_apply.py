"""A degraded patch application must be an error, never a verdict.

swebench tries `git apply`, then `git apply --reject`, then `patch --batch --fuzz=5 -p1`.
Only the first applies cleanly; the `patch` fallback can decide a hunk is "previously applied"
and REVERT it. The container then runs without the candidate's changes while swebench still
reports patch_successfully_applied: True, producing a confident but fabricated `resolved: false`.

The log text below is copied from real run 34432706755, where a correctly-solved instance
(astropy__astropy-12907) was scored resolved:false for exactly this reason.
"""

from __future__ import annotations

import pytest

from adapters import swebench as mod
from adapters.swebench import _assert_patch_applied_cleanly

RUN_ID = "styre-bench-547407aad10b4cefa6e957ce9d6cfe77"
INSTANCE = "astropy__astropy-12907"

DEGRADED_LOG = """\
2026-09-10 03:24:17,264 - INFO - Intermediate patch written, now applying to container...
2026-09-10 03:24:17,349 - INFO - Failed to apply patch to container: git apply --verbose
2026-09-10 03:24:17,391 - INFO - Failed to apply patch to container: git apply --verbose --reject
2026-09-10 03:24:17,432 - INFO - >>>>> Applied Patch:
patching file astropy/modeling/separable.py
Reversed (or previously applied) patch detected!  Assuming -R.
"""

CLEAN_LOG = """\
2026-09-10 03:24:17,264 - INFO - Intermediate patch written, now applying to container...
2026-09-10 03:24:17,432 - INFO - >>>>> Applied Patch:
patching file astropy/modeling/separable.py
"""


@pytest.fixture
def log_dir(tmp_path, monkeypatch):
    root = tmp_path / "logs"
    monkeypatch.setattr(mod, "RUN_EVALUATION_LOG_DIR", root)
    d = root / RUN_ID / mod._MODEL_NAME / INSTANCE
    d.mkdir(parents=True)
    return d


def test_degraded_apply_raises(log_dir):
    (log_dir / "run_instance.log").write_text(DEGRADED_LOG)
    with pytest.raises(RuntimeError) as exc:
        _assert_patch_applied_cleanly(RUN_ID, INSTANCE, "diff --git a/x b/x\n")
    msg = str(exc.value)
    assert "did not apply cleanly" in msg
    # The error must carry the evidence, so a red job is diagnosable from the message alone.
    assert "git apply --verbose" in msg
    assert "Assuming -R" in msg


def test_clean_apply_is_silent(log_dir):
    (log_dir / "run_instance.log").write_text(CLEAN_LOG)
    _assert_patch_applied_cleanly(RUN_ID, INSTANCE, "diff --git a/x b/x\n")


def test_empty_candidate_diff_is_exempt(log_dir):
    # The empty-patch control run in run_controls() is a legitimate scoring path: there is
    # nothing to apply, so an apply failure cannot be attributed to a candidate.
    (log_dir / "run_instance.log").write_text(DEGRADED_LOG)
    _assert_patch_applied_cleanly(RUN_ID, INSTANCE, "")
    _assert_patch_applied_cleanly(RUN_ID, INSTANCE, "   \n ")


def test_missing_log_raises_rather_than_passing(log_dir):
    # Fail closed: an unverifiable apply must not be waved through as clean.
    with pytest.raises(RuntimeError) as exc:
        _assert_patch_applied_cleanly(RUN_ID, INSTANCE, "diff --git a/x b/x\n")
    assert "cannot verify patch application" in str(exc.value)


def test_score_checks_before_parsing_the_report(monkeypatch):
    """The guard must run before parse_report, or a fabricated verdict is returned anyway."""
    import inspect

    src = inspect.getsource(mod.SweBenchAdapter.score)
    guard = src.index("_assert_patch_applied_cleanly")
    parse = src.index("parse_report(")
    assert guard < parse, "the degraded-apply guard must precede parse_report"
