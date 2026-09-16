# ENG-461: reconcile repository creation before retrying the instance

The September 13 Sphinx attempt reported `name already exists` on three outer seed
attempts. Three empty repositories appeared during that window. The retained logs
do not contain the first HTTP response, so they cannot prove the historical cause.
The current org count does not establish a repository quota problem.

The installed Octokit includes a retry plugin. A network-free control reproduces
one application call sending the same creation POST twice: a simulated 500 followed
by 422 surfaces only the latter. Fresh names per outer attempt do not prevent this.
The [Octokit retry documentation](https://github.com/octokit/plugin-retry.js) describes
automatic retries and per-request retry counts. GitHub's
[repository API](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository)
supports a description in the creation request and repository lookup by owner/name.

## Behavior

- Creation sends one POST, with automatic retries disabled for that request.
- An opaque per-attempt UUID marker is written in the description in the same POST.
  On any creation error, a bounded GET reconciliation may recover only the matching
  private owner/name/marker. A same-name repository alone is never adopted or deleted.
- Actions must be disabled before upstream files are pushed. Failure rolls back the
  owned repo. Push failure and a subsequent Linear failure also attempt rollback.
- Rollback rereads immutable repository ID, owner/name, privacy and marker before
  deletion. If proof differs, it leaves the resource alone and records the failure.
- `<evidenceRoot>/seed-events.ndjson` records intent, first HTTP status/request ID,
  reconciliation, partial progress and rollback. It starts before the container and
  remains available when no per-run directory exists. Each record carries a unique
  seed attempt and host-only instance ID. SDK errors/headers and credential-bearing
  URLs are never serialized. The existing per-run `seed.json` remains unchanged.
- Seed journal writes are best effort and emit a warning if unavailable. The journal
  is an append-only file and is not deleted by run-directory pruning; operators may
  archive it separately.

## Validation and limits

The tests use real Octokit with a fake HTTP transport and mocked external seed steps.
They test the baseline SDK retry behavior, successful reconciliation, ownership
mismatches, 404 lookup, Actions failure, replacement-repo refusal, partial Linear
failure, rollback failure, successful seeding and original-error preservation. The
existing tests still exercise real local Git history and the leak firewall.

This does not establish that the historical Sphinx failure was a lost response;
request diagnostics on a subsequent targeted run will distinguish that hypothesis.
It does not delete old scratch repos or repair the Sphinx setup path after seeding.
No live API mutation or paid benchmark run is required by this change's tests.

If GitHub's response and the reconciliation lookup both fail (or the creation becomes
visible only later), the repo may remain: the journal records enough for investigation,
but cannot prove ownership to a failed lookup. Rollback itself may fail, and process
termination can interrupt cleanup. The API's name-addressed delete is not an atomic
compare-and-delete with the preceding ID check. Retain-on-failure applies only to
complete seeds that reached the normal run stage, not incomplete seeds.

A lost Linear create response can still leave an unknown ticket. This patch rolls
back the known GitHub resource; it does not guess which Linear ticket to archive.
The standalone `webOffProbe` helper has its own seeding lifecycle and is not changed.
