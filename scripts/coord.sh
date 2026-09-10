#!/usr/bin/env bash
#
# coord.sh - the cross-team coordination helper for CloudeCode.
#
# Two independent teams work this codebase and neither stops for the other:
# ccsliinc (remote `origin`) and adoom666 (remote `adamdev`). This script is the
# only git plumbing either side needs in order to say what it is working on and
# to read what the other side said.
#
# Everything lives on an ORPHAN branch named `coord` that carries no code at
# all, so a claim can be published without shipping, compiling or testing
# anything. The full protocol is `README.md` on that branch.
#
# Subcommands
#   init    Create the local `coord` branch and its working checkout.
#   status  Show both sides' current work, live claims, and any overlap.
#   now     Replace your own "what I am on right now" file (reads stdin).
#   claim   Open or refresh a claim over a set of path globs, with its APPROACH.
#   log     Prepend a landed-work entry to your own log (reads stdin).
#   note    Write a free-prose note addressed to the other party (reads stdin).
#   settled Record a design decision that is already ruled on (reads stdin).
#   sync    Fetch the coord branch from the shared remote, rebase, push.
#
# Exit codes
#   0  did the job
#   2  usage error (bad or missing arguments)
#   3  cannot determine (the coord branch or the code tree is not available)
#   4  refused (would write another party's file, or would push to `upstream`)
#   5  a git operation failed
#
# Example
#   scripts/coord.sh claim --slug listing-perf --title "session listing performance" \
#       --branch release/1.2.1 --paths "src/core/session_manager.py src/core/pipe_wakeup.py" \
#       --approach "bulk one tmux listing per pass and index it by instance triple;
#   assumes a listing may only vouch for its own socket" \
#       <<< "why this matters and what I would hand over"

set -euo pipefail

readonly COORD_BRANCH="coord"
readonly COORD_REMOTE="adamdev"
readonly FORBIDDEN_REMOTE="upstream"
readonly DEFAULT_PARTY="ccsliinc"
readonly OTHER_PARTY_DEFAULT="adoom666"
readonly DEFAULT_CLAIM_DAYS=3

readonly EXIT_OK=0
readonly EXIT_USAGE=2
readonly EXIT_CANNOT_DETERMINE=3
readonly EXIT_REFUSED=4
readonly EXIT_GIT_FAILED=5

# WHO YOU ARE IS PINNED TO THE CLONE, NOT PASSED PER COMMAND. It resolves from
# `git config coord.party`, then $COORD_PARTY, then the default. A per-command
# flag would make the "refuses to write another party's files" guard decorative,
# because anyone could simply assert the other party's name for one invocation.
# Adam's clone sets `git config coord.party adoom666` once and every write he
# makes lands in his own namespace by construction.
PARTY="$(git config --get coord.party 2>/dev/null || true)"
[ -n "$PARTY" ] || PARTY="${COORD_PARTY:-$DEFAULT_PARTY}"

# die: print a message to stderr and exit with a named code.
# Inputs: $1 exit code (int), $2.. message (string)
# Outputs: never returns.
die() {
  local code="$1"; shift
  printf 'coord.sh: %s\n' "$*" >&2
  exit "$code"
}

# today_utc: today's date in UTC as YYYY-MM-DD.
# Inputs: none. Outputs: date string on stdout.
today_utc() { date -u +%Y-%m-%d; }

# now_utc: the current UTC instant as YYYY-MM-DDTHH:MMZ.
# Inputs: none. Outputs: timestamp string on stdout.
now_utc() { date -u +%Y-%m-%dT%H:%MZ; }

# date_plus_days: a UTC date N days from today, on BSD or GNU date.
# Inputs: $1 number of days (int)
# Outputs: YYYY-MM-DD on stdout. Exits 5 if neither date flavour works.
date_plus_days() {
  local days="$1"
  date -u -v"+${days}d" +%Y-%m-%d 2>/dev/null && return 0
  date -u -d "+${days} days" +%Y-%m-%d 2>/dev/null && return 0
  die "$EXIT_GIT_FAILED" "cannot do date arithmetic with this date(1)"
}

