"""Pre-create the Multi-SWE-bench harness's fixed-name container (ENG-419).

WHY THIS EXISTS. Every TypeScript cell of the 2026-09-11 matrix died before evaluation began:

    Error starting nix_swe container: 409 Client Error ... Conflict
    ("Conflict. The container name "/nix_swe" is already in use by container "a6669667094e...")

`multi_swe_bench/harness/run_evaluation.py`, in `__main__`, before it parses a single argument:

    try:
        container = client.containers.get("nix_swe")
    except docker.errors.NotFound:
        client.containers.run("mswebench/nix_swe:v1.0", "true", name="nix_swe")
    except Exception as e:
        print(f"Error starting nix_swe container: {e}")
        sys.exit(1)

A textbook check-then-act race. Process A finds no `nix_swe` and begins creating it; process B
checks a moment later, also finds none, calls `run(name="nix_swe")`, gets a 409, and exits 1 --
before any evaluation work starts. `build_dataset.py` carries a duplicate of the same block.

It lives in the wheel, so it is not patchable from here. But it is entirely avoidable. The
container runs `"true"` and exits immediately, so once it exists at all -- in ANY state, Exited
included -- `containers.get` succeeds and the `NotFound` branch is never taken again. The race
therefore exists only on a cold host during the first concurrent burst, which is precisely the
shape of a matrix starting on a freshly provisioned droplet at `concurrency: 3`.

So: create it once, before dispatching any harness invocation.

WHAT ACTUALLY FIXES IT, precisely. Two things, and the lock is NOT one of them:
  1. Pre-creating the container before the harness runs, so the harness's `containers.get`
     succeeds and its `NotFound` branch -- the only place it can 409 -- is never taken.
  2. Treating a lost race (409) here as SUCCESS. The container exists, which is all we wanted;
     reporting failure would manufacture the very error we are preventing.
Both hold with no lock at all, and a test pins that.

WHAT THE LOCK IS FOR, then: `containers.run` PULLS `mswebench/nix_swe:v1.0` (a 364 MB download
per Docker Hub, larger once unpacked) when the
image is absent, so three unserialized callers on a cold host mean three concurrent pulls. On the
very host where ENG-420 was an OOM kill, that is worth avoiding. Measured on the droplet with the
container removed: cold, 25.7s and outcomes ["created", "present", "present"] -- one pull. Warm,
0.2s and three "present".

Deliberately NOT solved by lowering `concurrency`. That trades throughput for a race it would
narrow rather than remove -- two processes can still collide inside the window.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Callable

from .build_lock import image_build_lock

CONTAINER_NAME = "nix_swe"
IMAGE = "mswebench/nix_swe:v1.0"

#: Its own lock, not the image-build one: this is a sub-second `docker inspect`, and queueing it
#: behind a multi-minute conda build would serialize every MSB instance behind an unrelated one.
LOCK_PATH = Path(tempfile.gettempdir()) / "styre-bench-nix-swe.lock"

#: What `ensure_nix_swe` did, for logging. "present" and "created" are both success.
Outcome = str


def ensure_nix_swe(docker_module: Any | None = None) -> Outcome:
    """Make sure the harness's `nix_swe` container exists. Idempotent, serialized, best-effort.

    Returns "present" (already there), "created" (we made it), "raced" (someone else created it
    between our check and our create -- also success), or "unavailable:<reason>".

    NEVER raises. This is a pre-emptive courtesy to the harness, not a precondition of scoring: if
    Docker is unreachable the harness's own attempt will fail and report it, and turning that into
    an exception here would convert a race we might have avoided into one we definitely caused.
    """
    try:
        docker = docker_module if docker_module is not None else __import__("docker")
    except Exception as exc:  # noqa: BLE001 - best-effort by contract
        return f"unavailable:no-docker-module({type(exc).__name__})"

    try:
        with image_build_lock(timeout_s=120, lock_path=LOCK_PATH):
            client = docker.from_env()
            try:
                client.containers.get(CONTAINER_NAME)
                return "present"
            except docker.errors.NotFound:
                pass
            try:
                client.containers.run(IMAGE, "true", name=CONTAINER_NAME)
                return "created"
            except docker.errors.APIError as exc:
                # A 409 here means another process won despite the lock (a lock that could not be
                # taken, or a container created out-of-band). The container exists, which is all
                # we wanted -- that is success, not failure.
                if _is_name_conflict(exc):
                    return "raced"
                return f"unavailable:api-error({exc})"
    except Exception as exc:  # noqa: BLE001 - best-effort by contract
        return f"unavailable:{type(exc).__name__}({exc})"
    # Unreachable: every branch inside the `with` returns. Present so the function cannot fall off
    # the end as None, which would read as a falsy "no outcome" at the call site.
    return "unavailable:unreachable"


def _is_name_conflict(exc: Exception) -> bool:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status == 409 or "already in use" in str(exc)


#: Fingerprints of the harness's own failure line, so a recurrence is named rather than buried in
#: a wall of captured stdout.
_NIX_SWE_MARKERS = ("Error starting nix_swe container", "is already in use by container")


def nix_swe_failure_hint(stdout: str, stderr: str) -> str | None:
    """If the harness died on the `nix_swe` race, explain it. Else None.

    Without this the operator gets "harness invocation failed (exit 1)" plus the raw capture, and
    has to recognise a third-party race inside it. The whole cost of ENG-419 was the time between
    seeing that error and understanding it.
    """
    blob = f"{stdout}\n{stderr}"
    if not any(marker in blob for marker in _NIX_SWE_MARKERS):
        return None
    return (
        "This is the multi-swe-bench `nix_swe` container-name race (ENG-419), not a fault in the "
        "instance or the candidate diff. The harness creates a container with the hardcoded name "
        f"{CONTAINER_NAME!r} using a check-then-act that is not safe under concurrency, and exits "
        "1 before any evaluation begins. `ensure_nix_swe()` should have pre-created it -- check "
        "whether it reported `unavailable:...` (Docker unreachable, or the lock could not be "
        f"taken). Recovering by hand: `docker rm -f {CONTAINER_NAME}` and re-run."
    )
