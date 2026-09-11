#!/usr/bin/env bash
# Claim and coordinate work through GitHub issues and draft PRs.
#
# Does the three things an agent gets wrong by hand: picking the gh account
# that can actually see this repo, confirming a claim against an index that
# is not read-your-writes consistent, and checking a path list for overlap
# against every open claim.
#
# Everything else is plain `gh`. Read SKILL.md.
#
#   work.sh whoami            which gh account reaches this repo
#   work.sh free              open issues with no linked PR, in grab order
#   work.sh taken             open PRs, ie what is claimed
#   work.sh mine              your own open PRs
#   work.sh search TERM       issues and PRs matching, with bodies
#   work.sh area LABEL        every open issue in an area, for near-duplicates
#   work.sh check PATH...     overlap against open issues' file lists
#   work.sh claim N SLUG      draft-PR claim on issue N, with linkage confirm
#   work.sh reserve N SLUG D  same, held for a start date of D
#
# Exit: 0 fine, 2 overlap or lost tie, 3 cannot determine, 4 refused.
set -uo pipefail

REPO="${WORK_REPO:-Adoom666/CloudeCodeDev}"
BASE="${WORK_BASE:-master}"

# gh's active account is GLOBAL, so switching it fights any other session on
# this machine. Resolve a token for whichever authenticated account can see
# this repo and pass it per command instead.
gh_token() {
  if [ -n "${GH_TOKEN:-}" ]; then printf '%s' "$GH_TOKEN"; return 0; fi
  local accounts a tok
  accounts=$(gh auth status --hostname github.com --json hosts \
             --jq '.hosts["github.com"][].login' 2>/dev/null)
  for a in $accounts; do
    tok=$(gh auth token --user "$a" 2>/dev/null) || continue
    if GH_TOKEN="$tok" gh api "repos/$REPO" --jq .name >/dev/null 2>&1; then
      printf '%s' "$tok"; return 0
    fi
  done
  return 1
}

TOKEN=""
g() { GH_TOKEN="$TOKEN" gh "$@"; }

need_token() {
  TOKEN=$(gh_token) || {
    echo "No authenticated gh account can see $REPO." >&2
    echo "Authenticated: $(gh auth status --hostname github.com --json hosts \
        --jq '.hosts["github.com"][].login' 2>/dev/null | tr '\n' ' ')" >&2
    echo "Fix with: gh auth login --hostname github.com" >&2
    return 3
  }
}

cmd_whoami() {
  need_token || return 3
  echo "repo:    $REPO"
  echo "account: $(g api user --jq .login)"
  echo "base:    $BASE"
}