# git_common_dir: absolute path of the shared .git directory for this clone.
# Every linked worktree resolves to the SAME directory, which is what makes all
# of our worktrees share one coordination checkout.
# Inputs: none. Outputs: absolute path on stdout. Exits 3 outside a repo.
git_common_dir() {
  local d
  d="$(git rev-parse --git-common-dir 2>/dev/null)" \
    || die "$EXIT_CANNOT_DETERMINE" "not inside a git repository"
  (cd "$d" && pwd)
}

# coord_dir: absolute path of the coordination worktree.
# Inputs: none. Outputs: absolute path on stdout.
coord_dir() { printf '%s/coord-worktree\n' "$(git_common_dir)"; }

# coord_ready: succeed only when the coordination checkout exists and is usable.
# Inputs: none. Outputs: nothing. Returns 0 when ready, 1 otherwise.
coord_ready() {
  local d; d="$(coord_dir)"
  [ -d "$d" ] && [ -f "$d/README.md" ]
}

# require_coord: exit 3 with a plain instruction when the checkout is missing.
# Inputs: none. Outputs: nothing on success.
require_coord() {
  coord_ready && return 0
  die "$EXIT_CANNOT_DETERMINE" \
    "no coordination checkout. run: scripts/coord.sh init"
}

# lock_acquire: take a whole-script lock so two worktrees cannot write at once.
# mkdir is atomic on POSIX, so this needs no external dependency.
# Inputs: none. Outputs: nothing. Exits 5 if the lock is held.
lock_acquire() {
  local lock; lock="$(git_common_dir)/coord-worktree.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    die "$EXIT_GIT_FAILED" \
      "another coord.sh holds $lock; remove it by hand if that is stale"
  fi
  # shellcheck disable=SC2064
  trap "rmdir '$lock' 2>/dev/null || true" EXIT
}

# assert_own_file: refuse to write a path that is not this party's to write.
# Every writable file in the layout carries the writer's name, so this is a
# string test rather than a judgement call.
# Inputs: $1 path relative to the coord root (string)
# Outputs: nothing. Exits 4 when the path belongs to someone else.
assert_own_file() {
  local rel="$1" base
  base="$(basename "$rel")"
  case "$rel" in
    now/*|log/*|settled/*)
      [ "$base" = "${PARTY}.md" ] || die "$EXIT_REFUSED" \
        "refusing to write $rel: party is '$PARTY', that file is not yours" ;;
    claims/*|notes/*)
      case "$base" in
        "${PARTY}-"*) : ;;
        *) die "$EXIT_REFUSED" \
             "refusing to write $rel: every file here must start with '${PARTY}-'" ;;
      esac ;;
    *)
      die "$EXIT_REFUSED" "refusing to write $rel: not a writable path in this layout" ;;
  esac
}

# read_stdin_body: collect prose from stdin, refusing an interactive terminal.
# Inputs: none (reads stdin). Outputs: the body on stdout.
read_stdin_body() {
  if [ -t 0 ]; then
    die "$EXIT_USAGE" "this subcommand reads its body from stdin; pipe it or use a heredoc"
  fi
  cat
}

# coord_commit: stage one path in the coordination checkout and commit it.
# Inputs: $1 path relative to the coord root, $2 commit subject
# Outputs: nothing. Exits 5 when git refuses.
coord_commit() {
  local rel="$1" subject="$2" d main scanner py; d="$(coord_dir)"
  git -C "$d" add -- "$rel" || die "$EXIT_GIT_FAILED" "git add failed for $rel"
  if git -C "$d" diff --cached --quiet; then
    printf 'no change to %s, nothing committed\n' "$rel"
    return 0
  fi

  # THE SECRET SCAN RUNS HERE, EXPLICITLY, and the hook is bypassed only
  # because it cannot resolve itself from an orphan branch that carries no
  # scripts/ directory. A claim or a note is exactly the kind of prose someone
  # pastes a token into, so skipping the gate outright was not an option; this
  # runs the SAME scanner the hook runs, from the main worktree, and refuses on
  # anything but a clean exit 0. Exit 2 means it could not scan, and 2 is not 0.
  main="$(dirname "$(git_common_dir)")"
  scanner="$main/scripts/scan_secrets.py"
  if [ -f "$scanner" ]; then
    if [ -x "$main/venv/bin/python3" ]; then py="$main/venv/bin/python3"; else py=python3; fi
    "$py" "$scanner" --staged --repo "$d" \
      || die "$EXIT_REFUSED" "secret scan refused this commit (exit above). nothing was committed."
  else
    die "$EXIT_CANNOT_DETERMINE" \
      "cannot find $scanner, so the secret scan could not run. refusing to commit."
  fi

  git -C "$d" commit -q --no-verify -m "$subject" \
    || die "$EXIT_GIT_FAILED" "git commit failed for $rel"
  printf 'committed %s on branch %s\n' "$rel" "$COORD_BRANCH"
}

# field_of: read one flat `key: value` field from a claim's header block.
# The header is deliberately flat so this needs no YAML parser.
# Inputs: $1 file path, $2 key name
# Outputs: the value on stdout, empty when absent.
field_of() {
  sed -n '2,/^---$/p' "$1" 2>/dev/null \
    | sed -n "s/^${2}:[[:space:]]*//p" | head -1
}

