# Decisions

Standing rulings. Adam owns the code and is the sole tie-breaker; a ruling he
gives either developer binds both. Record one here when you receive it, or it
is invisible to the other side.

This file lands through a pull request on purpose. A misremembered ruling gets
human review before it binds every agent, and a file is diffable and blameable
where a chat message is not.

Each entry names the repo it applies to. A ruling about one repo is not a
ruling about another.

---

## The row menu is one superset, not two implementations
**2026-09-10, scope: CloudeCodeDev**

Verbatim: "reconcile the two menus into ONE superset."

Both parties built a session row action menu on the same day. Landed as
ccsliinc's `546443e` on their `release/1.2.1`, merged here in `074b381`.
adoom666's three modules are the base; ccsliinc's behaviours were restored
alongside. Neither implementation was thrown away.

## Rename keeps all three doors
**2026-09-10, scope: CloudeCodeDev**

Verbatim: "dont remove the rename. i said merge not take everything."

`8898f07` removed double-click rename entirely and moved rename into the menu.
Overruled. Double-click, F2 and the menu item all call one editor through
`SessionSidebarRename.beginEdit`. The 250ms hold on a click on a renameable
name is the known price of keeping the gesture, not an oversight.

## Adam is the tie-breaker for every party
**2026-09-10, scope: all repos**

Verbatim: "i'm the tie-breaker on everything as i own the code."

An overlap needs one person to see both sides, not a negotiation between two.
Agents have no standing to negotiate with each other; surface both positions
to him verbatim and work the parts that do not intersect meanwhile.

## Work is claimed by draft PR, not by assignee
**2026-09-10, scope: CloudeCodeDev**

Replaces the `coord` orphan branch protocol. See `.claude/skills/work/`.

An assignee is a declaration with nothing behind it; a draft PR has a branch
and a commit. Any agent may pick up any free issue. Ties resolve by lowest PR
number, because that counter is monotonic and server-side, so both parties
compute the same winner without communicating.

The `coord` branch still holds ccsliinc's four claims, their log and their
lessons until they migrate. Nothing new goes there.

## Cross-repo rulings do not travel
**2026-09-10, scope: all repos**

ArgentSI requires protected main, signed commits, squash-merge and npm. None
of that binds CloudeCodeDev, which is a Python project with an unprotected
main by choice. Adam owning both codebases makes him the tie-breaker in both;
it does not make a decision about one a decision about the other.

## The outer ring carries unread, as a still green ring
**2026-09-09, scope: all repos**

The owner was shown two models and picked adoom666's, over ccsliinc's. Verbatim
answer: "1. his".

Both lines were fixing ONE report - "the ring around some of the leds are not
gray, which means there should be background tasks. i dont think those few have
any background tasks" - and fixed it opposite ways within hours. ccsliinc retired
the outer `unread` state and moved unread onto the inner dot. adoom666 kept the
ring and simply stopped it breathing. The owner picked the ring.

So, quoting the shipped code on `release/1.2.1` rather than any note:

- `client/js/status-led.js:123`:
  `const OUTER_STATES = ['active', 'steady', 'unread', 'off', 'dim'];`
  `unread` IS an outer state.
- A finished turn nobody has read paints `unread`, a crisp STILL green ring. A
  read session at rest takes `steady`. A dead pane or a lost transport takes
  `off`. An unmeasured one takes `dim`.
- MOTION is the load-bearing distinction: `active` is the only outer state that
  animates, so a light that MOVES is a session that is moving, which was the
  whole of the original complaint.
- The INNER dot carries the session's own state. `done` is what a finished turn
  holds while the green unread ring is around it; `idle` is what the dot becomes
  once that ring goes. That pair is what makes the ring's departure visible.
- `--led-color-unread` EXISTS (`client/css/status-led.css:162`, green via
  `--color-success`). It was not retired.

**Do not reintroduce the inner-dot-unread model. It was decided against, not
forgotten**, and the module header says so in those words. Anything in any
document that reads as though unread lives on the inner dot is describing the
branch that lost.

**How this entry was got wrong once, on 2026-09-10, and it is worth keeping.**
ccsliinc first recorded the INVERSE here, citing `settled/ccsliinc.md`, a
2026-09-08 `TODO.md` entry and a CLAUDE.md on a divergent branch. All three are
real and all three predate the ruling: they describe the state before the owner
chose. A dated record is evidence of what was true on that date. An older record
cannot overturn a newer ruling, and three agreeing stale sources are still stale.
Check the date on a record before you let it overturn a later one, and prefer
shipped code to any note.

## A dead pane leaves the live list and goes to Recent
**2026-09-08, scope: all repos**

Verbatim: "they go into recent, they can disappear."

A session whose process died has stopped, so its row leaves `GET /sessions/list`
rather than lingering there wearing a dead light. A restart from Recent is a
resume. `dead` stays in the LED vocabulary but is gallery-only. A round that read
the same measurement as a bug and made a husk KEEP its row, painted dead, was
overruled and reverted (`ba2aa5d`).

## The mark-unread CONTROL is not replaced by the unread INDICATOR
**2026-09-08, scope: all repos**

Verbatim: "when clicking a tab, the session is marked read. if i want it unread i
click unread. it allows me to know whats waiting."

Opening a tab clears the flag; the user's control is how it goes back on. The LED
painting unread is an indicator and does not remove the need for the control. It
ships behind `ui.show_mark_unread_control`, default on, so turning it off is a
setting rather than a deletion.

## Push only to origin and adamdev, never to upstream
**2026-09-08, scope: ccsliinc clones**

On ccsliinc's clone `origin` is `ccsliinc/CloudeCode` and `adamdev` is
`Adoom666/CloudeCodeDev`. The `upstream` remote (`Adoom666/CloudeCode`) has its
PUSH url set to the sentinel `DISABLED_do_not_push_to_Adoom666_CloudeCode` so a
push there fails by construction. Do not repair it, and re-apply it on any fresh
clone. This is a ruling about ccsliinc's remotes and says nothing about anyone
else's.
