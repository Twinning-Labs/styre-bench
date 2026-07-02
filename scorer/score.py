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
`run_self_test`, reading a single JSON object from stdin
(`{"instance": {...}, ...}`) and writing a single JSON object to stdout. On
any exception, writes `{"error": "..."}` to stdout and exits non-zero -- this
is a TRANSPORT failure to the TS caller (re-dispatch/investigate), never a
silent "resolved: false".
"""

from __future__ import annotations

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


_COMMANDS = {
    "run_controls": lambda payload: run_controls(payload["instance"]),
    "score": lambda payload: score(payload["instance"], payload["candidate_diff"]),
    "run_self_test": lambda payload: run_self_test(
        payload["instance"], payload["candidate_diff"], payload["added_test_paths"]
    ),
}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in _COMMANDS:
        print(
            json.dumps({"error": f"usage: python -m scorer.score {{{'|'.join(_COMMANDS)}}} < payload.json"}),
        )
        return 2
    try:
        payload = json.load(sys.stdin)
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
