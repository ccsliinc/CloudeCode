#!/bin/bash
# deploy-lib.sh - transfer and verification helpers for deploy-mini.sh.
#
# WHY THIS IS A SEPARATE FILE. Two reasons. The verification half is
# useful on its own (deploy-mini.sh --verify-only re-checks a target at
# any time, which is exactly what HANDOFF.md asks for after a restart),
# and keeping it here holds both files well under the 500 line rule.
#
# WHY TAR AND NOT RSYNC. Measured 2026-09-07: both this Mac and the mini
# ship Apple openrsync (protocol 29, "rsync 2.6.9 compatible"), not GNU
# rsync 3.x. openrsync handles --files-from=- --relative correctly; what
# it does NOT survive is a remote destination containing SPACES. The
# remote shell word-splits the path and the receiver reports
#
#     server receiver mode requires two argument
#
# Both live destinations contain spaces ("Application Support" and
# "Cloude Code.app"), so `--target live` could never work while
# `--target v11` always did. Escaping the spaces does fix rsync, but it
# leaves a trap that reappears the moment somebody adds a destination.
# tar over ssh has no such edge: the remote command is one quoted string
# this script controls, and the destination is handed over on stdin
# rather than spliced into a command line. It also costs no new
# dependency, which rsync 3.x would.
#
# THE SHAPE OF A DEPLOY. Stage, verify, then commit:
#   1. tar the file list into ONE staging dir on the mini
#   2. sha256 the staging dir against the local files
#   3. only then copy staging into each real destination
#   4. sha256 each destination against the local files
# Step 2 is what makes this fail safe. A broken pipe or a corrupted
# transfer is caught while production is still untouched.
#
# All functions run with the repo root as the working directory and take
# file lists as newline delimited paths relative to it. A path containing
# a newline is not supported and would break tar -T as well.

# dl_local_hashes - sha256 every file in a list, from the repo root.
# Inputs:  $1 listfile (path), $2 outfile (path)
# Output:  writes "<sha256>  <path>" lines to outfile; returns 0, or 1 if
#          the list is empty.
# Example: dl_local_hashes /tmp/files.txt /tmp/local.sha
dl_local_hashes() {
    local listfile="$1" outfile="$2"
    [ -s "$listfile" ] || return 1
    tr '\n' '\0' < "$listfile" | xargs -0 shasum -a 256 > "$outfile" 2>/dev/null
}

# dl_remote_hashes - sha256 the same file list inside a remote directory.
# Inputs:  $1 host, $2 remote dest dir, $3 listfile, $4 outfile
# Output:  writes "<sha256>  <path>" lines, or "MISSING  <path>" for a
#          file the target does not have, or the single token
#          __NO_DEST__ when the directory itself is unreachable.
# Notes:   ONE ssh round trip. The destination travels as the first line
#          of stdin, never on the command line, so a path with spaces
#          cannot be word split. A file that cannot be hashed becomes an
#          explicit MISSING line rather than vanishing from the
#          comparison, because absent on both sides compares equal and
#          that is how a verification step silently checks nothing.
# Example: dl_remote_hashes mac-mini-m4 "/Applications/X.app" list.txt out.sha
dl_remote_hashes() {
    local host="$1" dest="$2" listfile="$3" outfile="$4"
    { printf '%s\n' "$dest"; cat "$listfile"; } | ssh "$host" '
        IFS= read -r DEST
        cd "$DEST" 2>/dev/null || { echo "__NO_DEST__"; exit 0; }
        TMP=$(mktemp -t cloudedeploy) || exit 1
        cat > "$TMP"
        [ -s "$TMP" ] || { rm -f "$TMP"; exit 0; }
        while IFS= read -r f; do
            [ -f "$f" ] || printf "MISSING  %s\n" "$f"
        done < "$TMP"
        tr "\n" "\0" < "$TMP" | xargs -0 shasum -a 256 2>/dev/null
        rm -f "$TMP"
    ' > "$outfile" 2>/dev/null
}

# dl_norm - reduce a hash listing to sorted "<path><TAB><hash>" lines.
# Inputs:  $1 infile, $2 outfile
# Output:  none; writes outfile. Sorting by path makes the comparison
#          order independent instead of resting on shasum emitting the
#          list back in the order it was fed.
dl_norm() {
    sed -e 's/^\([0-9a-f]\{64\}\)  \(.*\)$/\2	\1/' \
        -e 's/^MISSING  \(.*\)$/\1	MISSING/' "$1" \
        | LC_ALL=C sort > "$2"
}

