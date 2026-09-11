#!/usr/bin/env bash
# Provision a Linux host that can run the whole bench — styre runs AND the oracle (ENG-410).
#
# WHY THIS EXISTS
#   The Multi-SWE-bench harness cannot run on macOS at all. Its wheel ships both
#   `repos/python/Qiskit/` and `repos/python/qiskit/`; on a case-insensitive filesystem those
#   collapse into one directory, `Qiskit/qiskit/` never exists, and importing
#   `multi_swe_bench.harness` fails outright. Every TypeScript cell of the 2026-09-11 matrix
#   died on it. Linux is case-sensitive, so the problem simply does not arise.
#
#   Two further wins, both measured rather than assumed:
#     - No emulation. SWE-bench builds `sweb.env.py.x86_64.*` images; on an arm64 Mac those run
#       emulated, which is most of the 12 minutes one instance's controls took.
#     - The image cache persists. Two instances' chains measured 26.5GB here (~4GB per layer,
#       three layers deep). CI rebuilds that every run; a host keeps it.
#
# USAGE
#   ./infra/provision-bench-host.sh create   # create the droplet and set it up
#   ./infra/provision-bench-host.sh setup    # (re)run setup on an existing droplet
#   ./infra/provision-bench-host.sh push-env # copy .env to the host (never through a transcript)
#   ./infra/provision-bench-host.sh ssh      # open a shell on it
#   ./infra/provision-bench-host.sh destroy  # delete it — the image cache goes too
#
# REQUIRES: doctl, authenticated (`doctl auth init`). Nothing here reads a token from the repo.
set -euo pipefail

NAME="${BENCH_HOST_NAME:-styre-bench}"
# 4 vCPU / 8 GiB / 160 GB SSD — $0.07143/hr, $48/mo (digitalocean.com/pricing/droplets,
# verified 2026-09-11). DISK is the binding constraint, not CPU: ~13GB of images per instance
# chain, so a 6-cell matrix wants ~80GB plus OS, repos and worktrees.
SIZE="${BENCH_HOST_SIZE:-s-4vcpu-8gb}"
REGION="${BENCH_HOST_REGION:-nyc3}"
IMAGE="${BENCH_HOST_IMAGE:-ubuntu-24-04-x64}"   # x86_64 on purpose: both corpora ship amd64 images

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

host_ip() {
  doctl compute droplet get "$NAME" --format PublicIPv4 --no-header 2>/dev/null | tr -d '[:space:]'
}

cmd_create() {
  need doctl
  if host_ip | grep -qE '[0-9]'; then
    echo "droplet '$NAME' already exists at $(host_ip) — skipping create"
  else
    local keys
    keys="$(doctl compute ssh-key list --format ID --no-header | paste -sd, -)"
    [ -n "$keys" ] || die "no SSH keys in this DigitalOcean account; add one before provisioning (a droplet with no key is unreachable)"
    echo "creating $NAME ($SIZE, $IMAGE, $REGION) ..."
    doctl compute droplet create "$NAME" \
      --size "$SIZE" --region "$REGION" --image "$IMAGE" \
      --ssh-keys "$keys" --wait --format ID,Name,PublicIPv4
  fi
  echo "waiting for ssh ..."
  for _ in $(seq 1 60); do
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@$(host_ip)" true 2>/dev/null && break
    sleep 5
  done
  cmd_setup
}