# approach_of: the prose under a claim's `## approach` heading.
# The approach is the design direction, not the file list. It is the field that
# catches the collisions git cannot see, so it is required on every claim.
# Inputs: $1 claim file path
# Outputs: the approach prose on stdout, empty when absent.
approach_of() {
  sed -n '/^## approach$/,/^## /p' "$1" 2>/dev/null \
    | sed '1d;/^## /d;/^$/d'
}

# claim_is_live: true when a claim is `active` or `paused` and not past expiry.
# Nothing ever deletes an expired claim; expiry is COMPUTED at read time, so a
# stale claim degrades to history instead of freezing an area forever.
# Inputs: $1 claim file path
# Returns: 0 when live, 1 otherwise.
claim_is_live() {
  local f="$1" status expires today
  status="$(field_of "$f" status)"
  expires="$(field_of "$f" expires)"
  today="$(today_utc)"
  [ "$status" = "active" ] || [ "$status" = "paused" ] || return 1
  [ -n "$expires" ] || return 1
  [[ "$expires" > "$today" || "$expires" == "$today" ]]
}

# tracked_files: every path git tracks in the CODE tree this script was run from.
# Globs are intersected by expanding them against this list, because two globs
# that look nothing alike can still match the same file.
# Inputs: none. Outputs: one path per line. Exits 3 when the tree is unreadable.
tracked_files() {
  git ls-files 2>/dev/null || die "$EXIT_CANNOT_DETERMINE" \
    "cannot list tracked files, so overlap cannot be computed"
}

# expand_globs: the tracked files matched by a space separated glob list.
# `*` matches across `/` here, so `src/core/session_*.py` works as written and
# a `**` form is never needed.
# Inputs: $1 glob list (string), $2 tracked file list (newline separated string)
# Outputs: matched paths on stdout, sorted and unique.
expand_globs() {
  local globs="$1" files="$2" g f
  # PATHNAME EXPANSION IS DISABLED WHILE THE GLOB LIST IS SPLIT. Without this,
  # the shell expands a claim's globs against the CURRENT DIRECTORY before the
  # loop ever runs, so the claim would silently be matched against whatever
  # happens to be on disk beside the caller rather than against the tracked
  # file list. `set -f` off, split, `set +f` back on before the comparison,
  # because the comparison itself needs the pattern to still be a pattern.
  set -f
  local -a patterns=($globs)
  set +f
  {
    for g in ${patterns+"${patterns[@]}"}; do
      while IFS= read -r f; do
        # shellcheck disable=SC2053
        if [[ "$f" == $g ]]; then printf '%s\n' "$f"; fi
      done <<< "$files"
    done
  } | sort -u
  # An explicit success. The loop's last comparison is usually a non-match, and
  # under `set -e` that status would propagate out of the assignment that calls
  # this and kill the whole status pass silently, printing a partial report.
  return 0
}

