"""Turning a failed env-image build into an error that names its own cause (ENG-420).

WHY THIS EXISTS. `swebench.harness.docker_build.build_env_images` does not raise when a build
fails -- it returns `(successful, failed)` and both were being discarded. `run_instance` then
called `build_instance_image`, found no environment image, and raised:

    BuildImageError: Error building image pytest-dev__pytest-5631:
      Environment image sweb.env.py.x86_64.1c1a6945f732f9391228c5:latest not found

Every clause of that is true and none of it is the cause. The real reason was in a log file
nothing reads, and the message actively points the reader at image TAGS -- the wrong place. It
took a kernel log to establish that the build had been killed by the OOM killer:

    conda invoked oom-killer: ... global_oom
    Out of memory: Killed process 24727 (conda) total-vm:3999020kB, anon-rss:3619772kB

So: read the build's own log, and say what happened.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Iterable

#: swebench writes each env build's log to `ENV_IMAGE_BUILD_DIR / <image>:<tag> -> <image>__<tag>`.
ENV_BUILD_LOG_DIR = Path("logs/build_images/env")
BUILD_LOG_NAME = "build_image.log"

#: 137 = 128 + SIGKILL. Docker reports it verbatim; on this host it always meant the OOM killer.
_OOM_EXIT = re.compile(r"non-zero code:\s*137\b")
_OOM_WORDS = re.compile(r"\bKilled\b|\bout of memory\b|\boom-kill", re.IGNORECASE)


def env_build_log_path(image_name: str) -> Path:
    """The log swebench wrote for `image_name`, by its own naming convention."""
    return ENV_BUILD_LOG_DIR / image_name.replace(":", "__") / BUILD_LOG_NAME


def _read(path: Path) -> str | None:
    try:
        return path.read_text(errors="replace")
    except OSError:
        return None


def failed_image_names(failed: Iterable[object]) -> list[str]:
    """Pull image names out of `build_env_images`'s `failed` list.

    Those entries are the PAYLOAD TUPLES handed to the builder, whose first element is the image
    name. Read defensively rather than unpacking positionally: the tuple's shape belongs to
    swebench, and a diagnostic must never be the thing that raises.
    """
    names: list[str] = []
    for entry in failed:
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, (tuple, list)) and entry and isinstance(entry[0], str):
            names.append(entry[0])
        else:
            names.append(repr(entry)[:120])
    return names


def summarize_env_build_failure(
    image_names: list[str],
    instance_id: str,
    read_log: Callable[[str], str | None] | None = None,
) -> str:
    """A failure message that names the cause, not just the consequence.

    `read_log` is the seam: it maps an image name to that build's log text (or None). Defaults to
    reading swebench's own log location; tests inject it so this is provable without Docker.
    """
    reader = read_log if read_log is not None else (lambda n: _read(env_build_log_path(n)))
    parts = [
        f"swebench: {len(image_names)} environment image(s) FAILED TO BUILD for "
        f"{instance_id!r}. The instance was never scored -- this is a build failure, "
        f"not a missing-image or wrong-tag problem."
    ]
    for name in image_names:
        log = reader(name)
        parts.append(f"  - {name}")
        if log is None:
            parts.append(f"      (no build log at {env_build_log_path(name)})")
            continue
        if _OOM_EXIT.search(log) or _OOM_WORDS.search(log):
            parts.append(
                "      KILLED, almost certainly by the OOM killer (exit 137 / 'Killed'). "
                "This host did not have enough memory to build it. Confirm with "
                "`journalctl -k | grep -i oom`, then give the host more RAM or swap, or build "
                "fewer images at once."
            )
        for line in _last_meaningful_lines(log):
            parts.append(f"      {line}")
        parts.append(f"      full log: {env_build_log_path(name)}")
    return "\n".join(parts)


def _last_meaningful_lines(log: str, limit: int = 3) -> list[str]:
    """The last few ERROR lines, else the last few non-blank lines. Truncated -- a build log runs
    to thousands of lines of conda output and none of it belongs in an exception message."""
    lines = [ln.strip() for ln in log.splitlines() if ln.strip()]
    errors = [ln for ln in lines if "ERROR" in ln or "Error" in ln]
    chosen = (errors or lines)[-limit:]
    return [ln if len(ln) <= 200 else f"{ln[:200]}..." for ln in chosen]
