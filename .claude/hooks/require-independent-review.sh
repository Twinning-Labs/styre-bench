#!/usr/bin/env bash
# PreToolUse gate: refuse to open a pull request unless an independent review has been recorded
# for the repository and commit that are about to ship.
#
# WHY (ENG-438, styre-bench#36). The review discipline lived in a memory note -- advisory, and it
# loses to momentum at exactly the moment it matters, when the work feels done. It was skipped
# repeatedly. Worse, when a review DID run it covered an earlier state: #36 was reviewed at two
# commits and shipped at four, and the lines added in between held two defects, one of which
# silenced the only test able to detect the MSB harness breaking. Keying the record to a SHA is
# what fixes that: it turns "did I review this?" from a memory question into a filesystem fact
# that invalidates itself on every commit.
#
# ---------------------------------------------------------------------------------------------
# WHAT THIS ACTUALLY GUARANTEES -- stated narrowly, because eight rounds of review caught the
# earlier, broader claims being false:
#
#   A review record exists for the HEAD commit of the repository the command runs in, AND for
#   that repository's `origin` remote.
#
# It does NOT guarantee the shipped code was reviewed. `gh pr create` opens a pull request for a
# BRANCH, and a branch tip can differ from local HEAD. `--head` used to let a wholly different
# branch ship (now refused). A local checkout whose `remote.origin.url` points at some other
# GitHub repository used to redirect a valid record at that repository silently (now refused
# unless the record names the same remote). Treat this as a gate against FORGETTING, not proof
# of provenance.
#
# WHY THE COMMAND MATCH IS AN ALLOWLIST. The payload's `cwd` is the SESSION's directory, not the
# command's. Three versions tried to infer the target repository by inspecting the command and
# excluding the ways it could point elsewhere; four review rounds defeated them seventeen ways --
# quoted and tilde paths, non-leading and trailing directory changes, subshells and -c strings, a
# backslash-escaped `cd` the token scan cannot see, an attached `-Rowner/repo`, and `GH_REPO=`,
# `env -C`, `GIT_DIR`/`GIT_WORK_TREE`, which need no directory change at all. That is the
# enumeration trap the ENG-437 ticket set is about: away from the choke point a guard can only
# enumerate, and an enumeration is defeated by the next thing nobody enumerated.
#
# So one shape is accepted and everything else refused:
#
#     [cd <literal absolute or ~ path> && ] gh pr create|new [flags]   ("new" is a gh alias)
#
# single line, no environment assignments, no variable expansion, no backslashes, no extra
# commands, no redirection, no -R/--repo in any spelling, and no --head/-H in any spelling
# (including the attached `-Hother:branch` and `-dHother:branch`, which pflag accepts). Round 5
# showed why the flags matter: gh's OWN argument grammar can retarget the request without a
# single suspicious shell character. There is no positional-argument check, deliberately --
# the create subcommand is entirely flag-driven and rejects a bare word itself.
#
# `gh pr merge` is refused outright. CLAUDE.md's development rules say the operator merges every
# pull request personally, so this session has no business running it at all -- and refusing it
# removes the entire `gh pr merge <url|number|branch>` retargeting class rather than policing it.
#
# FAIL CLOSED. Eleven routes found and closed so far: `git rev-parse ... || exit 0`; a missing
# jq; an unparseable payload; a fallback tokenizer blind to `command:` prefixes; an empty
# payload; `set -u` on an unset HOME; a closed stdin that hung until the harness timed the hook
# out (a timed-out hook is skipped, so it neither denies nor verifies); a raw NUL truncating the
# payload into something that no longer looked like the verb; a missing `awk`, which alone of the
# required tools produced an empty classification and therefore an allow; the crude fallback
# matching a literal single space, so with awk gone a double-spaced spelling passed; and a valid
# payload whose command field was empty or renamed, which read as "nothing to see".
#
# THE REMOTE CHECK IS NARROW. It compares the record against `git remote get-url origin`. gh
# does not always use origin: it prefers an `upstream` remote when one exists, and
# `gh repo set-default` writes `remote.<name>.gh-resolved`, which can name any repository at
# all. Neither is PR-shaped, so neither is gated. The guarantee stays literally true -- a record
# exists for this checkout's HEAD and its origin -- but do not read it as "the pull request will
# land in the repository the record names".
#
# WHAT IT DOES NOT DO. It cannot tell a real review from a fabricated one -- the author writes
# the record. Anyone determined can put the command in a script and run that. It reaches `gh`
# and the pulls endpoint, and nothing else: `gh alias set` with an obfuscated definition, then
# invoking that alias, is two allowed commands that together open a pull request. So is any
# HTTP client pointed at an endpoint it does not name. The matcher is Bash
# only, so the Write tool is unhooked. Detection is deliberately over-broad, and the rule is not
# "roughly one in five" but deterministic: EVERY command whose text contains the verb pair is
# refused, and so is any naming the pulls endpoint or createPullRequest -- `cat src/pulls.ts` is
# refused too. Measured against real historical commands, that cost is zero; it is stated here
# because the rule is broader than the verb pair alone. Put differently, EVERY such command is
# refused. You cannot grep this repo for the phrase, read gh's help for it, or write a commit
# message naming it, without tripping the gate. Measured cost on ordinary work: zero of forty
# commands. The workaround is to put such a command in a file and run the file -- which is also,
# honestly, a way around the gate itself, so it relies on the author not using it to evade.
#
# TESTS: .claude/hooks/test-require-independent-review.sh -- run after ANY change here.
# ESCAPE HATCH: delete the `Bash` entry from .claude/settings.json's PreToolUse array.
set -uo pipefail

