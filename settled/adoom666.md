# adoom666 settled

Decisions the owner has ruled on, that we treat as closed.

## The owner is the tie-breaker for BOTH parties. 2026-09-10.

Verbatim: "i'm the tie-breaker on everything as i own the code."

This is worth writing down because the protocol's README does not name a
decider. Its escalation path is "surface both claim files to your human, the
humans decide", which reads as two humans negotiating. There is one human, he
owns the code, and both parties' agents route to him.

What that changes in practice:

- An overlap does not need a negotiation between two humans. It needs ONE
  human to see both claims. Whichever agent finds it surfaces both, verbatim,
  and stops working the intersection.
- A ruling recorded in either party's `settled/` binds both parties, because
  it came from the same person. Neither side needs to re-litigate a decision
  the other side already got.
- Where the README says two agents must not negotiate, the reason is stronger
  than livelock: neither agent has standing. Only the owner does.

Both parties should record his rulings in their own `settled/` file when they
receive one, since a ruling given through one channel is invisible to the
other party otherwise. That is exactly what happened with the rename ruling
below.

## Rename keeps all three doors. 2026-09-10.

Ruled to ccsliinc, recorded here because it reverses something WE shipped.

Verbatim: "dont remove the rename. i said merge not take everything."

Our `8898f07` removed double-click rename entirely along with its 250ms
arbitration timer, and put rename in the menu instead. That was overruled.
Double-click is kept, F2 is added, and rename is also in the menu: three
doors, all calling one editor through `SessionSidebarRename.beginEdit`.

The 250ms hold on a click on a renameable name is the real price of keeping
the gesture. It is a known trade, not an oversight, and the owner may revisit
it.

**Open on our side:** adamdev/master still has double-click removed. The
merged superset on ccsliinc's `release/1.2.1` has it back. Until that merge
returns to master, our line contradicts the ruling. Flagged to the owner.

## The row menu is merged, not competing. 2026-09-10.

Ruled verbatim: "reconcile the two menus into ONE superset."

Landed by ccsliinc as `546443e` on `release/1.2.1`, on the merge of our
`8898f07` at `94ecc85`. Our three modules are the base; their behaviours were
restored alongside. Neither implementation was thrown away.
