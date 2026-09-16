"""Finite, fingerprinted MUI timeout profile; no test filtering or retries.

The old 2s default and explicit 10s npm/envinfo probe were host-time limits, not
functional assertions. This profile raises positive budgets below 30s, preserving
disabled/larger budgets. It is a distinct oracle environment, not stock MSB.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
from importlib.metadata import version
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

PROFILE = json.loads((Path(__file__).resolve().parents[2] / "scoring/profiles/mui-timeouts-v1.json").read_text())


def selected_profile(instance_id: str, raw: dict) -> dict | None:
    expected = PROFILE["instances"].get(instance_id)
    if expected is None:
        return None
    if raw.get("base", {}).get("sha") != expected["base"]:
        raise ValueError(f"{PROFILE['id']}: changed corpus base for {instance_id}")
    return expected


def profile_command(native: str, *, base: bool, mocha: str) -> tuple[str, dict]:
    filename = "test-run.sh" if base else "fix-run.sh"
    digest = hashlib.sha256(native.encode()).hexdigest()
    if digest != PROFILE["scripts"][filename]:
        raise ValueError(f"{PROFILE['id']}: native {filename} fingerprint changed")
    preload = (
        f"const EXPECTED_MOCHA_VERSION = {json.dumps(mocha)};\n"
        f"const MINIMUM_TIMEOUT_MS = {PROFILE['minimum_timeout_ms']};\n"
        + Path(__file__).with_name("mui_timeout.cjs").read_text()
    )
    encoded = base64.b64encode(preload.encode()).decode()
    # Outside the checkout and created after patch application: a candidate cannot
    # accidentally overwrite the harness-owned preload via an ordinary git patch.
    invocation = "yarn run test:unit --reporter json "
    replacement = (
        'profile_file=$(mktemp /tmp/styre-mui-timeout-XXXXXX.cjs)\n'
        'trap \'rm -f "$profile_file"\' EXIT\n'
        f"printf %s {shlex.quote(encoded)} | base64 -d > \"$profile_file\"\n"
        + invocation + '--require "$profile_file"'
    )
    executed = native.replace(invocation, replacement)
    # Check actual cached image script, not only the installed wheel's template.
    check = f"printf '%s\\n' '{digest}  /home/{filename}' | sha256sum -c - >&2\n"
    executed = executed.replace("set -e\n", "set -e\n" + check, 1)
    return "bash -c " + shlex.quote(executed), {
        "id": PROFILE["id"], "minimum_timeout_ms": PROFILE["minimum_timeout_ms"],
        "mocha_version": mocha, "native_script_sha256": digest,
        "executed_script_sha256": hashlib.sha256(executed.encode()).hexdigest(),
        "preload_sha256": hashlib.sha256(preload.encode()).hexdigest(),
        "native_script": native, "executed_script": executed,
    }


def native_profile_command(raw: dict, *, base: bool, mocha: str) -> tuple[str, dict]:
    if version("multi-swe-bench") != PROFILE["harness_version"]:
        raise ValueError(f"{PROFILE['id']}: unsupported multi-swe-bench version")
    from multi_swe_bench.harness.dataset import Dataset
    from multi_swe_bench.harness.image import Config
    from multi_swe_bench.harness.instance import Instance
    inst = Instance.create(Dataset.from_json(json.dumps(raw)), Config(False, None, True))
    files = {f.name: f.content for f in inst.dependency().files()}
    command, evidence = profile_command(files["test-run.sh" if base else "fix-run.sh"], base=base, mocha=mocha)
    evidence.update({"image": inst.name(), "base_commit": raw["base"]["sha"], "harness_version": version("multi-swe-bench")})
    return command, evidence


def inspect_image_id(name: str) -> str:
    result = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", name],
        capture_output=True, text=True, check=True, timeout=30,
    )
    image_id = result.stdout.strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("MUI profile: Docker returned no immutable image identity")
    return image_id


def assert_idle_docker() -> None:
    # A killed harness may leave its detached Docker container running. Do not
    # admit another run after releasing the process lock in that situation.
    result = subprocess.run(["docker", "ps", "-q"], capture_output=True, text=True, check=True, timeout=30)
    if result.stdout.strip():
        raise RuntimeError(f"{PROFILE['id']}: Docker host is busy; finish/inspect running containers before scoring")


@contextmanager
def serial_profile_lock(*, lock_path: Path | None = None, timeout_s: float = 5400):
    """Strict process-wide admission, including image build and evaluation.

    This coordinates cooperating MUI scorers, not arbitrary host processes.
    Pipeline concurrency must also be one; use a dedicated Docker host.
    """
    import fcntl
    path = lock_path or Path(tempfile.gettempdir()) / "styre-bench-mui-oracle.lock"
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"{PROFILE['id']}: timed out waiting for oracle lock")
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        yield
    finally:
        os.close(fd)