# all_parties: every party name the coordination checkout knows about.
# Derived from the now/ and log/ files that exist plus the two we always expect,
# so a party that has never written anything is still listed as silent.
# Inputs: none. Outputs: one party name per line, sorted and unique.
all_parties() {
  local d; d="$(coord_dir)"
  {
    printf '%s\n%s\n' "$DEFAULT_PARTY" "$OTHER_PARTY_DEFAULT"
    printf '%s\n' "$PARTY"
    ls "$d/now" 2>/dev/null | sed 's/\.md$//'
    ls "$d/log" 2>/dev/null | sed 's/\.md$//'
    ls "$d/settled" 2>/dev/null | sed 's/\.md$//'
  } | sed '/^$/d' | sort -u
}

cmd_init() {
  local d; d="$(coord_dir)"
  if coord_ready; then
    printf 'coordination checkout already present at %s\n' "$d"
    return 0
  fi
  lock_acquire
  if git show-ref --verify --quiet "refs/heads/$COORD_BRANCH"; then
    git worktree add "$d" "$COORD_BRANCH" >/dev/null \
      || die "$EXIT_GIT_FAILED" "could not attach a worktree for $COORD_BRANCH"
    printf 'attached existing branch %s at %s\n' "$COORD_BRANCH" "$d"
    return 0
  fi
  git worktree add --detach "$d" HEAD >/dev/null \
    || die "$EXIT_GIT_FAILED" "could not create the coordination worktree"
  git -C "$d" switch --orphan "$COORD_BRANCH" >/dev/null 2>&1 \
    || die "$EXIT_GIT_FAILED" "could not create the orphan branch $COORD_BRANCH"
  git -C "$d" rm -rq --cached . 2>/dev/null || true
  find "$d" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
  mkdir -p "$d/now" "$d/log" "$d/claims" "$d/notes"
  git config coord.party "$PARTY" 2>/dev/null || true
  printf 'created the orphan branch %s at %s. it carries no code.\n' "$COORD_BRANCH" "$d"
  printf 'this clone writes as party "%s" (git config coord.party).\n' "$PARTY"
  printf 'nothing has been pushed. `coord.sh sync` publishes it.\n'
}

cmd_now() {
  require_coord
  lock_acquire
  local d rel body; d="$(coord_dir)"; rel="now/${PARTY}.md"
  assert_own_file "$rel"
  body="$(read_stdin_body)"
  mkdir -p "$d/now"
  {
    printf '# %s is working on\n\n' "$PARTY"
    printf 'updated: %s\n\n' "$(now_utc)"
    printf '%s\n' "$body"
  } > "$d/$rel"
  coord_commit "$rel" "now(${PARTY}): update current work"
}

