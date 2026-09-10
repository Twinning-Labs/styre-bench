"""Every `build_env_images` call must pass its image tags explicitly.

swebench 4.1.0 has a positional-argument mismatch: `get_test_specs_from_dataset` calls
`make_test_spec(x, namespace, instance_image_tag, env_image_tag)` positionally, while that
signature is `(instance, namespace, base_image_tag, env_image_tag, instance_image_tag, arch)`.
The third positional therefore lands in the `base_image_tag` slot. `build_env_images` defaults
its tag arguments to None, so a call that relies on those defaults makes `base_image_tag` None
and trips `assert base_image_tag is not None` inside swebench.

The harness's own `main()` never hits this because it passes "latest". This test pins the
adapter to doing the same, at every call site, so the guard cannot be tidied away.
"""

from __future__ import annotations

import ast
from pathlib import Path

ADAPTER = Path(__file__).resolve().parents[1] / "adapters" / "swebench.py"

REQUIRED_TAGS = {"instance_image_tag", "env_image_tag"}


def _build_env_images_calls() -> list[ast.Call]:
    tree = ast.parse(ADAPTER.read_text(encoding="utf8"))
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "build_env_images"
    ]


def test_adapter_has_build_env_images_calls():
    # If this fails, the image-building phase was dropped -- run_instance() then fails with
    # "Environment image ... not found", which is the defect this whole guard exists for.
    assert _build_env_images_calls(), "adapter must build env images before run_instance"


def test_every_call_passes_explicit_image_tags():
    for call in _build_env_images_calls():
        kwargs = {kw.arg: kw.value for kw in call.keywords if kw.arg}
        missing = REQUIRED_TAGS - kwargs.keys()
        assert not missing, (
            f"build_env_images at line {call.lineno} omits {sorted(missing)}; "
            "the None defaults reach make_test_spec's base_image_tag slot and trip its assertion"
        )
        for tag in REQUIRED_TAGS:
            value = kwargs[tag]
            assert isinstance(value, ast.Constant) and isinstance(value.value, str), (
                f"build_env_images at line {call.lineno} passes a non-literal {tag}; "
                "it must be an explicit string tag such as \"latest\""
            )
