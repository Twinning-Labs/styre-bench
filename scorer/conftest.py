"""Shared pytest config for the scorer test suite.

Puts `scorer/` itself (this file's directory) on `sys.path` so test modules
can `from adapters.swebench import parse_report` etc. the same way
`scorer/score.py` does (both treat `scorer/` as the import root, not a
`scorer.*` package) -- there is no `scorer/__init__.py` by design, since
`score.py` is meant to be invoked as a plain script (`python scorer/score.py
<command>`), not `python -m scorer.score`.

Also registers the `run_live` marker used to gate the Docker-touching tests
(harness invocation / actual container runs) that only run in the operator's
live pass, per `pytest.ini`-equivalent config below.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "run_live: exercises a real harness invocation (Docker required); "
        "skipped unless the RUN_LIVE env var is set",
    )
