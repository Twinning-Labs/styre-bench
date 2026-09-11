"""`_ensure_images_or_raise` — the pull/build fork in behaviour, not just in source (ENG-429)."""

from __future__ import annotations

import sys
import types

import pytest

from scorer.adapters.image_source import NAMESPACE_ENV
from scorer.adapters.swebench import _ensure_images_or_raise


class _ImageNotFound(Exception):
    pass


class _NotFound(Exception):
    pass


@pytest.fixture(autouse=True)
def _fake_docker_errors(monkeypatch):
    """Stub `docker.errors` so these run with no Docker and no network."""
    errors = types.SimpleNamespace(ImageNotFound=_ImageNotFound, NotFound=_NotFound)
    monkeypatch.setitem(sys.modules, "docker", types.SimpleNamespace(errors=errors))
    monkeypatch.setitem(sys.modules, "docker.errors", errors)
    monkeypatch.delenv(NAMESPACE_ENV, raising=False)


class FakeImages:
    def __init__(self, present: bool, pullable: bool = True):
        self.present, self.pullable = present, pullable
        self.got: list[str] = []
        self.pulled: list[str] = []

    def get(self, key):
        self.got.append(key)
        if not self.present:
            raise _ImageNotFound(key)
        return object()

    def pull(self, key):
        self.pulled.append(key)
        if not self.pullable:
            raise _NotFound(key)
        return object()


class FakeClient:
    def __init__(self, images):
        self.images = images


SPEC = types.SimpleNamespace(instance_image_key="swebench/sweb.eval.x86_64.django_1776_x:latest")


def _never_build(*_a, **_k):
    raise AssertionError("build_env_images must not be called when pulling")


def test_pull_mode_pulls_and_never_builds():
    images = FakeImages(present=False)
    _ensure_images_or_raise(_never_build, FakeClient(images), {}, SPEC, "django__django-x")
    assert images.pulled == [SPEC.instance_image_key]


def test_an_image_already_local_is_not_pulled_again():
    images = FakeImages(present=True)
    _ensure_images_or_raise(_never_build, FakeClient(images), {}, SPEC, "django__django-x")
    assert images.pulled == []


def test_a_missing_published_image_RAISES_rather_than_building_one():
    # THE CONTRACT. Falling back would put a locally-built verdict in the report wearing the same
    # clothes as a published one.
    images = FakeImages(present=False, pullable=False)
    with pytest.raises(RuntimeError) as exc:
        _ensure_images_or_raise(_never_build, FakeClient(images), {}, SPEC, "django__django-x")
    assert "no published evaluation image" in str(exc.value)
    assert NAMESPACE_ENV in str(exc.value)


def test_local_mode_builds_and_never_pulls(monkeypatch):
    monkeypatch.setenv(NAMESPACE_ENV, "local")
    built: list[str] = []
    images = FakeImages(present=False, pullable=False)  # a pull here would raise

    def fake_build(*_a, **_k):
        built.append("built")
        return ([], [])  # (successful, failed)

    monkeypatch.setattr("scorer.adapters.swebench.build_env_images", fake_build, raising=False)
    monkeypatch.setattr("scorer.adapters.swebench._build_env_images_or_raise",
                        lambda *_a, **_k: built.append("built"))
    _ensure_images_or_raise(fake_build, FakeClient(images), {}, SPEC, "django__django-x")
    assert built == ["built"]
    assert images.pulled == []


# ── _test_spec_for: the one line that decides pull-vs-build ─────────────────────────────────

def _capture_spec_call(monkeypatch, env: str | None):
    from scorer.adapters.swebench import _test_spec_for

    if env is None:
        monkeypatch.delenv(NAMESPACE_ENV, raising=False)
    else:
        monkeypatch.setenv(NAMESPACE_ENV, env)
    seen: dict = {}

    def fake_make_test_spec(instance, **kwargs):
        seen.update(kwargs)
        seen["instance"] = instance
        return types.SimpleNamespace(**kwargs)

    _test_spec_for(fake_make_test_spec, {"instance_id": "x"})
    return seen


def test_the_spec_carries_the_PULL_namespace_by_default(monkeypatch):
    # THE LINE THAT MATTERS. A source invariant proves `namespace=` is passed; only this proves
    # it is passed the right VALUE. Mutating it to None survived the invariant untouched, and
    # None is exactly the old build-locally default this change exists to remove.
    seen = _capture_spec_call(monkeypatch, None)
    assert seen["namespace"] == "swebench"


def test_the_spec_carries_None_when_local_building_is_chosen(monkeypatch):
    seen = _capture_spec_call(monkeypatch, "local")
    assert seen["namespace"] is None


def test_every_tag_is_passed_by_KEYWORD_and_explicitly(monkeypatch):
    # swebench 4.1.0's own `get_test_specs_from_dataset` passes these positionally in a DIFFERENT
    # order than the signature declares, so a positional call here lands `instance_image_tag` in
    # the `base_image_tag` slot and trips an assertion inside the harness.
    seen = _capture_spec_call(monkeypatch, None)
    assert seen["base_image_tag"] == "latest"
    assert seen["env_image_tag"] == "latest"
    assert seen["instance_image_tag"] == "latest"
