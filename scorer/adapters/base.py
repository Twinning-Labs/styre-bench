"""Abstract oracle-adapter interface for the styre-bench scorer.

Each corpus family (SWE-bench for Python, Multi-SWE-bench for TS) ships its own
eval harness with its own Docker image convention, its own report JSON shape,
and its own per-language log parser. This module defines the *shared* contract
the rest of the bench codes against (score.py's dispatcher, and
orchestrator/pipeline.ts via subprocess + JSON stdio), so callers never need to
know which harness backs a given instance.

FAIL-CLOSED CONTRACT (do not weaken this, in this file or any subclass):
  - A harness error, a missing/empty/unparseable report, or any report shape
    that cannot be mapped to a definite fail_to_pass/pass_to_pass verdict MUST
    raise. Never default an unparseable or absent result to `resolved: True`.
  - A missing test id in a harness's post-fix test-status data must never be
    read as "passed" -- default such gaps to `False`, never `True`.
  - `run_controls` reports facts (`gold_resolved`, `base_fails`,
    `deterministic`); it does not itself decide to drop an instance -- the
    caller (the pipeline) MUST drop any instance where
    `not (gold_resolved and base_fails and deterministic)`, never score it.
"""

from abc import ABC, abstractmethod
from typing import Any


class OracleAdapter(ABC):
    """Wraps one corpus family's eval harness as ground truth."""

    @abstractmethod
    def run_controls(self, instance: dict[str, Any]) -> dict[str, bool]:
        """Positive + negative + determinism control for one instance.

        Returns `{"gold_resolved": bool, "base_fails": bool, "deterministic": bool}`:
          - gold_resolved: scoring `instance["fix_patch"]` against the harness resolves it.
          - base_fails: scoring an empty candidate (test_patch applied, no fix) does
            NOT resolve -- i.e. the FAIL_TO_PASS tests genuinely fail on base.
          - deterministic: re-scoring the empty candidate twice agrees (flaky-test guard).

        An instance failing any of these must be DROPPED upstream by the caller,
        never scored -- this method only reports facts, it does not drop instances.
        """
        raise NotImplementedError

    @abstractmethod
    def score(self, instance: dict[str, Any], candidate_diff: str) -> dict[str, Any]:
        """Score `candidate_diff` against the instance's held-out tests.

        Hands `candidate_diff` to the family harness AS THE PREDICTION. The
        harness applies `instance["test_patch"]` and performs its OWN
        test-file reset -- this method must never hand-roll a git-checkout
        reset itself (that reimplements the harness's eval loop and can miss a
        PASS_TO_PASS test living in a file test_patch never touches).

        Returns `{"resolved": bool, "fail_to_pass": {test_id: bool, ...},
        "pass_to_pass": {test_id: bool, ...}}`.
        """
        raise NotImplementedError

    @abstractmethod
    def run_self_test(
        self,
        instance: dict[str, Any],
        candidate_diff: str,
        added_test_paths: list[str],
    ) -> dict[str, bool | None]:
        """Run ONLY styre's newly-added test file(s) on base + candidate_diff.

        This is the rigorous producer for the report's headline self-test
        number (a more precise signal than "styre opened a PR, so its test
        must have passed under its own verify").

        Returns `{"passed": bool | None}` -- `None` iff `added_test_paths` is
        empty (styre added no test of its own; there is nothing to run).
        """
        raise NotImplementedError
