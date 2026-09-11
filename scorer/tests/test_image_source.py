"""Where evaluation images come from (ENG-429).

The adapter called `make_test_spec(raw)`, whose `namespace=None` default means BUILD LOCALLY --
the opposite of the harness's own default. `sphinx-doc__sphinx-7590`'s image was built here on
2026-09-11, its unpinned `docutils>=0.12` resolved to docutils 0.23 against a Sphinx 3.1.0.dev
from 2020, and every test in `tests/test_domain_cpp.py` died at conftest load on
`No module named 'roman'` -- 24 of 24 PASS_TO_PASS and the single FAIL_TO_PASS, identically,
across six runs, INCLUDING the gold patch.
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path

import pytest

from adapters.image_source import (
    DEFAULT_NAMESPACE,
    NAMESPACE_ENV,
    builds_locally,
    image_namespace,
    image_source_description,
    missing_published_image_hint,
)

ADAPTER = Path(__file__).resolve().parents[1] / "adapters" / "swebench.py"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(NAMESPACE_ENV, raising=False)


def test_default_is_to_pull_the_published_image():
    # THE FIX. The old default built every image from today's package index.
    assert image_namespace() == DEFAULT_NAMESPACE
    assert builds_locally() is False


@pytest.mark.parametrize("value", ["", "local", "LOCAL", "none", "  local  "])
def test_local_building_is_an_explicit_opt_in(monkeypatch, value):
    monkeypatch.setenv(NAMESPACE_ENV, value)
    assert image_namespace() is None
    assert builds_locally() is True


def test_an_arbitrary_namespace_is_honoured(monkeypatch):
    # A mirror or a fork's own published images.
    monkeypatch.setenv(NAMESPACE_ENV, "myorg")
    assert image_namespace() == "myorg"
    assert builds_locally() is False


def test_local_mode_says_the_results_are_not_comparable(monkeypatch):
    monkeypatch.setenv(NAMESPACE_ENV, "local")
    text = image_source_description()
    assert "BUILT LOCALLY" in text
    # The operator must be told the CONSEQUENCE, not just the setting.
    assert "not comparable" in text


def test_pull_mode_names_the_namespace():
    assert DEFAULT_NAMESPACE in image_source_description()
    assert "BUILT LOCALLY" not in image_source_description()


def test_the_missing_image_message_names_the_escape_hatch():
    hint = missing_published_image_hint("django__django-12325", "swebench/sweb.eval.x86_64.x:latest")
    assert "django__django-12325" in hint
    assert NAMESPACE_ENV in hint
    # And why refusing is the default, so "just make it work" does not silently mean
    # "record an incomparable number".
    assert "not comparable" in hint


# ── source invariants ──────────────────────────────────────────────────────────────────────

def _calls_named(name: str) -> list[ast.Call]:
    tree = ast.parse(ADAPTER.read_text(encoding="utf8"))
    return [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name
    ]


def test_no_call_site_builds_a_test_spec_without_choosing_a_namespace():
    """`make_test_spec(raw)` takes swebench's namespace=None default: build locally, silently.

    A grep-level invariant because the defect was a MISSED argument at two identical call sites,
    and a third would reinstate it without failing any behavioural test -- the same reasoning as
    `test_env_build_invariant.py`.
    """
    offenders = []
    for call in _calls_named("make_test_spec"):
        kwargs = {kw.arg for kw in call.keywords if kw.arg}
        if "namespace" not in kwargs:
            offenders.append(call.lineno)
    assert not offenders, (
        f"make_test_spec called without an explicit namespace at line(s) {offenders}; "
        "the None default means build-locally, which is what ENG-429 fixed"
    )


def test_every_image_call_site_goes_through_the_helpers():
    """Both sites must route through `_test_spec_for` / `_ensure_images_or_raise`."""
    source = ADAPTER.read_text(encoding="utf8")
    assert source.count("_test_spec_for(make_test_spec, raw)") == 2
    assert source.count("_ensure_images_or_raise(build_env_images, client, raw, test_spec") == 2


def test_the_build_is_reachable_only_in_local_mode():
    """`_build_env_images_or_raise` must be called behind the `builds_locally()` branch.

    Calling it unconditionally would rebuild locally the very image the run chose to pull --
    reinstating the whole defect while appearing to pull.
    """
    source = ADAPTER.read_text(encoding="utf8")
    body = source[source.index("def _ensure_images_or_raise") : source.index("def _build_env_images_or_raise")]
    assert "if builds_locally():" in body
    guarded = body.index("if builds_locally():")
    assert body.index("_build_env_images_or_raise(") > guarded
    # And nothing else in the module calls it directly.
    others = [
        m.start()
        for m in re.finditer(r"(?<![\w.])_build_env_images_or_raise\s*\(", source)
        if not source[:m.start()].rstrip().endswith("def")
    ]
    assert len(others) == 1, "the local build must have exactly one call site, inside the guard"
