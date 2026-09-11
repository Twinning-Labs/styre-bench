"""ENG-420: a failed env-image build must name its own cause.

The defect these pin: `build_env_images` returns `(successful, failed)` without raising, both
were discarded, and the run died several steps later with "Environment image ... not found" --
a true statement, not the cause, and pointing at the wrong thing (image tags). Diagnosing the
real reason took a kernel log.
"""

from __future__ import annotations

import pytest

from adapters.env_build import (
    env_build_log_path,
    failed_image_names,
    summarize_env_build_failure,
)

IMAGE = "sweb.env.py.x86_64.1c1a6945f732f9391228c5:latest"
INSTANCE = "pytest-dev__pytest-5631"

#: The tail of the real log from the 2026-09-11 droplet run, verbatim in shape.
OOM_LOG = """+ /opt/miniconda3/bin/conda create -n testbed python=3.9 -y
Collecting package metadata (repodata.json): ...working...
/opt/miniconda3/etc/profile.d/conda.sh: line 1:    12 Killed    ( "$CONDA_EXE" "$@" )
ERROR - Error: The command '/bin/sh -c /bin/bash -c "source ~/.bashrc && /root/setup_env.sh"' returned a non-zero code: 137
ERROR - docker.errors.BuildError during sweb.env.py.x86_64.1c1a6945f732f9391228c5:latest: returned a non-zero code: 137
"""

PLAIN_FAILURE_LOG = """Step 4/9 : RUN pip install -r requirements.txt
ERROR - Error: The command returned a non-zero code: 1
"""


def test_the_message_says_it_is_a_BUILD_failure_not_a_missing_image() -> None:
    msg = summarize_env_build_failure([IMAGE], INSTANCE, lambda _n: OOM_LOG)
    assert "FAILED TO BUILD" in msg
    # The exact wrong conclusion this replaces -- never re-state it.
    assert "not a missing-image or wrong-tag problem" in msg
    assert INSTANCE in msg


def test_an_OOM_kill_is_named_as_such_with_the_remedy() -> None:
    msg = summarize_env_build_failure([IMAGE], INSTANCE, lambda _n: OOM_LOG)
    assert "OOM" in msg
    assert "137" in msg
    # Naming the symptom is not enough; the operator needs the next action.
    assert "journalctl" in msg
    assert "memory" in msg.lower()


def test_a_non_OOM_failure_is_NOT_reported_as_an_OOM() -> None:
    """Over-claiming a cause is as bad as hiding one -- it sends the next person to the wrong place."""
    msg = summarize_env_build_failure([IMAGE], INSTANCE, lambda _n: PLAIN_FAILURE_LOG)
    assert "OOM" not in msg
    assert "non-zero code: 1" in msg


def test_the_error_carries_the_log_path_and_its_last_error_lines() -> None:
    msg = summarize_env_build_failure([IMAGE], INSTANCE, lambda _n: OOM_LOG)
    assert str(env_build_log_path(IMAGE)) in msg
    assert "returned a non-zero code: 137" in msg
    # Bounded: a build log is thousands of lines of conda output.
    assert len(msg.splitlines()) < 15


def test_a_missing_log_is_reported_honestly_rather_than_guessed_at() -> None:
    msg = summarize_env_build_failure([IMAGE], INSTANCE, lambda _n: None)
    assert "no build log" in msg
    assert "OOM" not in msg


def test_every_failed_image_is_listed_not_just_the_first() -> None:
    other = "sweb.env.py.x86_64.deadbeef:latest"
    msg = summarize_env_build_failure([IMAGE, other], INSTANCE, lambda _n: OOM_LOG)
    assert IMAGE in msg
    assert other in msg
    assert "2 environment image(s)" in msg


def test_env_build_log_path_matches_swebenchs_own_naming() -> None:
    # swebench writes to ENV_IMAGE_BUILD_DIR / image_name.replace(":", "__"). Verified against the
    # real droplet path: logs/build_images/env/sweb.env.py.x86_64.1c1a6945f732f9391228c5__latest/
    assert env_build_log_path(IMAGE).as_posix() == (
        "logs/build_images/env/sweb.env.py.x86_64.1c1a6945f732f9391228c5__latest/build_image.log"
    )


class TestFailedImageNames:
    """`failed` holds swebench's PAYLOAD TUPLES. A diagnostic must never be the thing that raises."""

    def test_extracts_the_image_name_from_a_payload_tuple(self) -> None:
        payload = (IMAGE, {"setup_env.sh": "..."}, "FROM x", "linux/amd64", object(), "d")
        assert failed_image_names([payload]) == [IMAGE]

    def test_accepts_a_bare_string(self) -> None:
        assert failed_image_names([IMAGE]) == [IMAGE]

    def test_an_unexpected_shape_degrades_instead_of_raising(self) -> None:
        # swebench owns that tuple's shape; if it changes we still want an error message.
        got = failed_image_names([object(), (), (123,)])
        assert len(got) == 3
        assert all(isinstance(g, str) for g in got)


# -- the PATH, not just the pieces -------------------------------------------------------------


class TestAdapterRaisesOnAFailedBuild:
    """Testing only `summarize_env_build_failure` would repeat the original defect one level up:
    a perfect message nothing ever constructs. These drive the adapter's own build helper."""

    def _helper(self):
        from adapters.swebench import _build_env_images_or_raise

        return _build_env_images_or_raise

    def test_a_reported_failure_RAISES_instead_of_falling_through_to_run_instance(self) -> None:
        def fake_build(*_a, **_kw):
            payload = (IMAGE, {}, "FROM x", "linux/amd64", None, "d")
            return [], [payload]

        with pytest.raises(RuntimeError) as exc:
            self._helper()(fake_build, object(), {"instance_id": INSTANCE}, INSTANCE)
        assert "FAILED TO BUILD" in str(exc.value)
        assert IMAGE in str(exc.value)

    def test_a_clean_build_does_NOT_raise(self) -> None:
        def fake_build(*_a, **_kw):
            return [(IMAGE, {}, "FROM x", "linux/amd64", None, "d")], []

        self._helper()(fake_build, object(), {"instance_id": INSTANCE}, INSTANCE)

    def test_the_no_op_case_does_not_raise(self) -> None:
        # `build_env_images` returns ([], []) when nothing needs building -- the steady state.
        # An empty `failed` must never be read as a failure.
        self._helper()(lambda *_a, **_kw: ([], []), object(), {"instance_id": INSTANCE}, INSTANCE)

    def test_the_build_runs_under_the_host_wide_lock(self) -> None:
        """The build must be serialized, or three concurrent scorer processes OOM the host again."""
        import adapters.swebench as mod

        held: list[bool] = []

        def fake_build(*_a, **_kw):
            held.append(mod.image_build_lock is not None)
            return [], []

        # Prove the lock is actually entered by observing it is HELD during the build: a second
        # non-blocking acquire from this same process must fail while the block is running.
        import fcntl
        import os

        from adapters.build_lock import LOCK_PATH

        def probing_build(*_a, **_kw):
            fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_RDWR, 0o644)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(False)  # acquired => the helper was NOT holding it
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except BlockingIOError:
                    held.append(True)  # could not acquire => the helper holds it
            finally:
                os.close(fd)
            return [], []

        del fake_build
        self._helper()(probing_build, object(), {"instance_id": INSTANCE}, INSTANCE)
        assert held == [True]