# Grab order, ruled 2026-09-11: Adoom666's issues p0 then p1 then p2, THEN
# ccsliinc's the same way. No priority label sorts after p2 inside its own
# author's group; any other author sorts after both. No GitHub `sort:`
# qualifier can express that, so the ordering is done here on the json.
# Authorship sets ORDER only. It is not ownership and it reserves nothing: a
# draft PR is still the only thing that makes an issue taken.
# Mirror of the same function on Adoom666/CloudeCodeDev master; keep them equal.
cmd_free()  { need_token || return 3
  g issue list -R "$REPO" --state open --search "-linked:pr" --limit 200 \
    --json number,title,author,labels \
  | jq -r '
      def arank: if   .author.login=="Adoom666" then 0
                 elif .author.login=="ccsliinc" then 1
                 else 2 end;
      def prank: [.labels[].name] as $l
               | if   $l|index("p0") then 0
                 elif $l|index("p1") then 1
                 elif $l|index("p2") then 2
                 else 3 end;
      map(. + {ar: arank, pr: prank})
      | sort_by(.ar, .pr, .number)
      | .[]
      | "\(.author.login)\t\(["p0","p1","p2","(none)"][.pr])\t#\(.number)\t\(.title)"
    ' | column -t -s $'\t'; }

cmd_taken() { need_token || return 3
  g pr list -R "$REPO" --state open --limit 50; }

cmd_mine()  { need_token || return 3
  g pr list -R "$REPO" --state open --author @me --limit 50; }

cmd_search() {
  need_token || return 3
  local term="$1"
  echo "=== open issues matching '$term'"
  g issue list -R "$REPO" --state open --search "$term" \
    --json number,title,body --limit 20 \
    --jq '.[] | "#\(.number) \(.title)\n\(.body // "" | .[0:600])\n"'
  echo "=== open PRs matching '$term'"
  g pr list -R "$REPO" --state open --search "$term" --limit 20
  echo "=== closed issues, last 30 days"
  g issue list -R "$REPO" --state closed --search "$term" --limit 10
  echo
  echo "PATHS ARE THE CHEAP HALF. Read the Approach sections above."
  echo "A design contradiction counts even with no shared file."
}

cmd_area() {
  need_token || return 3
  # The sweep that catches a near-duplicate whose title shares no words
  # with yours. Read them, do not skim the titles.
  g issue list -R "$REPO" --state open --label "$1" \
    --json number,title,body --limit 50 \
    --jq '.[] | "#\(.number) \(.title)\n\(.body // "" | .[0:600])\n"'
}

# Expand a claim's globs against this repo's real tracked files and intersect
# with what you are about to touch. Expansion beats string comparison: one
# side's src/core/*_manager.py and the other's literal session_manager.py
# look nothing alike and are the same file.
cmd_check() {
  need_token || return 3
  local tracked; tracked=$(git ls-files)
  local mine; mine=$(for p in "$@"; do
      printf '%s\n' "$tracked" | grep -E "^$(printf '%s' "$p" \
        | sed 's/[.]/\\./g; s/[*]/.*/g')$" || printf '%s\n' "$p"
    done | sort -u)
  local found=0 body num paths hit
  while IFS=$'\t' read -r num body; do
    [ -z "$num" ] && continue
    # The body arrives FLATTENED to one line (jq gsub above), so this cuts
    # the "Files and functions involved" section out of that single line
    # rather than parsing line-wise. Parsing it line-wise silently matched
    # nothing and made the detector report clean on a real overlap, which is
    # the exact failure this command exists to prevent.
    paths=$(printf '%s' "$body" \
            | sed -n 's/.*[Ff]iles and functions[^ ]* involved//p' \
            | sed 's/##.*//' \
            | tr -s ' ' '\n' | grep -E '^[A-Za-z0-9_.*-]+/' | sort -u)
    [ -z "$paths" ] && continue
    hit=$(for p in $paths; do
        printf '%s\n' "$tracked" | grep -E "^$(printf '%s' "$p" \
          | sed 's/[.]/\\./g; s/[*]/.*/g')$"
      done | sort -u | comm -12 - <(printf '%s\n' "$mine"))
    if [ -n "$hit" ]; then
      found=1
      echo "OVERLAP with issue #$num"
      printf '%s\n' "$hit" | sed 's/^/  /'
      echo
    fi
  done < <(g issue list -R "$REPO" --state open --json number,body --limit 100 \
           --jq '.[] | "\(.number)\t\(.body // "" | gsub("\n"; " "))"')
  if [ "$found" -eq 0 ]; then
    echo "no path overlap with any open issue"
    echo "Still read the Approach sections: a design overlap shares no file."
  fi
  return $(( found * 2 ))
}

# The draft PR is the claim. It opens BEFORE any code, because a PR has a
# branch and a commit where an assignee has nothing behind it.
_claim() {
  need_token || return 3
  local n="$1" slug="$2" first="${3:-}"
  local branch="feat/$n-$slug"
  g issue develop -R "$REPO" -c -b "$BASE" -n "$branch" "$n" >/dev/null || return 3
  git commit --allow-empty -q -m "claim #$n: $slug" || return 3
  git push -q -u origin "$branch" || return 3
  { [ -n "$first" ] && printf '%s\n\n' "$first"; printf 'Closes #%s\n' "$n"; } \
    | g pr create -R "$REPO" --draft -B "$BASE" -F - >/dev/null || return 3

  local mine; mine=$(g pr list -R "$REPO" --author @me --head "$branch" \
                     --json number --jq '.[0].number')
  [ -z "$mine" ] && { echo "could not find own PR after create" >&2; return 3; }

  # GitHub's linkage index is NOT read-your-writes consistent. Measured on an
  # idle repo: the FIRST read comes back empty every time, the link appears
  # about twelve seconds later. So the read is only VALID once it contains
  # OUR OWN pr number; absence of our own write means a stale index, not an
  # uncontested issue. Never conclude a win from an empty list.
  local linked winner i
  for i in $(seq 1 8); do
    linked=$(g issue view -R "$REPO" "$n" --json closedByPullRequestsReferences \
             --jq '.closedByPullRequestsReferences[].number' 2>/dev/null)
    printf '%s\n' "$linked" | grep -qx "$mine" && break
    sleep 5
  done
  if ! printf '%s\n' "$linked" | grep -qx "$mine"; then
    echo "COULD NOT CONFIRM the claim after 8 attempts. You have NOT won." >&2
    echo "Check the PR body actually contains 'Closes #$n'." >&2
    return 3
  fi

  # Lowest PR number wins. That counter is monotonic and server-side, so both
  # parties compute the same winner with no communication and no clock.
  winner=$(printf '%s\n' "$linked" | sort -n | head -1)
  if [ "$winner" != "$mine" ]; then
    echo "LOST the tie: #$winner claimed issue $n first (yours was #$mine)."
    echo "Close your PR, delete branch $branch, and comment naming #$winner."
    return 2
  fi
  echo "claimed issue $n as PR #$mine on $branch"
}

cmd_claim()   { _claim "$1" "$2" ""; }
cmd_reserve() {
  _claim "$1" "$2" "RESERVED - intended start: ${3:-unspecified} - holder: @$(g api user --jq .login)"
}

case "${1:-}" in
  whoami) shift; cmd_whoami "$@" ;;
  free)   shift; cmd_free "$@" ;;
  taken)  shift; cmd_taken "$@" ;;
  mine)   shift; cmd_mine "$@" ;;
  search) shift; [ $# -ge 1 ] || { echo "search needs a term"; exit 3; }; cmd_search "$@" ;;
  area)   shift; [ $# -ge 1 ] || { echo "area needs a label"; exit 3; }; cmd_area "$@" ;;
  check)  shift; [ $# -ge 1 ] || { echo "check needs a path"; exit 3; }; cmd_check "$@" ;;
  claim)  shift; [ $# -ge 2 ] || { echo "claim needs an issue number and a slug"; exit 3; }; cmd_claim "$@" ;;
  reserve) shift; [ $# -ge 2 ] || { echo "reserve needs an issue number and a slug"; exit 3; }; cmd_reserve "$@" ;;
  *) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' ; exit 3 ;;
esac