# Closed stdin made `cat` block until the harness's timeout killed the hook -- a skipped hook
# neither denies nor verifies. Bounded read instead.
payload=""
IFS= read -r -d '' -t 5 payload 2>/dev/null || true

emit() {
  # Hand-rolled so it still works when jq is the missing thing. Strips every C0 control
  # character INCLUDING \015 -- a raw CR inside a JSON string is invalid, and an unparseable
  # DENY is itself a fail-open, because the harness drops it.
  local esc
  esc=$(printf '%s' "$1" \
        | tr -d '\001-\010\013\014\015\016-\037\177' 2>/dev/null \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' 2>/dev/null \
        | awk 'BEGIN{ORS=""}{print (NR>1 ? "\\n" : "") $0}' 2>/dev/null)
  [ -z "$esc" ] && esc="The review gate refused this command but could not render its reason."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
  exit 0
}

ONLY_SHAPE='The gate can only verify a review when it is certain which repository and commit are
shipping, and it cannot determine that from an arbitrary command -- eight rounds of review found
more than twenty ways to point one somewhere else. It accepts exactly this:

    gh pr create [flags]                    (or the built-in alias, gh pr new)
    cd /absolute/path/to/repo && gh pr create [flags]      (a ~/ path is accepted too)

single line, no environment assignments, no variable expansion, no backslashes, no extra
commands, no redirection, no -R/--repo, and no --head/-H in any spelling. Re-run it so.'

# Pure-bash crude check, used when the tools the real classifier needs are missing, or when the
# payload cannot be read properly. No externals -- it must work when `tr` itself is the missing
# thing. The patterns are wildcarded BETWEEN the words rather than requiring a single space:
# a first version tested the literal "pr create", so with `awk` gone, `gh  pr  create` (two
# spaces) and the tab-separated spelling both sailed through. Both are real working commands.
crude_looks_like_pr() {
  case "$1" in
    *pr*create*|*pr*merge*|*pr*new*|*pulls*|*createPullRequest*) return 0 ;;
    *) return 1 ;;
  esac
}

for t in awk sed tr grep wc git; do
  command -v "$t" >/dev/null 2>&1 && continue
  crude_looks_like_pr "$payload" && emit "This may open a pull request, but '$t' is not available
to the review gate, which therefore cannot classify the command or verify a review record.
Refusing rather than failing open."
  exit 0   # tool missing and nothing pull-request-shaped in sight: stay out of the way
done

