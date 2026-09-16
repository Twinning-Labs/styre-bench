import json
from pathlib import Path
import subprocess
import multiprocessing
import time

import pytest

from adapters import mui_profile as p
from adapters import multiswebench as m

BASE = "#!/bin/bash\nset -e\n\ncd /home/material-ui\ngit apply /home/test.patch\nyarn run test:unit --reporter json \n\n"
FIX = BASE.replace("git apply /home/test.patch", "git apply /home/test.patch /home/fix.patch")


@pytest.mark.parametrize("base,native", [(True, BASE), (False, FIX)])
def test_profile_changes_only_execution_budget_not_patch_selection(base, native):
    command, evidence = p.profile_command(native, base=base, mocha="10.0.0")
    import shlex
    argv = shlex.split(command)
    assert argv[:2] == ["bash", "-c"]
    script = argv[2]
    subprocess.run(["bash", "-n"], input=script, text=True, check=True)
    assert "git apply /home/test.patch" + ("" if base else " /home/fix.patch") + "\n" in script
    assert '--reporter json --require "$profile_file"' in script
    assert "NODE_OPTIONS" not in script
    assert "--grep" not in script and "--retries" not in script
    assert "sha256sum -c" in script
    assert evidence["minimum_timeout_ms"] == 30000


def test_changed_native_script_or_corpus_base_fails_closed():
    with pytest.raises(ValueError, match="fingerprint"):
        p.profile_command(BASE + "echo changed\n", base=True, mocha="10.0.0")
    with pytest.raises(ValueError, match="changed corpus"):
        p.selected_profile("mui__material-ui-33777", {"base": {"sha": "new"}})
    assert p.selected_profile("other__repo-1", {}) is None


def _hold_lock(path, ready):
    with p.serial_profile_lock(lock_path=Path(path)):
        ready.set()
        time.sleep(0.5)


def test_lock_serializes_separate_processes_and_has_bounded_wait(tmp_path):
    ctx = multiprocessing.get_context("fork")
    ready = ctx.Event()
    child = ctx.Process(target=_hold_lock, args=(str(tmp_path / "lock"), ready))
    child.start()
    try:
        assert ready.wait(5)
        with pytest.raises(TimeoutError):
            with p.serial_profile_lock(lock_path=tmp_path / "lock", timeout_s=0.05):
                pytest.fail("entered held lock")
    finally:
        child.join(5)
        if child.is_alive():
            child.terminate()
            child.join()
    with p.serial_profile_lock(lock_path=tmp_path / "lock", timeout_s=0.1):
        pass


def test_lock_error_is_not_best_effort(tmp_path):
    with pytest.raises(OSError):
        with p.serial_profile_lock(lock_path=tmp_path / "missing" / "lock"):
            pytest.fail("entered unavailable lock")


def test_orphan_or_unrelated_running_container_blocks_admission(monkeypatch):
    monkeypatch.setattr(p.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, "container-id\n", ""))
    with pytest.raises(RuntimeError, match="Docker host is busy"):
        p.assert_idle_docker()


@pytest.mark.parametrize("base", [True, False])
@pytest.mark.parametrize("preserved", [True, False])
def test_profile_is_used_on_real_adapter_path_and_preserves_base_statuses(monkeypatch, tmp_path, base, preserved):
    raw = {"org": "mui", "repo": "material-ui", "number": 33777,
           "base": {"sha": p.PROFILE["instances"]["mui__material-ui-33777"]["base"]},
           "f2p_tests": {"target": {}}, "p2p_tests": {"preserve": {}}, "fix_patch": "gold"}
    monkeypatch.setattr(m, "_raw_instance", lambda *_: raw)
    monkeypatch.setattr(m, "assert_idle_docker", lambda: None)
    monkeypatch.setattr(m, "native_profile_command", lambda r, *, base, mocha: ("profile-command", {"id": "mui-timeouts-v1", "minimum_timeout_ms": 30000, "image": "image", "preload_sha256": "preload"}))
    monkeypatch.setattr(m, "ensure_nix_swe", lambda: "ready")
    monkeypatch.setattr("tempfile.mkdtemp", lambda **_: str(tmp_path))
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(cmd, 0, "sha256:" + "a" * 64 + "\n", "")
        if cmd[cmd.index("--mode") + 1] == "evaluation":
            assert cmd[cmd.index("--fix_patch_run_cmd") + 1] == "profile-command"
            patch = json.loads(Path(cmd[cmd.index("--patch_files") + 1]).read_text())
            assert patch["fix_patch"] == ("" if base else "candidate")
            stage = {"passed_tests": (["preserve"] if preserved else []) + ([] if base else ["target"]),
                     "failed_tests": (["target"] if base else []) + ([] if preserved else ["preserve"]), "skipped_tests": []}
            (tmp_path / "work" / "report.json").write_text(json.dumps({"valid": not base and preserved, "fix_patch_result": stage}))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", run)
    out = m.MultiSweBenchAdapter()._run_harness({"id": "mui__material-ui-33777"}, "" if base else "candidate", base=base)
    assert out["oracle_profile"]["image_id"] == "sha256:" + "a" * 64
    assert Path(out["oracle_profile"]["evidence_path"]).exists()
    if base:
        assert out["base_fails"] is True
        assert out["base_preserved"] is preserved
        assert out["base_pass_to_pass"] == {"preserve": preserved}
    else:
        assert out["resolved"] is preserved
    assert "--fix_patch_run_cmd" not in calls[0]


