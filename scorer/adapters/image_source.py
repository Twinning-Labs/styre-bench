"""Where SWE-bench evaluation images come from: pulled, or built here (ENG-429).

WHY THIS EXISTS. The adapter called `make_test_spec(raw)` with swebench's `namespace=None`
default, which means BUILD EVERY IMAGE LOCALLY. The harness's own default is
`namespace="swebench"` -- pull the published image -- and its `main()` skips the whole build
phase whenever a namespace is set (`run_evaluation.main`: `if namespace is None and not
rewrite_reports: build_env_images(...)`).

That one argument cost a matrix cell. `sphinx-doc__sphinx-7590`'s image was built here on
2026-09-11, and its unpinned `docutils>=0.12` resolved to **docutils 0.23** for a Sphinx
3.1.0.dev checkout from 2020. docutils had long since dropped the top-level `roman` shim that
`sphinx/writers/latex.py` imports, so every test in `tests/test_domain_cpp.py` died at conftest
load -- 24 of 24 PASS_TO_PASS and the single FAIL_TO_PASS, identically, across six runs,
INCLUDING the gold patch. The oracle controls correctly dropped the instance. Nothing about the
candidate was ever measured. The same build also installed pytest 8.4.2 against a 2020 Sphinx,
and stamped the version string `Sphinx==3.1.0.dev20260911`.

SWE-bench says this plainly in its own docs: the build pulls from apt/PyPI, so "images built at
different times may not be identical, even if the Dockerfiles and local context are the same".
Building a 2020 environment in 2026 does not reproduce it; it re-resolves it.

NO SILENT FALLBACK. If a published image is missing, this raises rather than quietly building
one, because a locally-built verdict and a canonical one are not the same claim and must not be
recorded as though they were. Falling back would put a divergent result in the report wearing
the same clothes as a comparable one. Local building stays available, as an explicit choice the
operator makes and can see -- which also keeps the escape hatch open if Docker Hub is
unreachable or an instance genuinely has no published image.
"""

from __future__ import annotations

import os

#: The harness's own default namespace, and the org that publishes the images.
DEFAULT_NAMESPACE = "swebench"

#: Set to "" or "local" to build images on this machine instead of pulling them.
NAMESPACE_ENV = "STYRE_BENCH_SWEBENCH_NAMESPACE"

#: Values that mean "build here". `""` matches the harness's own `--namespace ''` convention.
_LOCAL_VALUES = {"", "local", "none"}


def image_namespace() -> str | None:
    """The Docker namespace to pull evaluation images from, or `None` to build locally.

    `None` is the OPT-IN, inverting the previous default. Returning it means every image for
    this run is built from today's package index rather than pulled as published.
    """
    raw = os.environ.get(NAMESPACE_ENV, DEFAULT_NAMESPACE).strip()
    return None if raw.lower() in _LOCAL_VALUES else raw


def builds_locally() -> bool:
    """True iff images will be built on this machine rather than pulled."""
    return image_namespace() is None


def image_source_description() -> str:
    """One line naming where this run's verdicts come from, for logs and error text."""
    ns = image_namespace()
    if ns is None:
        return (
            f"images BUILT LOCALLY ({NAMESPACE_ENV} selects local builds) -- package versions are "
            "resolved at build time, so this environment is not the published one and its verdicts "
            "are not comparable with published SWE-bench results"
        )
    return f"images PULLED from the '{ns}' namespace (published, reproducible)"


def missing_published_image_hint(instance_id: str, image_key: str) -> str:
    """The message for a pull that found nothing. Names the choice, not just the symptom."""
    return (
        f"swebench: no published evaluation image for {instance_id!r} at {image_key!r}. "
        f"Refusing to silently build one: a locally-built environment re-resolves every "
        f"dependency at build time and its verdict is not comparable with a published result "
        f"(sphinx-doc__sphinx-7590 was dropped for exactly that -- a 2026 docutils against a "
        f"2020 Sphinx). To build locally on purpose, set {NAMESPACE_ENV}=local and re-run; "
        f"the report will then be carrying locally-built verdicts."
    )