if [ -z "$(printf '%s' "$payload" | tr -d '[:space:]')" ]; then
  emit "The review gate received an empty hook payload, so it cannot tell what is about to run.
Refusing rather than failing open. If the harness has stopped sending payloads, remove the Bash
entry from .claude/settings.json instead of letting the gate silently stop working."
fi

# ------------------------------------------------------------------ extract the command
# Payload integrity is checked BEFORE classification. A raw NUL truncates the bounded read, and
# a first version classified the truncated remainder -- which no longer looked like a pull
# request -- then reported the corruption only on paths the truncation had already skipped.
if command -v jq >/dev/null 2>&1; then
  if ! printf '%s' "$payload" | jq -e . >/dev/null 2>&1; then
    crude_looks_like_pr "$payload" && emit "This may open a pull request, but the hook payload is
not valid JSON -- it may have been truncated in transport -- so the gate cannot verify a review."
    emit "The review gate received a hook payload that is not valid JSON, so it cannot tell what
is about to run. Refusing rather than failing open. If this is systematic, remove the Bash entry
from .claude/settings.json rather than leaving a gate that cannot see."
  fi
  cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null) || cmd=""
  cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null) || cwd=""
  # A valid payload whose command field is empty must not be read as "nothing to see". That
  # happens if jq errors on the field query, or if the harness ever RENAMES the field -- in
  # which case the gate would stop working with no signal at all. Fall back to the raw payload.
  if [ -z "$cmd" ] && crude_looks_like_pr "$payload"; then
    emit "This may open a pull request, but the gate could not read the command out of the hook
payload -- the field may be absent or renamed. Refusing rather than failing open. If the payload
shape has changed, update this hook or remove the Bash entry from .claude/settings.json."
  fi
else
  crude_looks_like_pr "$payload" && emit "This may open a pull request, but jq is not installed,
so the review gate cannot read the payload or verify a review record."
  exit 0
fi