cmd_setup() {
  need doctl
  local ip; ip="$(host_ip)"
  [ -n "$ip" ] || die "droplet '$NAME' not found — run: $0 create"
  echo "setting up $NAME ($ip) ..."
  ssh -o StrictHostKeyChecking=accept-new "root@$ip" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Ubuntu 24.04 ships Python 3.12 and has NO python3.11 package — pinning the minor version
# fails outright. Use the distro's python3 and assert the floor instead.
apt-get install -y -qq ca-certificates curl git unzip python3 python3-venv python3-pip jq
python3 - <<'PYV'
import sys
assert sys.version_info >= (3, 11), f"python {sys.version_info.major}.{sys.version_info.minor} is below the 3.11 floor"
print(f"  python {sys.version_info.major}.{sys.version_info.minor} OK")
PYV

# Docker — the bench runs every instance in a container, and both oracle harnesses drive Docker.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
fi

# Bun — the bench and styre are Bun projects.
command -v bun >/dev/null || { curl -fsSL https://bun.sh/install | bash; }
grep -q 'bun/bin' /root/.bashrc || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> /root/.bashrc
export PATH="$HOME/.bun/bin:$PATH"

# GitHub CLI — seeding throwaway repos.
command -v gh >/dev/null || {
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh
}

[ -d /root/styre-bench ] || git clone -q https://github.com/Twinning-Labs/styre-bench.git /root/styre-bench
cd /root/styre-bench
git pull -q --ff-only || true
bun install --silent
python3 -m venv .venv 2>/dev/null || true
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r scorer/requirements.txt
# `datasets` is needed only by scripts/fetch_datasets.py, which is not covered by
# scorer/requirements.txt — declaring it here keeps the corpus fetch from being a manual step.
./.venv/bin/pip install -q datasets

# The corpus cache lives under data/ and is GITIGNORED by the firewall (it holds the held-out
# fix_patch/test_patch), so a fresh clone has none of it and `loadInstances` fails with
# "could not read pinned dataset cache". Fetch it here rather than leaving a trap for the
# first run.
if [ ! -f data/swe-bench.json ] || [ ! -f data/multi-swe-bench.json ]; then
  echo "fetching corpus cache (data/ is gitignored, so a fresh clone has none) ..."
  ./.venv/bin/python scripts/fetch_datasets.py
fi

echo
echo "--- host ready ---"
echo "docker : $(docker --version)"
echo "bun    : $(bun --version)"
echo "python : $(./.venv/bin/python --version)"
echo "disk   : $(df -h / | awk 'NR==2{print $4" free of "$2}')"
echo "arch   : $(uname -m)   (both corpora ship amd64 images; no emulation here)"
echo
# This is the ONE thing the host exists to make true, so a failure here fails setup. Printing a
# warning and exiting 0 would hand back a "ready" host that cannot score a TypeScript cell.
echo "oracle preflight (the macOS blocker) — both harnesses:"
echo '{"languages": ["python", "ts"]}' | ./.venv/bin/python scorer/score.py preflight > /tmp/preflight.json || true
./.venv/bin/python - <<'PREFLIGHT'
import json, sys
report = json.load(open("/tmp/preflight.json"))
if "error" in report:  # score.py's own transport failure, not a harness verdict
    sys.exit(f"  preflight could not run at all: {report['error']}")
for lang, r in sorted(report.items()):
    print(f"  {lang}: {'OK' if r['ok'] else 'FAILED'} — {r['detail']}")
sys.exit(0 if all(r["ok"] for r in report.values()) else 1)
PREFLIGHT
REMOTE
}

cmd_push_env() {
  need doctl
  local ip; ip="$(host_ip)"
  [ -n "$ip" ] || die "droplet '$NAME' not found"
  [ -f .env ] || die ".env not found in $(pwd)"
  # Credentials go host-to-host over ssh. They are never printed, and never pass through a
  # transcript or a chat message.
  scp -q .env "root@$ip:/root/styre-bench/.env"
  ssh "root@$ip" 'chmod 600 /root/styre-bench/.env'
  echo "copied .env to $NAME (mode 600)"
  # config/bench.config.ts is gitignored too (it pins styreCommit, the budget and the seed), so
  # the host's clone has only the .example. Pushing it by hand once is exactly the sort of step
  # that gets forgotten and then looks like a code bug on the next run.
  if [ -f config/bench.config.ts ]; then
    scp -q config/bench.config.ts "root@$ip:/root/styre-bench/config/bench.config.ts"
    echo "copied config/bench.config.ts to $NAME (gitignored; the clone ships only the .example)"
  else
    echo "warning: config/bench.config.ts not found locally — the host keeps whatever it has" >&2
  fi
}

cmd_ssh()     { exec ssh "root@$(host_ip)"; }
cmd_destroy() {
  need doctl
  echo "This deletes droplet '$NAME' AND its image cache (~13GB per instance chain)."
  doctl compute droplet delete "$NAME"
}

case "${1:-}" in
  create)   cmd_create ;;
  setup)    cmd_setup ;;
  push-env) cmd_push_env ;;
  ssh)      cmd_ssh ;;
  destroy)  cmd_destroy ;;
  *) sed -n '2,30p' "$0"; exit 64 ;;
esac
