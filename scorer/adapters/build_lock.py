"""One image build at a time, across processes (ENG-420).

WHY THIS EXISTS. The pipeline runs instances at `concurrency: 3`, and each one invokes
`scorer/score.py` as its OWN process. Nothing coordinated them, so three env-image builds could
run at once -- and a single SWE-bench `conda create` was measured at 3.6 GB resident. On the
2026-09-11 droplet (7 GiB usable, no swap) the third build was killed by the OOM killer.

An in-process semaphore cannot fix that: the contenders are separate processes. A file lock can,
and it is the narrowest instrument that works -- it serializes only the BUILD phase. Evaluation,
which is the long part and is not memory-hungry, still runs fully in parallel. Builds are also a
one-time cost: `build_env_images` returns immediately once the image exists, so steady state pays
almost nothing for this.

Deliberately advisory and best-effort: if the lock cannot be taken (a read-only filesystem, a
platform without flock) the build proceeds unserialized rather than failing the run. A missing
optimisation must never become a new failure mode.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

#: Shared by every scorer process on the host. `/tmp` rather than the repo so a read-only or
#: differently-mounted checkout cannot break it.
LOCK_PATH = Path(tempfile.gettempdir()) / "styre-bench-image-build.lock"

#: Generous on purpose. A cold SWE-bench env image (miniconda + a full environment) takes many
#: minutes, and two instances queued behind a third is normal, not stuck.
DEFAULT_TIMEOUT_S = 3600


@contextlib.contextmanager
def image_build_lock(
    timeout_s: int = DEFAULT_TIMEOUT_S, lock_path: Path | None = None
) -> Iterator[bool]:
    """Hold an exclusive host-wide lock for the duration of the block.

    Yields True when the lock was actually held, False when it could not be taken at all (the
    block still runs -- see the module docstring on why this is advisory).
    """
    try:
        import fcntl
    except ImportError:  # not POSIX; nothing to serialize with
        yield False
        return

    path = lock_path or LOCK_PATH
    fd = None
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    except OSError:
        yield False
        return

    import signal

    def _timeout(_signum: int, _frame: object) -> None:
        raise TimeoutError(f"image build lock at {path} not acquired within {timeout_s}s")

    previous = None
    try:
        # SIGALRM turns flock's uninterruptible wait into a bounded one. Only the main thread can
        # install a handler; a non-main thread simply waits, which is the pre-ENG-420 behaviour.
        try:
            previous = signal.signal(signal.SIGALRM, _timeout)
            signal.alarm(timeout_s)
        except ValueError:
            previous = None
        fcntl.flock(fd, fcntl.LOCK_EX)
        if previous is not None:
            signal.alarm(0)
        yield True
    finally:
        if previous is not None:
            with contextlib.suppress(Exception):
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous)
        if fd is not None:
            with contextlib.suppress(Exception):
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