cmd_claim() {
  require_coord
  local slug="" title="" branch="" paths="" days="$DEFAULT_CLAIM_DAYS" status="active" approach=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug) slug="${2:-}"; shift 2 ;;
      --title) title="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --paths) paths="${2:-}"; shift 2 ;;
      --approach) approach="${2:-}"; shift 2 ;;
      --days) days="${2:-}"; shift 2 ;;
      --status) status="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown argument to claim: $1" ;;
    esac
  done
  [ -n "$slug" ] || die "$EXIT_USAGE" "claim needs --slug"
  [ -n "$title" ] || die "$EXIT_USAGE" "claim needs --title"
  [ -n "$paths" ] || die "$EXIT_USAGE" "claim needs --paths"
  case "$status" in active|paused|done) : ;;
    *) die "$EXIT_USAGE" "--status must be active, paused or done" ;; esac
  case "$slug" in *[!a-z0-9-]*) die "$EXIT_USAGE" \
    "--slug must be lowercase letters, digits and hyphens" ;; esac

  lock_acquire
  local d rel body opened; d="$(coord_dir)"; rel="claims/${PARTY}-${slug}.md"
  assert_own_file "$rel"
  body="$(read_stdin_body)"
  opened="$(today_utc)"
  if [ -f "$d/$rel" ]; then
    opened="$(field_of "$d/$rel" opened)"
    # A refresh keeps the approach it already carries, so bumping expiry is one
    # short command and nobody is tempted to skip the refresh to avoid retyping.
    [ -n "$approach" ] || approach="$(approach_of "$d/$rel")"
  fi
  [ -n "$opened" ] || opened="$(today_utc)"
  # THE APPROACH IS REQUIRED, and it is the one piece of ceremony worth
  # enforcing. Measured on the 2026-09-10 merge of the two lines: only two files
  # conflicted in git and both were docs. Every expensive collision that week
  # was a DESIGN collision no path list could have caught.
  [ -n "$approach" ] || die "$EXIT_USAGE" \
    "claim needs --approach: the design direction, the invariant you assume, and any shared semantics you expect to change"
  mkdir -p "$d/claims"
  {
    printf -- '---\n'
    printf 'party: %s\n' "$PARTY"
    printf 'id: %s-%s\n' "$PARTY" "$slug"
    printf 'title: %s\n' "$title"
    printf 'branch: %s\n' "${branch:-unstated}"
    printf 'opened: %s\n' "$opened"
    printf 'refreshed: %s\n' "$(today_utc)"
    printf 'expires: %s\n' "$(date_plus_days "$days")"
    printf 'status: %s\n' "$status"
    printf 'paths: %s\n' "$paths"
    printf -- '---\n\n'
    printf '# %s\n\n' "$title"
    printf '## approach\n\n'
    printf '%s\n\n' "$approach"
    printf '## detail\n\n'
    printf '%s\n' "$body"
  } > "$d/$rel"
  coord_commit "$rel" "claim(${PARTY}): ${title}"
}

cmd_log() {
  require_coord
  local title=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown argument to log: $1" ;;
    esac
  done
  [ -n "$title" ] || die "$EXIT_USAGE" "log needs --title"
  lock_acquire
  local d rel body tmp; d="$(coord_dir)"; rel="log/${PARTY}.md"
  assert_own_file "$rel"
  body="$(read_stdin_body)"
  mkdir -p "$d/log"
  tmp="$(mktemp)"
  {
    printf '# %s landed\n\n' "$PARTY"
    printf 'newest first. append only, never edit an entry once written.\n\n'
    printf '## %s %s\n\n' "$(today_utc)" "$title"
    printf '%s\n\n' "$body"
    if [ -f "$d/$rel" ]; then
      tail -n +5 "$d/$rel"
    fi
  } > "$tmp"
  mv "$tmp" "$d/$rel"
  coord_commit "$rel" "log(${PARTY}): ${title}"
}

cmd_note() {
  require_coord
  local slug=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug) slug="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown argument to note: $1" ;;
    esac
  done
  [ -n "$slug" ] || die "$EXIT_USAGE" "note needs --slug"
  case "$slug" in *[!a-z0-9-]*) die "$EXIT_USAGE" \
    "--slug must be lowercase letters, digits and hyphens" ;; esac
  lock_acquire
  local d rel body; d="$(coord_dir)"; rel="notes/${PARTY}-${slug}.md"
  assert_own_file "$rel"
  body="$(read_stdin_body)"
  mkdir -p "$d/notes"
  {
    printf '<!-- written by %s, %s -->\n\n' "$PARTY" "$(now_utc)"
    printf '%s\n' "$body"
  } > "$d/$rel"
  coord_commit "$rel" "note(${PARTY}): ${slug}"
}