def test_harness_version_is_checked_before_constructing_command(monkeypatch):
    monkeypatch.setattr(p, "version", lambda _: "changed")
    with pytest.raises(ValueError, match="unsupported multi-swe-bench"):
        p.native_profile_command({}, base=False, mocha="10.0.0")


def test_timeout_orphan_prevents_next_adapter_invocation(monkeypatch):
    instance_id = "mui__material-ui-33777"
    raw = {"base": {"sha": p.PROFILE["instances"][instance_id]["base"]}}
    monkeypatch.setattr(m, "_raw_instance", lambda *_: raw)
    busy = False
    starts = 0
    def admission():
        if busy:
            raise RuntimeError("Docker host is busy")
    def invoke(*a, **k):
        nonlocal busy, starts
        starts += 1
        busy = True
        raise subprocess.TimeoutExpired("harness", 1800)
    monkeypatch.setattr(m, "assert_idle_docker", admission)
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness_unlocked", invoke)
    adapter = m.MultiSweBenchAdapter()
    with pytest.raises(subprocess.TimeoutExpired):
        adapter._run_harness({"id": instance_id}, "gold")
    with pytest.raises(RuntimeError, match="busy"):
        adapter._run_harness({"id": instance_id}, "gold")
    assert starts == 1


def test_repeated_gold_statuses_under_different_images_are_not_deterministic(monkeypatch):
    profile = {"id": "mui-timeouts-v1", "minimum_timeout_ms": 30000, "image_id": "sha256:a", "preload_sha256": "preload", "evidence_path": "/evidence"}
    monkeypatch.setattr(m, "_raw_instance", lambda *_: {"fix_patch": "gold"})
    results = iter([
        {"resolved": True, "fail_to_pass": {"target": True}, "pass_to_pass": {"preserve": True}, "oracle_profile": profile},
        {"resolved": True, "fail_to_pass": {"target": True}, "pass_to_pass": {"preserve": True}, "oracle_profile": {**profile, "image_id": "sha256:b"}},
    ])
    monkeypatch.setattr(m.MultiSweBenchAdapter, "score", lambda *_: next(results))
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", lambda *a, **k: {"base_fails": True, "base_preserved": True, "oracle_profile": profile})
    out = m.MultiSweBenchAdapter().run_controls({"id": "mui__material-ui-33777"})
    assert out["deterministic"] is False
    assert out["gold_resolved"] is True


def test_missing_base_measurement_is_not_labeled_gold_instability(monkeypatch):
    profile = {"id": "mui-timeouts-v1", "minimum_timeout_ms": 30000, "image_id": "sha256:a", "preload_sha256": "preload"}
    monkeypatch.setattr(m, "_raw_instance", lambda *_: {"fix_patch": "gold"})
    monkeypatch.setattr(m.MultiSweBenchAdapter, "score", lambda *_: {"resolved": True, "fail_to_pass": {"target": True}, "pass_to_pass": {"preserve": True}, "oracle_profile": profile})
    def error(*a, **k):
        raise RuntimeError("base transport failed")
    monkeypatch.setattr(m.MultiSweBenchAdapter, "_run_harness", error)
    out = m.MultiSweBenchAdapter().run_controls({"id": "mui__material-ui-33777"})
    assert out["base_fails"] is None
    assert out["deterministic"] is True
    assert "base transport failed" in out["base_error"]
