"""One suite, run against EVERY oracle adapter.

WHY THIS EXISTS. `adapters/base.py` states a fail-closed contract in prose, and nothing enforced
it. `MultiSweBenchAdapter` satisfied the abstraction perfectly — it subclassed `OracleAdapter`,
implemented all three abstract methods, and typechecked — while being incapable of scoring
anything, for five separate reasons, for months. Inheritance told us nothing about whether it
worked, because the two adapters were never held to a shared standard of evidence: SWE-bench had
been exercised, Multi-SWE-bench never had.

Every clause here is mockable — no Docker, no harness, no network — so an adapter that has never
been run in anger still cannot pass by default. Adding a new corpus family means adding one entry
to `CASES` and inheriting the whole suite.

Deliberately NOT a deeper base class. Four of those five defects were idiosyncrasies of the
third-party harness being wrapped (directory pre-creation, JSONL vs array, a dict where a list was
expected); absorbing those is what an adapter is FOR. Forcing SWE-bench's in-process Docker-SDK
flow and MSB's subprocess-plus-files flow into a shared shape would hide real differences rather
than remove them. What was missing was enforcement of the shared CONTRACT, which is this file.
"""

from __future__ import annotations

import ast
import builtins
import inspect
from dataclasses import dataclass
from typing import Any, Callable

import pytest

from adapters import multiswebench as msb_mod
from adapters import swebench as swe_mod
from adapters.base import OracleAdapter
from adapters.multiswebench import MultiSweBenchAdapter
from adapters.swebench import SweBenchAdapter

INSTANCE_ID = "org__repo-1"
F2P = ["tests/a.ts:one"]
P2P = ["tests/b.ts:two"]


@dataclass
class Case:
    name: str
    adapter: OracleAdapter
    module: Any
    #: Build a report the harness would emit, claiming `resolved`, listing `passed` as green.
    make_report: Callable[[bool, list[str]], dict[str, Any]]
    #: Call this adapter's `parse_report` with the shared f2p/p2p id lists.
    parse: Callable[[dict[str, Any]], dict[str, Any]]


def _swe_report(resolved: bool, passed: list[str]) -> dict[str, Any]:
    return {
        INSTANCE_ID: {
            "resolved": resolved,
            "tests_status": {
                "FAIL_TO_PASS": {"success": [t for t in F2P if t in passed], "failure": []},
                "PASS_TO_PASS": {"success": [t for t in P2P if t in passed], "failure": []},
            },
        }
    }


def _msb_report(resolved: bool, passed: list[str]) -> dict[str, Any]:
    return {"valid": resolved, "fix_patch_result": {"passed_tests": passed, "failed_tests": []}}


CASES = [
    Case(
        name="swe-bench",
        adapter=SweBenchAdapter(),
        module=swe_mod,
        make_report=_swe_report,
        # Mirrors production: `score` passes the expected id lists so a target test missing
        # from the harness report defaults to False instead of vanishing from the verdict.
        parse=lambda r: swe_mod.parse_report(r, INSTANCE_ID, F2P, P2P),
    ),
    Case(
        name="multi-swe-bench",
        adapter=MultiSweBenchAdapter(),
        module=msb_mod,
        make_report=_msb_report,
        parse=lambda r: msb_mod.parse_report(r, F2P, P2P),
    ),
]
IDS = [c.name for c in CASES]


# -- structural conformance ---------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_is_an_oracle_adapter(case: Case) -> None:
    assert isinstance(case.adapter, OracleAdapter)
    for method in ("score", "run_controls", "run_self_test", "preflight"):
        assert callable(getattr(case.adapter, method))


# -- FAIL-CLOSED: never invent a verdict --------------------------------------


@pytest.mark.parametrize("case", CASES, ids=IDS)
@pytest.mark.parametrize("bad", [{}, {"unrelated": 1}, [], "not a dict", None, 42])
def test_an_unusable_report_raises_rather_than_resolving(case: Case, bad: Any) -> None:
    """base.py: "A harness error, a missing/empty/unparseable report ... MUST raise."

    The dangerous failure is not raising — it is quietly returning resolved:True on a report the
    parser did not actually understand.
    """
    with pytest.raises(Exception) as exc:
        case.parse(bad)
    assert not isinstance(exc.value, KeyError), (
        "a bare KeyError leaks the parser's internals instead of naming the contract violation"
    )


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_a_resolved_claim_with_no_test_evidence_raises(case: Case) -> None:
    """A harness may not simply assert success; the id-list evidence has to be there."""
    report = case.make_report(True, F2P + P2P)
    # strip the evidence, keep the claim
    if case.name == "swe-bench":
        del report[INSTANCE_ID]["tests_status"]
    else:
        del report["fix_patch_result"]
    with pytest.raises(Exception):
        case.parse(report)


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_a_missing_test_id_reads_as_FAILED_never_passed(case: Case) -> None:
    """base.py: "A missing test id ... must never be read as 'passed'."

    A silently-absent test is the one that turns a real regression into a green verdict.
    """
    report = case.make_report(True, [])  # claims resolved, lists NOTHING as passed
    out = case.parse(report)
    assert out["fail_to_pass"][F2P[0]] is False
    assert out["pass_to_pass"][P2P[0]] is False


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_a_genuine_pass_is_reported_as_such(case: Case) -> None:
    """The mirror of the clause above — the fail-closed rule must not make everything False."""
    out = case.parse(case.make_report(True, F2P + P2P))
    assert out["resolved"] is True
    assert out["fail_to_pass"][F2P[0]] is True
    assert out["pass_to_pass"][P2P[0]] is True


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_the_verdict_shape_is_identical_across_adapters(case: Case) -> None:
    """`orchestrator/pipeline.ts` reads one shape regardless of which harness produced it."""
    out = case.parse(case.make_report(False, []))
    assert set(out) == {"resolved", "fail_to_pass", "pass_to_pass"}
    assert isinstance(out["resolved"], bool)
    for bucket in ("fail_to_pass", "pass_to_pass"):
        assert isinstance(out[bucket], dict)
        assert all(isinstance(v, bool) for v in out[bucket].values())