cmd_settled() {
  require_coord
  local title=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown argument to settled: $1" ;;
    esac
  done
  [ -n "$title" ] || die "$EXIT_USAGE" "settled needs --title"
  lock_acquire
  local d rel body tmp; d="$(coord_dir)"; rel="settled/${PARTY}.md"
  assert_own_file "$rel"
  body="$(read_stdin_body)"
  mkdir -p "$d/settled"
  tmp="$(mktemp)"
  {
    printf '# design decisions %s treats as settled\n\n' "$PARTY"
    printf 'newest first. these are already ruled on. if your work would reverse\n'
    printf 'one of them, that is an overlap: stop and surface it to your human.\n\n'
    printf '## %s %s\n\n' "$(today_utc)" "$title"
    printf '%s\n\n' "$body"
    [ -f "$d/$rel" ] && tail -n +6 "$d/$rel"
  } > "$tmp"
  mv "$tmp" "$d/$rel"
  coord_commit "$rel" "settled(${PARTY}): ${title}"
}

cmd_status() {
  require_coord
  local d today; d="$(coord_dir)"; today="$(today_utc)"
  printf 'coordination branch %s, checkout %s\n' "$COORD_BRANCH" "$d"
  printf 'the rules live in %s/README.md\n' "$d"
  printf 'you are party "%s". today is %s.\n\n' "$PARTY" "$today"

  # Render every party the layout knows about, not a hardcoded pair, so a third
  # party joining needs no code change and running as adoom666 does not hide us.
  local p f
  for p in $(all_parties); do
    printf -- '--- %s is working on ---\n' "$p"
    if [ -f "$d/now/${p}.md" ]; then
      sed -n '3,40p' "$d/now/${p}.md"
    else
      printf 'no now/%s.md on the coord branch. this side has said nothing here.\n' "$p"
    fi
    printf '\n'
  done

  printf -- '--- claims ---\n'
  local any=0
  for f in "$d"/claims/*.md; do
    [ -e "$f" ] || continue
    any=1
    local state="LIVE"
    claim_is_live "$f" || state="EXPIRED_OR_DONE"
    printf '%-16s %-22s %-18s %s\n' \
      "$(field_of "$f" party)" "$(field_of "$f" id)" \
      "$(field_of "$f" status)/$(field_of "$f" expires)" "$state"
    printf '    %s\n' "$(field_of "$f" title)"
    printf '    branch: %s\n' "$(field_of "$f" branch)"
    printf '    paths:  %s\n' "$(field_of "$f" paths)"
    printf '    approach:\n'
    approach_of "$f" | sed 's/^/      /'
  done
  [ "$any" = 1 ] || printf 'no claims filed.\n'
  printf '\n'

  printf -- '--- design decisions each party treats as settled ---\n'
  local sp had_settled=0
  for sp in $(all_parties); do
    if [ -f "$d/settled/${sp}.md" ]; then
      had_settled=1
      printf '%s:\n' "$sp"
      grep -E '^## ' "$d/settled/${sp}.md" | sed 's/^## /    /'
    fi
  done
  [ "$had_settled" = 1 ] || printf 'none recorded.\n'
  printf '\n'

  printf -- '--- path overlap between live claims of different parties ---\n'
  local files
  if ! files="$(tracked_files)"; then
    printf 'CANNOT DETERMINE: no code tree to expand globs against.\n'
    return "$EXIT_CANNOT_DETERMINE"
  fi
  local a b overlaps=0
  for a in "$d"/claims/*.md; do
    [ -e "$a" ] || continue
    claim_is_live "$a" || continue
    for b in "$d"/claims/*.md; do
      [ -e "$b" ] || continue
      [ "$a" \< "$b" ] || continue
      claim_is_live "$b" || continue
      [ "$(field_of "$a" party)" != "$(field_of "$b" party)" ] || continue
      local ea eb shared
      ea="$(expand_globs "$(field_of "$a" paths)" "$files")"
      eb="$(expand_globs "$(field_of "$b" paths)" "$files")"
      shared="$(comm -12 <(printf '%s\n' "$ea") <(printf '%s\n' "$eb") | sed '/^$/d')"
      if [ -n "$shared" ]; then
        overlaps=$((overlaps + 1))
        printf 'OVERLAP  %s  <->  %s\n' "$(field_of "$a" id)" "$(field_of "$b" id)"
        printf '%s\n' "$shared" | sed 's/^/    /'
        printf '    STOP. do not resolve this yourself. surface both claims to your human.\n'
      fi
    done
  done
  if [ "$overlaps" = 0 ]; then
    printf 'none, measured against %s tracked files.\n' "$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  fi
  printf '\n'

  # A PATH OVERLAP IS THE CHEAP HALF AND A MACHINE CAN FIND IT. The expensive
  # half is a DESIGN overlap: two parties changing the same model in different
  # files, which git merges cleanly and silently. No script can decide that, so
  # this prints the instruction rather than pretending to have checked.
  printf -- '--- design overlap: READ THIS, no script can compute it ---\n'
  printf 'read every approach above and every settled decision above.\n'
  printf 'if another party is changing a model your work assumes (a state\n'
  printf 'machine, a key, a rendering contract, a vocabulary), that is an\n'
  printf 'OVERLAP even when you share no file. stop and surface it to your\n'
  printf 'human exactly as you would a path overlap.\n'
}

cmd_sync() {
  require_coord
  lock_acquire
  local d; d="$(coord_dir)"
  if git remote get-url --push "$FORBIDDEN_REMOTE" 2>/dev/null | grep -qv DISABLED; then
    die "$EXIT_REFUSED" \
      "the push url for '$FORBIDDEN_REMOTE' is not the disabled sentinel; fix that before syncing"
  fi
  git -C "$d" fetch "$COORD_REMOTE" "$COORD_BRANCH" 2>/dev/null || {
    printf 'no %s/%s on the remote yet. nothing to merge.\n' "$COORD_REMOTE" "$COORD_BRANCH"
    printf 'publishing for the first time: git -C %s push -u %s %s\n' "$d" "$COORD_REMOTE" "$COORD_BRANCH"
    return "$EXIT_OK"
  }
  git -C "$d" rebase FETCH_HEAD \
    || die "$EXIT_GIT_FAILED" "rebase onto $COORD_REMOTE/$COORD_BRANCH failed; resolve in $d"
  git -C "$d" push "$COORD_REMOTE" "$COORD_BRANCH" \
    || die "$EXIT_GIT_FAILED" "push to $COORD_REMOTE failed"
  printf 'synced %s with %s\n' "$COORD_BRANCH" "$COORD_REMOTE"
}

usage() {
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  [ $# -ge 1 ] || { usage; exit "$EXIT_USAGE"; }
  local sub="$1"; shift
  # --party is a READ-ONLY lens for `status`. It is refused on every write, so
  # the only way to write as another party is to reconfigure your own clone,
  # which is exactly what the other party legitimately does on theirs.
  local rest=() saw_party=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --party)
        case "$sub" in
          status) PARTY="${2:-}"; saw_party=1 ;;
          *) die "$EXIT_REFUSED" \
               "--party is read-only and only valid on 'status'. to write as another party, set: git config coord.party <name>" ;;
        esac
        shift 2 ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  : "$saw_party"
  set -- ${rest+"${rest[@]}"}
  case "$sub" in
    init)   cmd_init "$@" ;;
    status) cmd_status "$@" ;;
    now)    cmd_now "$@" ;;
    claim)  cmd_claim "$@" ;;
    log)    cmd_log "$@" ;;
    note)   cmd_note "$@" ;;
    settled) cmd_settled "$@" ;;
    sync)   cmd_sync "$@" ;;
    help|-h|--help) usage ;;
    *) die "$EXIT_USAGE" "unknown subcommand '$sub'. try: scripts/coord.sh help" ;;
  esac
}

main "$@"