# ------------------------------------------------------------------ might this open a PR?
# Deliberately over-broad. Tokenized with quotes stripped: a `gh` basename followed by `pr` then
# `create`/`merge`; `gh api` against the pulls endpoint (a real way to open one with no
# `pr create` in sight); or the bare `pr create` bigram, which catches a variable or aliased
# command name the basename scan cannot see.
flat=$(printf '%s' "$cmd" | tr -d '"'"'" | tr '\n;&|(){}<>:,' '            ')
maybe_pr=$(printf '%s' "$flat" | awk '{
    for (i = 1; i <= NF; i++) {
      t = $i; sub(/^.*\//, "", t)
      if (t == "gh" || t == "\\gh")                          { gh = 1; pr = 0; api = 0; prev = $i; continue }
      if (gh && $i == "pr")                                  { pr = 1; prev = $i; continue }
      if (gh && $i == "api")                                 { api = 1; prev = $i; continue }
      if (pr && ($i == "create" || $i == "merge" || $i == "new")) { print "yes"; exit }
      if (api && ($i ~ /pulls/ || $i ~ /createPullRequest/)) { print "yes"; exit }
      # No `gh api` prefix required: any token naming the pulls endpoint counts, because a
      # plain HTTP client reaches it just as well. The crude fallback already said so, which
      # made the degraded path stricter than this one.
      if ($i ~ /\/pulls/ || $i ~ /createPullRequest/) { print "yes"; exit }
      if (prev == "pr" && ($i == "create" || $i == "merge" || $i == "new")) { print "yes"; exit }
      prev = $i
    }
  }' 2>/dev/null) || maybe_pr="ERR"
# An awk that fails leaves this empty, which a first version read as "not a pull request".
[ "$maybe_pr" = "ERR" ] && emit "The review gate could not classify this command. Refusing."
[ "$maybe_pr" = "yes" ] || exit 0

# ---- from here every path denies or verifies a record ----

# ------------------------------------------------------------------ ALLOWLIST
trimmed=$(printf '%s' "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
# Newline check via wc, NOT `case ... *"$(printf '\n')"*`: command substitution strips trailing
# newlines, so that pattern is *""* and matches everything -- it denied the accepted shape too.
if [ "$(printf '%s' "$trimmed" | wc -l | tr -d ' ')" != "0" ]; then
  emit "This may open a pull request as part of a multi-line command, where the gate cannot tell
which part runs where.

$ONLY_SHAPE"
fi

workdir=""; rest=$trimmed
case "$trimmed" in
  "cd "*)
    n=$(printf '%s' "$trimmed" | awk '{n=0; while (match($0,/&&/)) { n++; $0=substr($0,RSTART+2) } print n}')
    [ "$n" = "1" ] || emit "This may open a pull request in a command with $n '&&' separators.
Only a single leading directory change is accepted.

$ONLY_SHAPE"
    target=$(printf '%s' "$trimmed" | sed -E 's/^cd[[:space:]]+(.*)&&.*/\1/' | sed -e 's/[[:space:]]*$//')
    rest=$(printf '%s' "$trimmed" | sed -E 's/^cd[[:space:]]+.*&&[[:space:]]*//')
    target=${target%\"}; target=${target#\"}; target=${target%\'}; target=${target#\'}
    case "$target" in
      *'$'*|*'`'*|*'\'*|*';'*|*'|'*|*'&'*|*'<'*|*'>'*|*'('*|*')'*|"")
        emit "This may open a pull request after a directory change the gate cannot resolve
literally ('$target').

$ONLY_SHAPE" ;;
      "~"|"~/"*) target=${HOME:-}/${target#\~}; target=${target%/} ;;
      /*) ;;
      *) emit "This may open a pull request after a relative directory change ('$target'). The
gate runs from a different directory than the command, so a relative path resolves elsewhere.

$ONLY_SHAPE" ;;
    esac
    [ -d "$target" ] || emit "This may open a pull request after changing directory to '$target',
which is not a directory."
    workdir=$target ;;
  "gh "*) ;;
  *) emit "This may open a pull request, but the command does not begin with 'gh' or a single
literal directory change. An environment assignment, 'env', 'sudo', an absolute path to the
executable, a backslash-escaped name or a wrapper script can each retarget it silently.

$ONLY_SHAPE" ;;
esac

case "$rest" in
  *'$'*|*'`'*|*'\'*|*';'*|*'|'*|*'&'*|*'<'*|*'>'*)
    emit "This may open a pull request in a command containing shell metacharacters or variable
expansion, which can retarget it after the gate has looked.

$ONLY_SHAPE" ;;
esac

# Flag and verb checks run on a DEQUOTED copy. Both flag refusals anchored on
# `(^|[[:space:]])-`, and a quote is neither -- so a quoted flag token walked straight past
# them while four separate places claimed the flags were refused "in any spelling".
rest_flat=$(printf '%s' "$rest" | tr -d '"'"'"'')

printf '%s' "$rest_flat" | grep -Eq '^gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)' \
  && emit "This merges a pull request. The development rules say the operator merges every pull
request personally, so this session should not be running it -- and 'gh pr merge' accepts a URL,
number or branch, any of which targets something the gate never reviewed. Refused outright."

printf '%s' "$rest_flat" | grep -Eq '^gh[[:space:]]+pr[[:space:]]+(create|new)([[:space:]]|$)' \
  || emit "This may open a pull request, but not in a form the gate can verify -- for example
'gh api' against the pulls endpoint, which names the repository in the URL rather than using the
local checkout.

$ONLY_SHAPE"

# `-[a-zA-Z]*R` matches the flag anywhere in a short cluster, attached value or not: -R,
# -Rowner/repo, -dR owner/repo, -dRowner/repo. A previous version required a non-space after
# the letter, so a cluster-terminal `-dR owner/repo` passed -- and real gh resolves that. None
# of the short flags the create subcommand accepts contains an uppercase R or H.
printf '%s' "$rest_flat" | grep -Eq '(^|[[:space:]])--repo([[:space:]=]|$)|(^|[[:space:]])-[a-zA-Z]*R' \
  && emit "This opens a pull request with an explicit -R/--repo target, which the gate cannot map
to a local checkout.

$ONLY_SHAPE"

# The ATTACHED short form matters: pflag accepts `-Hother:branch` and `-dHother:branch`, both
# verified against the real gh. A first version checked only the spaced `-H` and `--head` -- and
# handled the attached form for -R eight lines above, so this was an inconsistency, not an
# unknown. The last alternative matches an H anywhere in a short-flag cluster with an attached
# value.
printf '%s' "$rest_flat" | grep -Eq '(^|[[:space:]])--head([[:space:]=]|$)|(^|[[:space:]])-[a-zA-Z]*H' \
  && emit "This opens a pull request with an explicit --head/-H branch. The review record is
keyed to the local HEAD commit, and --head ships a different branch entirely -- gh's own help
documents '--head <user>:<branch>' as selecting a head repo owned by another user -- so the
record would not cover what is being proposed.

$ONLY_SHAPE"

# No positional-argument check. `gh pr create` is entirely flag-driven -- its own help documents
# the retarget vector as `--head <user>:<branch>`, which is refused above -- so a bare word here
# is a user error gh will reject, not a way to reach another repository. A first version scanned
# for one by word-splitting, which cannot see quoting: `--title "fix(scope): thing"` read as a
# stray positional and denied the accepted shape. Caught by the matrix asserting the legitimate
# flows still work, which is the second time that assertion has earned its place.

[ -n "$workdir" ] || workdir=${cwd:-$PWD}

root=$(git -C "$workdir" rev-parse --show-toplevel 2>/dev/null) || root=""
[ -n "$root" ] || emit "This opens a pull request, but $workdir is not inside a git repository."
sha=$(git -C "$root" rev-parse HEAD 2>/dev/null) || sha=""
[ -n "$sha" ] || emit "This opens a pull request in $root, but HEAD could not be resolved."
remote=$(git -C "$root" remote get-url origin 2>/dev/null) || remote=""
[ -n "$remote" ] || emit "This opens a pull request in $root, which has no 'origin' remote, so
the gate cannot tell which GitHub repository would receive it."

short=${sha:0:8}; repo=${root##*/}; rec="$root/.claude/reviews/$sha.md"

# ------------------------------------------------------------------ is a review recorded?
if [ ! -f "$rec" ] || [ ! -r "$rec" ]; then
  emit "INDEPENDENT REVIEW NOT RECORDED for $repo HEAD $short.

Dispatch an independent adversarial reviewer (Agent tool) over the EXACT state that will ship,
then record it at:
  .claude/reviews/$sha.md
with these two lines and the reviewer's actual findings:
  reviewed-sha: $sha
  reviewed-remote: $remote

Keyed by SHA on purpose: a review of an earlier commit does not count. If anything has been
committed since the review ran -- INCLUDING the fixes the review asked for -- review again.

Do not write a record for a review you did not run, and do not restructure the command to get
past this check."
fi
# -x -F: whole line, literal. Unanchored `grep -a "reviewed-remote: $remote"` treated the URL
# as a regex (so "." matched anything) AND matched a prefix, so an origin of .../acme/a
# satisfied a record naming .../acme/a.git.
grep -aqxF "reviewed-sha: $sha" "$rec" 2>/dev/null || emit "The review record
.claude/reviews/$sha.md has no line reading exactly 'reviewed-sha: $sha'."
# The remote is checked because a checkout's origin can point at a repository quite unrelated to
# its directory name, which silently redirected a valid record at another GitHub repo entirely.
grep -aqxF "reviewed-remote: $remote" "$rec" 2>/dev/null || emit "The review record
.claude/reviews/$sha.md carries no 'reviewed-remote: $remote' line. This checkout's origin is
  $remote
and a record that does not name it may have been written for a different repository."

bytes=$(wc -c < "$rec" 2>/dev/null | tr -d ' ')
case "$bytes" in ''|*[!0-9]*) emit "Could not size .claude/reviews/$sha.md." ;; esac
[ "$bytes" -ge 400 ] || emit "The review record for $short is $bytes bytes -- too short to be a
real review. Record what was checked, what was found, and what you did about each finding."

exit 0
