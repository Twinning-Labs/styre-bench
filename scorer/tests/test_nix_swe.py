"""ENG-419: the multi-swe-bench `nix_swe` container-name race.

Every TypeScript cell of the 2026-09-11 matrix died here, two on a 409 Conflict and the third
behind them on a timeout. The harness's own block is a check-then-act:

    try:    containers.get("nix_swe")
    except NotFound:  containers.run(..., name="nix_swe")
    except Exception: print(...); sys.exit(1)

so the fix is to create it ONCE, up front, under a lock. These tests use a fake Docker whose
`containers.run` genuinely refuses a duplicate name, so the race is reproducible without Docker.
"""

from __future__ import annotations

import threading

import pytest

from adapters.nix_swe import CONTAINER_NAME, IMAGE, ensure_nix_swe, nix_swe_failure_hint


class NotFound(Exception):
    pass


class APIError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.response = type("R", (), {"status_code": status_code})()


class FakeContainers:
    """Models the one behaviour that matters: a duplicate name is a 409, exactly as Docker does."""

    def __init__(self, store: dict[str, str], lock: threading.Lock, on_create=None):
        self._store, self._lock, self._on_create = store, lock, on_create

    def get(self, name: str):
        if name not in self._store:
            raise NotFound(f"no such container {name}")
        return object()

    def run(self, image: str, _cmd: str, name: str):
        if self._on_create:
            self._on_create()  # a seam for widening the race window
        with self._lock:
            if name in self._store:
                raise APIError(
                    f'Conflict. The container name "/{name}" is already in use by container "abc".',
                    status_code=409,
                )
            self._store[name] = image
        return object()


class FakeDocker:
    errors = type("E", (), {"NotFound": NotFound, "APIError": APIError})

    def __init__(self, store=None, on_create=None):
        self.store = {} if store is None else store
        self._containers = FakeContainers(self.store, threading.Lock(), on_create)

    def from_env(self):
        return type("C", (), {"containers": self._containers})()


def test_a_cold_host_gets_the_container_created() -> None:
    d = FakeDocker()
    assert ensure_nix_swe(docker_module=d) == "created"
    assert d.store == {CONTAINER_NAME: IMAGE}


def test_it_is_idempotent_when_the_container_already_exists() -> None:
    d = FakeDocker(store={CONTAINER_NAME: IMAGE})
    assert ensure_nix_swe(docker_module=d) == "present"


def test_an_EXITED_container_still_counts_as_present() -> None:
    """The container runs `true`, so it is Exited within moments of creation. `containers.get`
    finds it in any state -- reading only running containers would recreate it forever."""
    d = FakeDocker(store={CONTAINER_NAME: IMAGE})  # get() is state-blind, as Docker's is
    assert ensure_nix_swe(docker_module=d) == "present"
    assert list(d.store) == [CONTAINER_NAME]


def test_repeated_calls_never_create_a_second_container() -> None:
    d = FakeDocker()
    outcomes = [ensure_nix_swe(docker_module=d) for _ in range(5)]
    assert outcomes == ["created", "present", "present", "present", "present"]
    assert len(d.store) == 1


def test_a_409_from_a_lost_race_is_SUCCESS_not_failure() -> None:
    """Someone else created it between our check and our create. The container exists, which is
    all we wanted; reporting failure here would manufacture the very error we are preventing."""

    class Racy(FakeDocker):
        def __init__(self):
            super().__init__()
            self._first = True

        def from_env(self):
            outer = self

            class C:
                @property
                def containers(inner):
                    class Ctr:
                        def get(self, name):
                            raise NotFound(name)  # always "absent" to force the create path

                        def run(self, image, cmd, name):
                            raise APIError(
                                f'Conflict. The container name "/{name}" is already in use.',
                                status_code=409,
                            )

                    return Ctr()

            return C()

    assert ensure_nix_swe(docker_module=Racy()) == "raced"


def _run_concurrently(d: FakeDocker, n: int = 3) -> list[str]:
    results: list[str] = []
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            results.append(ensure_nix_swe(docker_module=d))
        except BaseException as exc:  # noqa: BLE001 - the point is that nothing escapes
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert errors == [], errors
    assert len(results) == n
    return results


def test_concurrent_callers_on_a_COLD_host_all_succeed() -> None:
    """The regression itself: three instances dispatched at once with no container present.

    `on_create` widens the check-then-act window so a broken implementation fails reliably rather
    than occasionally.
    """
    import time

    d = FakeDocker(on_create=lambda: time.sleep(0.05))
    results = _run_concurrently(d)

    # Every caller must end up with the container available -- none may report unavailable.
    assert all(not r.startswith("unavailable") for r in results), results
    assert len(d.store) == 1


