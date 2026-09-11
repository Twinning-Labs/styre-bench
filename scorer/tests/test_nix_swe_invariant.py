"""The MSB adapter must actually CALL the nix_swe pre-creation, and name the race when it recurs.

WHY THIS EXISTS. A mutation that replaced `ensure_nix_swe()` with a hardcoded "present" broke no
test: every nix_swe test drove the helper directly, so the fix could be perfect and unreachable.
That is the same "tested the piece, not the path" gap that has bitten this repo before, and the
wiring is one line -- a MISSED line, which no test of the helper can catch.
"""

from __future__ import annotations

import re
from pathlib import Path

ADAPTER = Path(__file__).resolve().parents[1] / "adapters" / "multiswebench.py"
HARNESS_CALL = "subprocess.run(cmd"


def _source() -> str:
    return ADAPTER.read_text()


def test_the_adapter_pre_creates_nix_swe_BEFORE_invoking_the_harness() -> None:
    src = _source()
    assert "ensure_nix_swe()" in src, (
        "the adapter no longer pre-creates nix_swe; the harness will take its own "
        "check-then-act branch and race again (ENG-419)"
    )
    # Order matters as much as presence: creating it after the harness has already exited 1 is
    # no fix at all.
    assert src.index("ensure_nix_swe()") < src.index(HARNESS_CALL), (
        "ensure_nix_swe() must run BEFORE the harness subprocess, not after"
    )


def test_a_failed_harness_invocation_consults_the_nix_swe_hint() -> None:
    src = _source()
    assert "nix_swe_failure_hint(" in src
    # Inside the non-zero-exit branch, not somewhere decorative.
    failure_branch = src[src.index("if result.returncode != 0:") :][:800]
    assert "nix_swe_failure_hint(" in failure_branch
    assert "hint" in failure_branch


def test_an_unavailable_pre_creation_is_reported_not_swallowed() -> None:
    """`ensure_nix_swe` never raises, so a silent discard of its result would hide the one clue
    that explains a subsequent harness failure."""
    src = _source()
    assert re.search(r'outcome\.startswith\(\s*"unavailable"\s*\)', src), (
        "the pre-creation outcome must be checked and surfaced"
    )
