# design decisions ccsliinc treats as settled

newest first. these are already ruled on. if your work would reverse
one of them, that is an overlap: stop and surface it to your human.

## 2026-09-10 push targets, ruled 2026-09-08

Push only to `origin` (ccsliinc/CloudeCode) and `adamdev` (Adoom666/CloudeCodeDev).

**NEVER push to `upstream` (Adoom666/CloudeCode).** Its push URL is set to the
sentinel `DISABLED_do_not_push_to_Adoom666_CloudeCode` so a push there fails by
construction. Do not repair it. Re-apply it on any fresh clone.

## 2026-09-10 the status LED model, ruled 2026-09-09

Owner's ruling, and it has already been reverted once by accident (`ba2aa5d`),
so it is written down here:

- **The OUTER ring means activity and nothing else.** `working` breathes, a
  live-but-stopped turn (question / notice / startup gate) is lit and still,
  every resting or dead state leaves it off.
- **Unread rides the INNER dot**, green against grey. The outer `unread` state
  and its `--led-color-unread` hue were retired. Owner, verbatim: "the ring
  around some of the leds are not gray, which means there should be background
  tasks. i dont think those few have any background tasks."
- **`question` and `notice` are two states, not one.** A permission prompt
  stops the agent; a notification does not. They are two independent booleans
  because hooks arrive unordered and duplicated.
- **A dead pane drops off the live list and belongs in Recent.** Owner,
  verbatim: "they go into recent, they can disappear." A round that made a husk
  keep its row painted dead was overruled and reverted.

If your design moves unread back onto the ring, or keeps dead rows on the live
list with a restart surface, that is a design overlap with a settled decision.
Stop and surface it rather than implementing it.

