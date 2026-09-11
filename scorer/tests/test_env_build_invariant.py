"""Every env-image build must go through `_build_env_images_or_raise` (ENG-420).

WHY A SOURCE INVARIANT. The adapter has TWO build sites today (`score` and `run_self_test`) and
both were identical copies of the same eight-line call. The defect was not a wrong line, it was a
MISSED one: the return value was discarded at both. A third site added later -- and this adapter
has grown one before -- would silently reinstate both halves of the bug (no raise on failure, no
build lock), and no behavioural test of the existing two can catch that.

The same shape as styre's own `check-executor-invariant.test.ts`, for the same reason: three
executors existed, one fix changed one of them.
"""

from __future__ import annotations

import re
from pathlib import Path

ADAPTER = Path(__file__).resolve().parents[1] / "adapters" / "swebench.py"

#: A CALL, not an import or a doc mention: the name followed by `(`.
_CALL = re.compile(r"(?<![\w.])build_env_images\s*\(")


def test_no_build_site_bypasses_the_wrapper() -> None:
    source = ADAPTER.read_text()
    offenders: list[str] = []
    for lineno, line in enumerate(source.splitlines(), start=1):
        if line.lstrip().startswith("#"):
            continue  # the file explains the harness's arg-order bug in prose; that is not a call
        if not _CALL.search(line):
            continue
        # The only legitimate call is the one INSIDE the wrapper.
        if "_successful, failed = build_env_images(" in line:
            continue
        offenders.append(f"{ADAPTER.name}:{lineno}: {line.strip()}")

    assert not offenders, (
        "these call build_env_images directly, bypassing the failure check and the build lock "
        "(ENG-420) -- route them through _build_env_images_or_raise:\n" + "\n".join(offenders)
    )


def test_the_wrapper_still_checks_failed_and_holds_the_lock() -> None:
    """Guards the invariant above from being satisfied by an empty wrapper."""
    source = ADAPTER.read_text()
    body = source[source.index("def _build_env_images_or_raise") :]
    body = body[: body.index("\nclass ")]

    assert "with image_build_lock():" in body, "the build must be serialized across processes"
    assert "if failed:" in body, "a failed build must raise, not fall through to run_instance"
    assert "raise RuntimeError" in body