# -- FIREWALL: the payload carries an id and a language, nothing else ----------

FORBIDDEN_PAYLOAD_KEYS = ("fix_patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "f2p_tests",
                          "p2p_tests", "base", "repo", "problem_statement")


def _instance_subscripts(fn: Callable[..., Any]) -> set[str]:
    """String keys read off the `instance` parameter inside `fn`."""
    tree = ast.parse(inspect.getsource(fn).lstrip())
    found: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == "instance"
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            found.add(node.slice.value)
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "instance"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            found.add(node.args[0].value)
    return found


@pytest.mark.parametrize("case", CASES, ids=IDS)
@pytest.mark.parametrize("method", ["score", "run_controls", "run_self_test"])
def test_no_corpus_field_is_read_off_the_payload(case: Case, method: str) -> None:
    """The scoring payload is `{instance: {id, language}, candidate_diff}` and nothing else.

    `.github/workflows/score.yml` actively rejects corpus fields, so reading one off `instance`
    cannot work in CI — it raises KeyError before the harness starts. That is precisely how the
    Multi-SWE-bench adapter failed: it read `f2p_tests` and `fix_patch` straight off the dict it
    was handed. Corpus data must be re-fetched by id, as both adapters now do.
    """
    used = _instance_subscripts(getattr(case.adapter, method))
    leaked = sorted(used & set(FORBIDDEN_PAYLOAD_KEYS))
    assert not leaked, (
        f"{case.name}.{method} reads {leaked} off the payload; the firewall forbids those fields "
        f"— fetch them by instance id instead"
    )


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_the_adapter_can_fetch_its_corpus_record_by_id_alone(case: Case) -> None:
    """Every adapter needs a by-id loader, or it cannot work behind the firewall at all.

    MSB had none — the omission that made scoring impossible and went unnoticed because nothing
    required it.
    """
    loaders = [
        name
        for name in dir(case.module)
        if "raw_instance" in name or name.endswith("_raw_instance")
    ] + [n for n in dir(case.adapter) if "raw_instance" in n]
    assert loaders, (
        f"{case.name} exposes no by-id corpus loader; without one the firewall payload "
        f"({{id, language}}) cannot be turned into a scoreable instance"
    )


# -- ENG-410: a harness that cannot run here must say so at second zero ---------


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_preflight_raises_when_the_harness_is_unimportable(
    case: Case, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A broken harness must RAISE out of preflight, never return quietly.

    Preflight's only job is to convert "this host cannot produce a verdict" from a 90-minute
    discovery into a millisecond one. An adapter whose preflight swallows its own ImportError
    reinstates exactly the failure it exists to prevent, and would still satisfy the abstract
    signature. So: sabotage the import machinery and require the raise.
    """
    real_import = builtins.__import__

    def boom(name: str, *args: Any, **kwargs: Any) -> Any:
        if name.startswith(("swebench", "multi_swe_bench")):
            raise ModuleNotFoundError(f"sabotaged: {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", boom)
    with pytest.raises(Exception) as excinfo:
        case.adapter.preflight()
    # And the message must name a fix, not just the symptom -- the operator acts on this text.
    assert "sabotaged" in str(excinfo.value)
    assert len(str(excinfo.value)) > len("sabotaged: x"), (
        f"{case.name}.preflight re-raised the bare import error; wrap it with what to DO"
    )


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_preflight_is_cheap_and_passes_on_a_healthy_host(case: Case) -> None:
    """With the harness importable, preflight returns None and touches no Docker/network.

    Guarded on the EXACT module preflight needs, not the top-level package: `multi_swe_bench`
    imports fine on macOS and only its `harness.run_evaluation` submodule hits the
    `Qiskit/`-vs-`qiskit/` case collision, so guarding on the package would make this test fail
    on precisely the host the whole ticket is about. The half of this suite with teeth
    everywhere is the sabotage test above; this half has teeth on Linux and in CI.
    """
    pytest.importorskip(
        "swebench.harness.run_evaluation"
        if case.name == "swe-bench"
        else "multi_swe_bench.harness.run_evaluation",
        reason=f"{case.name} harness is not runnable on this host (expected on macOS for MSB)",
    )
    assert case.adapter.preflight() is None