# dl_verify - prove a remote directory holds exactly the local bytes.
# Inputs:  $1 host, $2 remote dest, $3 listfile, $4 local hash file,
#          $5 human label for messages
# Output:  returns 0 on a byte for byte match, 4 on any mismatch or
#          missing file, 3 when the check could not be evaluated at all.
#          Prints the offending paths on failure.
# Notes:   This compares CONTENT on both sides. `git rev-parse` on either
#          end is not verification, it only reads back the claim the
#          deploy already believes.
dl_verify() {
    local host="$1" dest="$2" listfile="$3" localhash="$4" label="$5"
    local rh nl nr
    rh=$(mktemp -t cloudeverify) || return 3
    nl=$(mktemp -t cloudeverify) || return 3
    nr=$(mktemp -t cloudeverify) || return 3

    dl_remote_hashes "$host" "$dest" "$listfile" "$rh"

    if [ ! -s "$rh" ]; then
        echo "  CANNOT DETERMINE: no hash output came back from $label." >&2
        rm -f "$rh" "$nl" "$nr"; return 3
    fi
    if grep -q '__NO_DEST__' "$rh"; then
        echo "  CANNOT DETERMINE: $label does not exist or is unreadable:" >&2
        echo "    $dest" >&2
        rm -f "$rh" "$nl" "$nr"; return 3
    fi

    dl_norm "$localhash" "$nl"
    dl_norm "$rh" "$nr"

    if cmp -s "$nl" "$nr"; then
        rm -f "$rh" "$nl" "$nr"; return 0
    fi

    echo "  HASH MISMATCH at $label:" >&2
    echo "    $dest" >&2
    # Report the paths whose hash differs, not the raw diff, so the
    # operator sees which files are wrong rather than a wall of hex.
    LC_ALL=C join -t'	' -j1 "$nl" "$nr" 2>/dev/null \
        | awk -F'\t' '$2 != $3 { printf "    %s  (local %s, target %s)\n", $1, substr($2,1,12), substr($3,1,12) }' >&2
    LC_ALL=C comm -23 <(cut -f1 "$nl") <(cut -f1 "$nr") \
        | sed 's/^/    absent from target: /' >&2
    rm -f "$rh" "$nl" "$nr"
    return 4
}

# dl_stage - tar a file list from here into a fresh remote staging dir.
# Inputs:  $1 host, $2 listfile, $3 remote staging dir (no spaces, this
#          script chooses it)
# Output:  returns 0 on success, 1 if the archive or the extract failed.
# Notes:   The caller must have `set -o pipefail` for a failure in the
#          sending half to be seen.
dl_stage() {
    local host="$1" listfile="$2" stagedir="$3"
    # shellcheck disable=SC2029  # $stagedir is ours and must expand here
    ssh "$host" "rm -rf '$stagedir' && mkdir -p '$stagedir'" || return 1
    # shellcheck disable=SC2029  # $stagedir is ours and must expand here
    tar -cf - -T "$listfile" | ssh "$host" "tar -xf - -C '$stagedir'" || return 1
}

# dl_commit - copy a verified staging dir into a real destination.
# Inputs:  $1 host, $2 remote staging dir, $3 destination dir
# Output:  returns ditto's exit status.
# Notes:   ditto merges the tree rather than replacing it, creates the
#          destination and any intermediate directories, and is a single
#          command with a real exit status (no remote pipeline whose
#          status would hide the sending half). The destination goes over
#          stdin so spaces in it cannot be word split. Correctness does
#          not rest on this call reporting truthfully: every destination
#          is hashed independently afterwards.
dl_commit() {
    local host="$1" stagedir="$2" dest="$3"
    printf '%s\n' "$dest" | ssh "$host" \
        'IFS= read -r DEST; mkdir -p "$DEST" && ditto '"'$stagedir'"' "$DEST"'
}

# dl_unstage - remove a remote staging dir. Best effort, never fatal.
# Inputs:  $1 host, $2 remote staging dir
# Output:  always returns 0.
dl_unstage() {
    # shellcheck disable=SC2029  # the staging path is ours and must expand here
    ssh "$1" "rm -rf '$2'" >/dev/null 2>&1 || true
    return 0
}
