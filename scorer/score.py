"""JSON-stdio entrypoint for the oracle adapters, invoked from TS via subprocess.

`get_adapter(instance)` dispatches on `instance["language"]`
(`"python"` -> `SweBenchAdapter`, anything else -> `MultiSweBenchAdapter`,
matching `config/bench.config.ts`'s `pythonCorpus`/`tsCorpus` split where
Python is the only language ever routed to SWE-bench). `run_controls`/
`score`/`run_self_test` are thin dispatchers -- they hold NO scoring logic of
their own; all of it lives in the adapters (`adapters/base.py`'s fail-closed
contract).

CLI usage (subprocess boundary): `python scorer/score.py <command>` (run as a
script, not `-m`, so `adapters/` resolves as a plain top-level import off this
file's own directory -- see `scorer/conftest.py` for the pytest-side
equivalent), where `<command>` is one of `run_controls` / `score` /
`run_self_test` / `preflight`, reading a single JSON object from stdin
(`{"instance": {...}, ...}`) and writing a single JSON object to stdout. On
any exception, writes `{"error": "..."}` to stdout and exits non-zero -- this
is a TRANSPORT failure to the TS caller (re-dispatch/investigate), never a
silent "resolved: false".

stdout is the RESULT channel and carries nothing else: the harnesses print
progress and error text of their own, so adapter execution runs under
`contextlib.redirect_stdout(sys.stderr)`. A caller redirecting stdout to a file
gets exactly one parseable JSON object; harness noise lands on stderr.
"""

from __future__ import annotations

import contextlib
import json
import sys
from typing import Any

from adapters.base import OracleAdapter
from adapters.multiswebench import MultiSweBenchAdapter
from adapters.swebench import SweBenchAdapter


def get_adapter(instance: dict[str, Any]) -> OracleAdapter:
    language = instance.get("language")
    if language == "python":
        return SweBenchAdapter()
    return MultiSweBenchAdapter()


def run_controls(instance: dict[str, Any]) -> dict[str, bool]:
    return get_adapter(instance).run_controls(instance)


def score(instance: dict[str, Any], candidate_diff: str) -> dict[str, Any]:
    return get_adapter(instance).score(instance, candidate_diff)


def run_self_test(
    instance: dict[str, Any], candidate_diff: str, added_test_paths: list[str]
) -> dict[str, bool | None]:
    return get_adapter(instance).run_self_test(instance, candidate_diff, added_test_paths)


def preflight(languages: list[str]) -> dict[str, dict[str, Any]]:
    """Report, per language, whether that family's harness can run on this host.

    DELIBERATELY DOES NOT RAISE per family, unlike every other command here. Preflight's job is
    to name EVERY broken family in one pass so the operator fixes them together; raising on the
    first would hide the second. The fail-closed contract is upheld by the caller
    (`orchestrator/pipeline.ts`), which aborts the run when any entry reports `ok: false` --
    a `False` here is never softened into a verdict, because preflight produces no verdicts.
    """
    report: dict[str, dict[str, Any]] = {}
    for language in languages:
        try:
            get_adapter({"language": language}).preflight()
        except Exception as exc:  # noqa: BLE001 - the report IS the result
            report[language] = {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
        else:
            report[language] = {"ok": True, "detail": "harness importable"}
    return report


_COMMANDS = {
    "run_controls": lambda payload: run_controls(payload["instance"]),
    "score": lambda payload: score(payload["instance"], payload["candidate_diff"]),
    "run_self_test": lambda payload: run_self_test(
        payload["instance"], payload["candidate_diff"], payload["added_test_paths"]
    ),
    "preflight": lambda payload: preflight(payload["languages"]),
}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in _COMMANDS:
        print(
            json.dumps({"error": f"usage: python -m scorer.score {{{'|'.join(_COMMANDS)}}} < payload.json"}),
        )
        return 2
    try:
        payload = json.load(sys.stdin)
        # TRANSPORT ISOLATION: the swebench/multi-swe harnesses print progress and error text
        # to stdout (e.g. "Error building image ...: Environment image ... not found"). stdout
        # is this process's RESULT channel -- a caller redirecting it to a file must get exactly
        # one JSON object. Without this, harness noise preceded the JSON and the caller could
        # not parse its own error report. Noise goes to stderr, where the caller's logs are.
        with contextlib.redirect_stdout(sys.stderr):
            result = _COMMANDS[argv[0]](payload)
    except Exception as exc:  # noqa: BLE001 - deliberately catch-all: transport boundary
        # FAIL-CLOSED: a transport/harness failure is reported as an error, never
        # coerced into a false "resolved": false / true result.
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
