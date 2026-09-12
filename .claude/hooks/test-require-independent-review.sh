#!/usr/bin/env bash
# Tests for require-independent-review.sh. Run after ANY change to it:
#
#     bash .claude/hooks/test-require-independent-review.sh
#
# Rounds 1-5 of independent review each found the hook broken in a way the previous round's
# ad-hoc testing had not covered, and each round rebuilt its harness from scratch. This file
# exists so round 6 extends a matrix instead of reinventing one. EVERY case is a defect that
# actually shipped -- none is hypothetical.
#
# The load-bearing assertion is not "does it deny" but "WHICH repository does it check". Repo A
# has a valid record, repo B has none, and repo C has a valid record for its own HEAD but an
# origin pointing at someone else's repository. A case that ALLOWS while the pull request would
# open anywhere other than the repo whose record was validated is the failure this exists for.
set -uo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/require-independent-review.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

mkrepo() { # <name> <origin-url>
  local d=$TMP/$1; mkdir -p "$d"; git -C "$d" init -q 2>/dev/null
  git -C "$d" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$d" remote add origin "$2"
  printf '%s' "$d"
}
record() { # <repo-dir>
  local sha url; sha=$(git -C "$1" rev-parse HEAD); url=$(git -C "$1" remote get-url origin)
  mkdir -p "$1/.claude/reviews"
  { printf 'reviewed-sha: %s\nreviewed-remote: %s\n\n' "$sha" "$url"
    head -c 600 /dev/zero | tr '\0' 'x'; } > "$1/.claude/reviews/$sha.md"
}
A=$(mkrepo A https://github.com/acme/a.git); record "$A"
B=$(mkrepo B https://github.com/acme/b.git)
C=$(mkrepo C https://github.com/someone-else/unrelated.git)
# C's record names C's own sha but the record is written for its real origin, so C is the
# "directory name lies about the remote" case: it must still deny unless the record names it.
mkdir -p "$C/.claude/reviews"
CSHA=$(git -C "$C" rev-parse HEAD)
{ printf 'reviewed-sha: %s\nreviewed-remote: https://github.com/acme/c.git\n\n' "$CSHA"
  head -c 600 /dev/zero | tr '\0' 'x'; } > "$C/.claude/reviews/$CSHA.md"

check() { # <name> <allow|deny> <cwd> <command>
  local name=$1 want=$2 out dec
  out=$(python3 - "$3" "$4" <<'PY' | bash "$HOOK" 2>&1
import json,sys
print(json.dumps({"cwd":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))
PY
)
  if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then dec=allow; else
    dec=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecision"])' 2>/dev/null) || dec=INVALID_JSON
  fi
  if [ "$dec" = "$want" ]; then pass=$((pass+1)); printf 'ok   %s\n' "$name"
  else fail=$((fail+1)); printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$dec"; fi
}

echo "--- the accepted shape must work, or the gate is unusable for its own flow ---"
check "plain create in reviewed repo"    allow "$A" "gh pr create --fill"
check "conventional-commits title"       allow "$A" 'gh pr create --title "fix(scope): thing (again)" --body x'
check "cd into reviewed repo"            allow "$B" "cd $A && gh pr create --fill"
check "cd + conventional title"          allow "$B" "cd $A && gh pr create --title \"fix(x): y\""

echo "--- unreviewed repo, and a record that names the wrong remote ---"
check "plain create, unreviewed"         deny  "$B" "gh pr create --fill"
check "cd into unreviewed repo"          deny  "$A" "cd $B && gh pr create --fill"
check "record names a different remote"  deny  "$C" "gh pr create --fill"

echo "--- round 5: gh's OWN grammar retargets without suspicious shell characters ---"
check "merge is refused outright"        deny  "$A" "gh pr merge --squash"
check "merge by number"                  deny  "$A" "gh pr merge 1 --squash"
check "merge by URL to another repo"     deny  "$A" "gh pr merge https://github.com/cli/cli/pull/1 --squash"
check "merge --auto"                     deny  "$A" "gh pr merge --auto --squash"
check "--head other branch"              deny  "$A" "gh pr create --head totally-other-branch"
check "-H fork:branch"                   deny  "$A" "gh pr create -H otheruser:their-branch"
check "--head=other"                     deny  "$A" "gh pr create --head=otheruser:their-branch"

echo "--- round 6: ATTACHED short flags. -R covered these from round 4; -H did not. ---"
check "attached -Hother:branch"          deny  "$A" "gh pr create -Hotheruser:their-branch --fill"
check "attached -H local branch"         deny  "$A" "gh pr create -Hsome-other-local-branch"
check "combined cluster -dH"             deny  "$A" "gh pr create --fill -dHotheruser:their-branch"

echo "--- round 7: the built-in alias, quoted flag tokens, and flags inside short clusters ---"
# 'gh pr new' is a documented alias for create. Neither classifier knew the word, so it opened
# pull requests with the gate entirely blind -- no record required, every tool present.
check "alias: pr new, unreviewed"        deny  "$B" "gh pr new --fill"
check "alias: pr new with title"         deny  "$B" "gh pr new --title t --body b"
check "alias: pr new after cd"           deny  "$A" "cd $B && gh pr new --fill"
check "alias: pr new is allowed if reviewed" allow "$A" "gh pr new --fill"
# Both flag refusals anchored on a preceding space or start-of-string; a quote is neither.
check "quoted --repo token"              deny  "$A" 'gh pr create "--repo" evil/repo --fill'
check "quoted --repo=value"              deny  "$A" 'gh pr create "--repo=evil/repo" --fill'
check "quoted -Rvalue"                   deny  "$A" 'gh pr create "-Revil/repo" --fill'
check "quoted --head token"              deny  "$A" 'gh pr create "--head" evil:branch --fill'
check "quoted -Hvalue"                   deny  "$A" 'gh pr create "-Hevil:branch" --fill'
# Cluster-terminal: the letter is last and its value is the NEXT word, so a pattern requiring a
# non-space after the letter missed it. Real gh resolves `-dR owner/repo` against that repo.
check "cluster-terminal -dH value"       deny  "$A" "gh pr create -dH other:branch"
check "cluster-terminal -dfH value"      deny  "$A" "gh pr create -dfH other:branch"
check "R inside a cluster, attached"     deny  "$A" "gh pr create -dRowner/repo"
check "R inside a cluster, spaced"       deny  "$A" "gh pr create -dR owner/repo"
# ...without denying the short flags the create subcommand really has (none holds R or H).
check "legit short flags cluster"        allow "$A" "gh pr create -df --title t"
check "legit -l label"                   allow "$A" "gh pr create -l Hotfix --fill"
check "legit -a assignee"                allow "$A" "gh pr create -a HansM --fill"
check "legit -T template path"           allow "$A" "gh pr create -T templates/HOTFIX.md --fill"
check "legit -B base branch"             allow "$A" "gh pr create -B main --fill"
check "legit --body-file"                allow "$A" "gh pr create --title t --body-file /tmp/b.md"

echo "--- rounds 1+2: shapes that bypassed the command-position matcher ---"
check "sudo prefix"                      deny  "$B" "sudo gh pr create --fill"
check "absolute path to gh"              deny  "$B" "/opt/homebrew/bin/gh pr create --fill"
check "env var prefix"                   deny  "$B" "GH_TOKEN=x gh pr create --fill"
check "bash -c"                          deny  "$B" "bash -c 'gh pr create --fill'"
check "command prefix"                   deny  "$B" "command gh pr create --fill"
check "if/then"                          deny  "$B" "if true; then gh pr create --fill; fi"

echo "--- round 3: wrong-repo via cd spellings ---"
check "trailing cd back (&&)"            deny  "$B" "cd $B && gh pr create && cd $A"
check "cd inside subshell"               deny  "$B" "( cd $B && gh pr create )"
check "cd inside bash -c"                deny  "$B" "bash -c 'cd $B && gh pr create'"
check "relative cd"                      deny  "$A" "cd ../B && gh pr create --fill"
check "cd with variable"                 deny  "$A" "cd \$HOME/B && gh pr create --fill"
check "non-leading cd"                   deny  "$A" "git status && cd $B && gh pr create"
check "double cd"                        deny  "$A" "cd $A && cd $B && gh pr create"
check "cd nonexistent"                   deny  "$A" "cd $TMP/nope && gh pr create --fill"

echo "--- round 4: eight constructions that validated the wrong repo ---"
check "newline trailing cd"              deny  "$B" "$(printf 'gh pr create --fill\ncd %s' "$A")"
check "backslash cd"                     deny  "$A" "\\cd $B && gh pr create --fill"
check "backslash cd + gh api"            deny  "$A" "\\cd $B && gh api -X POST repos/o/r/pulls"
check "attached -Rowner/repo"            deny  "$A" "gh pr create --fill -Rother/nope"
check "spaced --repo"                    deny  "$A" "gh pr create --repo other/nope --fill"
check "--repo=owner/name"                deny  "$A" "gh pr create --repo=other/nope --fill"
check "GH_REPO env"                      deny  "$A" "GH_REPO=other/nope gh pr create --fill"
check "env -C"                           deny  "$A" "env -C $B gh pr create --fill"
check "GIT_DIR/GIT_WORK_TREE"            deny  "$A" "GIT_DIR=$B/.git GIT_WORK_TREE=$B gh pr create --fill"
check "variable command name"            deny  "$A" "GHX=gh; \$GHX pr create --fill"

echo "--- gh api opens PRs with no 'pr create' in sight ---"
check "gh api POST pulls"                deny  "$A" "gh api -X POST /repos/o/r/pulls -f title=x"
check "gh api graphql createPullRequest" deny  "$A" "gh api graphql -f query='mutation{createPullRequest(input:{})}'"
# The primary classifier used to require a `gh api` prefix before it would look at the endpoint,
# while the crude fallback matched a bare `pulls` -- so the DEGRADED path was stricter than the
# normal one, and any other HTTP client reached the same endpoint untouched.
check "curl POST to pulls"               deny  "$A" "curl -X POST https://api.github.com/repos/o/r/pulls -d @b.json"
check "curl with auth header"            deny  "$A" "curl -H auth https://api.github.com/repos/o/r/pulls"
check "wget to pulls"                    deny  "$A" "wget --post-file=b.json https://api.github.com/repos/o/r/pulls"
check "reading issues is still fine"     allow "$A" "curl https://api.github.com/repos/o/r/issues"

echo "--- ordinary work must NOT be blocked (a gate that taxes daily work gets deleted) ---"
check "gh pr list"                       allow "$A" "gh pr list --state merged"
check "gh pr view"                       allow "$A" "gh pr view 37 --json state"
check "gh pr checks"                     allow "$A" "gh pr checks 37"
check "gh api GET issues"                allow "$A" "gh api /repos/o/r/issues --paginate"
check "gh run view"                      allow "$A" "gh run view 1 --log"
check "git commit"                       allow "$A" "git add -A && git commit -m wip"
check "bun test"                         allow "$A" "bun test 2>&1 | tail -5"
check "docker volume+port colons"        allow "$A" "docker run -v /a:/b -p 8080:80 alpine:3 true"
check "awk -F,"                          allow "$A" "awk -F, '{print \$1}' data.csv"
check "git clone scp syntax"             allow "$A" "git clone git@github.com:o/r.git"
check "cd then non-PR work"              allow "$A" "cd $B && bun test"
check "ls"                               allow "$A" "ls -la"

echo "--- fail-closed routes (each was a silent allow at some point) ---"
fc() { # <name> <stdin-producer-command...>
  local name=$1; shift
  if [ -n "$("$@" 2>/dev/null | bash "$HOOK" 2>&1 | tr -d '[:space:]')" ]; then
    pass=$((pass+1)); echo "ok   $name"
  else fail=$((fail+1)); echo "FAIL $name (allowed)"; fi
}
fc "empty payload denies"        printf ''
fc "whitespace payload denies"   printf '   \n  '
fc "invalid JSON denies"         printf 'not json at all'
fc "NUL-truncated payload denies" printf '{"pad":"x\000","tool_input":{"command":"gh pr create"}}'
# A valid payload whose command field is absent or RENAMED must not read as "nothing to see" --
# if the harness ever renames the field, the gate would otherwise stop working with no signal.
fc "renamed command field denies" printf '{"cwd":"/tmp","tool_input":{"cmd":"gh pr create --fill"}}'
fc "absent command field denies"  printf '{"cwd":"/tmp","tool_input":{}, "raw":"gh pr create"}'
timeout 8 bash "$HOOK" 0<&- >"$TMP/o" 2>&1; rc=$?
[ $rc -ne 124 ] && { pass=$((pass+1)); echo "ok   closed stdin terminates (rc=$rc)"; } || { fail=$((fail+1)); echo "FAIL closed stdin hangs"; }
# awk removed: the one tool whose absence used to produce an empty classification -> allow.
mkdir -p "$TMP/minbin"; for t in sed tr grep wc git jq bash; do p=$(command -v $t) && ln -sf "$p" "$TMP/minbin/$t"; done
# The crude fallback used to test a LITERAL single space, so these real spellings walked past it.
noawk() { # <label> <command>
  local o; o=$(python3 -c 'import json,sys;print(json.dumps({"cwd":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))' "$B" "$2" \
       | env PATH="$TMP/minbin" bash "$HOOK" 2>&1)
  [ -n "$(printf '%s' "$o" | tr -d '[:space:]')" ] && { pass=$((pass+1)); echo "ok   $1"; } \
    || { fail=$((fail+1)); echo "FAIL $1 (allowed)"; }
}
noawk "missing awk, single space"  "gh pr create --fill"
noawk "missing awk, double space"  "gh  pr  create --fill"
noawk "missing awk, tabs"          "$(printf 'gh\tpr\tcreate --fill')"
noawk "missing awk, merge"         "gh pr  merge --squash"
# Three fail-closed routes the code closed but the matrix never asserted.
mkdir -p "$TMP/nojq"; for t in awk sed tr grep wc git bash; do p=$(command -v $t) && ln -sf "$p" "$TMP/nojq/$t"; done
o=$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --fill"}}' "$B" | env PATH="$TMP/nojq" bash "$HOOK" 2>&1)
[ -n "$(printf '%s' "$o" | tr -d '[:space:]')" ] && { pass=$((pass+1)); echo "ok   missing jq denies"; } || { fail=$((fail+1)); echo "FAIL missing jq allowed"; }
o=$(printf '{"cwd":"%s","tool_input":{"command":"cd ~/nowhere && gh pr create"}}' "$B" | env -u HOME bash "$HOOK" 2>&1)
[ -n "$(printf '%s' "$o" | tr -d '[:space:]')" ] && { pass=$((pass+1)); echo "ok   unset HOME denies"; } || { fail=$((fail+1)); echo "FAIL unset HOME allowed"; }
o=$(printf '{"cwd":"/tmp","tool_input":{"command":"gh pr create --fill"}}' | bash "$HOOK" 2>&1)
[ -n "$(printf '%s' "$o" | tr -d '[:space:]')" ] && { pass=$((pass+1)); echo "ok   non-repo cwd denies"; } || { fail=$((fail+1)); echo "FAIL non-repo cwd allowed"; }
# The record match must be whole-line and literal: an unanchored grep let an origin of
# .../acme/a satisfy a record naming .../acme/a.git, and treated "." as a regex wildcard.
P=$(mkrepo P https://github.com/acme/a); PSHA=$(git -C "$P" rev-parse HEAD)
mkdir -p "$P/.claude/reviews"
{ printf 'reviewed-sha: %s\nreviewed-remote: https://github.com/acme/a.git\n\n' "$PSHA"
  head -c 600 /dev/zero | tr '\0' 'x'; } > "$P/.claude/reviews/$PSHA.md"
check "remote prefix must not match"     deny  "$P" "gh pr create --fill"

echo "--- every DENY must be strictly-parseable JSON (an unparseable deny is dropped) ---"
for bad in "cd $TMP/no$(printf '\t')tab && gh pr create" \
           "cd $TMP/no$(printf '\r')cr && gh pr create" \
           "cd $TMP/no$(printf '\014')ff && gh pr create" \
           "gh pr create --title \"a\\\"b\" --body \$(x)" \
           "gh pr create --title \"emoji ✅ and üñïçø∂é\""; do
  o=$(python3 - "$B" "$bad" <<'PY' | bash "$HOOK" 2>&1
import json,sys
print(json.dumps({"cwd":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))
PY
)
  # Must be a DENY and must parse. "allow" is NOT acceptable here -- an earlier version of this
  # assertion passed on "valid JSON or allow", which would have reported a regression as ok.
  if printf '%s' "$o" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["hookSpecificOutput"]["permissionDecision"]=="deny"' 2>/dev/null; then
    pass=$((pass+1)); echo "ok   deny is valid JSON"
  else fail=$((fail+1)); echo "FAIL not a parseable deny: $(printf '%s' "$bad" | cat -v | cut -c1-46)"; fi
done

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
