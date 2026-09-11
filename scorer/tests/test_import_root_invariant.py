"""Test modules must import the adapters the way the suite's import root does.

`scorer/conftest.py` puts `scorer/` itself on `sys.path`, because `score.py` is invoked as a
plain script and there is no `scorer/__init__.py`. So `adapters.multiswebench` and
`scorer.adapters.multiswebench` resolve to TWO SEPARATE MODULE OBJECTS with separate globals.

That is not a style preference. A test importing the `scorer.`-prefixed one while patching
`"adapters.multiswebench._raw_instance"` patches a module its code under test never sees — so the
stub does nothing, the adapter reaches for Hugging Face, and the test either hits the network or
fails for a reason that has nothing to do with what it was written to check. Three files landed
that way before this guard existed.
"""

from __future__ import annotations

import re
from pathlib import Path

TESTS = Path(__file__).resolve().parent

#: `from scorer.adapters...` / `import scorer.adapters...` / `patch("scorer.adapters...")`
_PREFIXED = re.compile(r"""(?:from|import)\s+scorer\.adapters|["']scorer\.adapters""")


def test_no_test_module_imports_adapters_through_the_scorer_package():
    offenders = []
    for path in sorted(TESTS.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue  # this file names the pattern in prose
        for lineno, line in enumerate(path.read_text(encoding="utf8").splitlines(), start=1):
            if _PREFIXED.search(line):
                offenders.append(f"{path.name}:{lineno}")
    assert not offenders, (
        "import adapters as `adapters.<mod>` (the suite's import root), not `scorer.adapters.<mod>` "
        f"-- the two are different module objects and patches will not cross: {offenders}"
    )