def test_only_one_caller_ATTEMPTS_the_create_which_is_what_the_lock_buys() -> None:
    """What the lock is actually for -- and it is NOT correctness.

    Correctness comes from two other things: pre-creating the container before the harness runs,
    and treating a lost race (409) as success. Both hold with no lock at all; an unserialized
    version passes the test above. Saying the lock fixes the race would be overstating it.

    What the lock buys is that only ONE process calls `containers.run`. That call PULLS
    `mswebench/nix_swe:v1.0` -- 1.5 GB -- when absent, so on a cold host three concurrent callers
    mean three concurrent pulls. On the very host where ENG-420 was an OOM kill, that is worth
    avoiding. This test pins the real benefit rather than a claimed one.
    """
    import time

    attempts: list[float] = []

    def record() -> None:
        attempts.append(time.monotonic())
        time.sleep(0.05)  # widen the window a lock must cover

    d = FakeDocker(on_create=record)
    results = _run_concurrently(d)

    assert all(not r.startswith("unavailable") for r in results), results
    assert len(attempts) == 1, (
        f"{len(attempts)} processes called containers.run; each pulls a 1.5 GB image on a cold "
        f"host. The build lock should have left exactly one."
    )
    assert results.count("created") == 1
    assert results.count("present") == 2


class TestBestEffortContract:
    """`ensure_nix_swe` must NEVER raise: it is a courtesy to the harness, not a precondition.
    Turning a race we might have avoided into an exception we definitely caused is strictly worse."""

    def test_a_missing_docker_module_falls_back_to_the_real_import(self, monkeypatch) -> None:
        """`docker_module=None` must import `docker` itself, and still never raise.

        This used to assert only `is not None`. Every branch of `ensure_nix_swe` returns a
        string, so that could not fail on any host. It also took the REAL Docker path: on a
        machine with a live daemon -- every Linux CI runner -- it reached
        `containers.run(IMAGE, ...)`, and docker-py auto-pulls on ImageNotFound, so the
        "no Docker, no network" unit suite quietly pulled a 364 MB image.

        Patching `from_env` on the real module keeps the fallback under test (the patch is
        reachable ONLY through `__import__("docker")`) while contacting nothing: drop the
        fallback and the sentinel never appears. (ENG-438)
        """
        import docker

        sentinel = "sentinel: this test must not consult a daemon"

        def boom():
            raise OSError(sentinel)

        monkeypatch.setattr(docker, "from_env", boom)
        got = ensure_nix_swe(docker_module=None)
        assert got.startswith("unavailable:"), got
        assert sentinel in got, got

    def test_an_exploding_docker_client_is_reported_not_raised(self) -> None:
        class Exploding:
            errors = FakeDocker.errors

            def from_env(self):
                raise OSError("docker daemon unreachable")

        got = ensure_nix_swe(docker_module=Exploding())
        assert got.startswith("unavailable:")
        assert "docker daemon unreachable" in got

    def test_a_non_conflict_api_error_is_reported_not_raised(self) -> None:
        class Broken(FakeDocker):
            def from_env(self):
                class Ctr:
                    def get(self, name):
                        raise NotFound(name)

                    def run(self, image, cmd, name):
                        raise APIError("no such image", status_code=404)

                return type("C", (), {"containers": Ctr()})()

        got = ensure_nix_swe(docker_module=Broken())
        assert got.startswith("unavailable:")


class TestFailureHint:
    def test_the_real_harness_output_is_recognised_and_named(self) -> None:
        stdout = (
            'Error starting nix_swe container: 409 Client Error for '
            'http+docker://localhost/v1.56/containers/create?name=nix_swe: Conflict '
            '("Conflict. The container name "/nix_swe" is already in use by container "a666...")'
        )
        hint = nix_swe_failure_hint(stdout, "")
        assert hint is not None
        assert "ENG-419" in hint
        # It must exonerate the instance -- otherwise the next reader debugs the candidate diff.
        assert "not a fault in the instance" in hint
        assert "docker rm -f nix_swe" in hint

    def test_an_unrelated_harness_failure_gets_NO_hint(self) -> None:
        """Attaching this explanation to every failure would make it worthless."""
        assert nix_swe_failure_hint("ValueError: Workdir not found", "") is None
        assert nix_swe_failure_hint("", "Traceback ... KeyError: 'f2p_tests'") is None

    def test_the_hint_is_found_on_stderr_too(self) -> None:
        assert nix_swe_failure_hint("", "Error starting nix_swe container: boom") is not None
