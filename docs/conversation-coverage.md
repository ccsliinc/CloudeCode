# Is every conversation in the database

The plain answer, and the standing check that keeps it answered.

## Run it yourself

```
cd <repo>
venv/bin/python3 scripts/transcript-archive/verify_all_conversations.py
```

Exit 0 means every conversation ever observed is in the live archive. Exit 1
means a gap, and the gap is printed with the stem, the size and the exact
tarball and path holding the only copy. Exit 2 means could not evaluate, which
is NEVER a pass: an unreadable archive, a missing census and an unreadable
corpus root all land here rather than quietly reading as zero.

Prove it can fail before you believe a green run:

```
venv/bin/python3 scripts/transcript-archive/verify_all_conversations.py --self-test
```

Refresh the recorded inventory of offline sources when the NAS is reachable:

```
cd scripts/transcript-archive
../../venv/bin/python3 build_conversation_census.py --nas truenas_admin@10.0.1.237
```

## What a conversation is

One real Claude Code session transcript. Identity is the FILE STEM of its
`.jsonl`, never the path and never the `sessionId` inside it.

Path is wrong because the same conversation appears under both the short
`-Users-jsugamele-Development-*` slug and the long iCloud slug of the same
directory, and a pass that compared paths once reported near-total loss on that
alone. `sessionId` is wrong because an `agent-*.jsonl` subagent run records its
PARENT's id, so keying on it collapses 19,000 files onto about 1,300 ids.

An `agent-*.jsonl` is a sub-task this app spawned inside a conversation, not
something the owner sat down and had. Both are counted; the verdict leads with
conversations and reports subagent runs separately, so the two can never be
folded together to make a total look better.

Twenty-four files ending in `.jsonl` are deliberately NOT conversations and are
excluded by name: MCP server logs under `caches/claude-cli-nodejs/*/mcp-logs-*`,
the CLI prompt history file `history.jsonl`, a plugin test fixture
(`cursor-session.jsonl`) and this app's own `migration_trail.jsonl`. Counting
them would have reported 100 missing conversations where there are 76.

## The honest statement

Every conversation that has ever existed on any machine the owner has, on
current count **1,355**, is accounted for: **1,279 are in the live archive right
now**, and the remaining **76 are not, but every one of them is on the NAS with a
recorded sha256, so they can be restored byte for byte**. Seventy-two of those
76 are the Gogs-only set deleted from the working tree in December 2025, which
exist on no live machine and whose only copy is
`claude-archive-20260830/03-gogs-history-6d8879b.tar.zst`; the other four are
three from a January 2026 mini snapshot and one from the old `~/.claude2` tree.
Nothing is lost.

What is NOT covered, said out loud. **195 OpenAI Codex CLI conversations** under
`~/.codex/sessions` are outside this archive's scope entirely and always have
been, because this archive holds Claude Code transcripts. Subagent runs are
counted but not enumerated in the recorded census, so a subagent run that
vanished from every source at once would be invisible to the census, though not
to the live disk-versus-archive comparison; a conversation would be caught
either way.

**What would make a future conversation invisible to the archive.** A
conversation written on a machine whose corpus this app never sees, or into a
directory outside `~/.claude/projects`. A conversation deleted from disk during
a window when the ingester is not running and before its next pass. And a
conversation recorded by a tool that is not Claude Code, which is exactly the
Codex case above. The check catches the first two by comparing disk to archive
on every run; the third it can only name, which is why it names it.

## Sources reconciled

Every source below was read and compared, not sampled.

| source | conversations | not in live archive |
|---|---:|---:|
| live archive `cloude-archive.db` | 1,279 | 0 |
| disk corpus `~/.claude/projects` | 1,273 | 0 |
| local `cloude.online-backup.db` | 1,272 | 0 |
| local `cloude.db.bak-v25`, `bak-v26`, `bak-preLAM` | 1,272 to 1,273 | 0 |
| NAS `cloude-archive-20260903.db` | 1,225 | 0 |
| NAS `cloude-app-20260903.db` | 1,229 | 0 |
| NAS `cloude-db-20260911.db` | 1,272 | 0 |
| NAS `multihost.db` (2 hosts, 3 corpora) | 1,218 | 0 |
| NAS `09-claude-history-db` (third DB, 22 GB, 5.97M messages) | 1,200 | 0 |
| NAS `claude-config` git, all 131 commits | 1,284 | 0 new |
| NAS tarball 01 laptop-projects | 1,205 | 0 |
| NAS tarball 02 mini-projects | 220 | 0 |
| **NAS tarball 03 gogs-history-6d8879b** | **72** | **72** |
| **NAS tarball 04 mini-claude-backup-20260106** | **3** | **3** |
| NAS tarball 05 desktop-backups | 13 | 0 |
| **NAS tarball 06 misc-claude2-and-app-sessions** | **1** | **1** |
| NAS tarball 07 icloud-conflict-preserve | 1 | 0 |
| NAS tarball 11 formmanager-scratch-repo (no manifest) | 222 | 0 |

The tarballs were reconciled through their per-file `sha256 TAB size TAB path`
manifests rather than by expanding 14 GB of archives, because the manifest
carries exactly the stem, size and hash the question needs. The two sources with
no manifest were handled directly: `09` was decompressed and queried (its
decompressed sha256 matched the value recorded in its MANIFEST.md exactly), and
the `claude-config` git repository was extracted and walked across every commit
from 2025-08-29 to 2026-08-29 rather than only the one tree tarball 03 was cut
from. That walk found 8 further `.jsonl` stems, all of them
`.claude/transcripts/archives/latest_<uuid>.jsonl` backup COPIES made by the
owner's own tooling in January 2026, and all six underlying conversation uuids
are in the live archive. They are copies, not conversations, and are not counted.

The third unmanifested source, `11-formmanager-scratch-repo` at 25 GB, was
listed by streaming `zstd -dc | tar -tf` so nothing was written to disk. It holds
985,973 members and 2,395 real `.jsonl` once macOS AppleDouble `._` sidecars are
dropped, none of them under a `projects/` directory; all 222 uuid-named
transcripts in it are already in the live archive. Sources `08-podio` and
`10-llmscratch-misc` contain zero `.jsonl` by their own manifests.
