/**
 * THE SNIPPET STATES, AS THE SERVER SPELLS THEM, AND THE ONE THAT MAY
 * BE RENDERED.
 *
 * THIS FILE EXISTS BECAUSE THE VANILLA CLIENT USED A DENY-LIST AND THE
 * SERVER HAS OUTGROWN IT. `client/js/archive-search-render.js` carries
 *
 *     WITHHELD_STATES = ['withheld_secret_bearing',
 *                        'withheld_known_secret_value']
 *
 * and renders the snippet whenever `snippet_state` is not one of those
 * two. `src/core/archive_snippet_gate.py` declares SIX states, measured
 * on the branch this port is based on:
 *
 *     included                      the gate ran and passed the window
 *     withheld_secret_bearing       the BODY carries findings      (listed)
 *     withheld_window_detector      the WINDOW itself scanned dirty (NOT listed)
 *     withheld_known_secret_value   a known credential hash hit    (listed)
 *     withheld_gate_unavailable     the gate COULD NOT RUN         (NOT listed)
 *     withheld_by_request           the caller asked for none      (NOT listed)
 *
 * Three of the five withholding states are invisible to that deny-list.
 * `withheld_gate_unavailable` is the worst of them: it is the server
 * saying "I could not evaluate whether this is safe", and a deny-list
 * renders it as safe. That is this project's false green, in the one
 * place where the thing being asserted is a credential.
 *
 * SO THE RULE IS INVERTED HERE AND IT IS AN ALLOW-LIST. Exactly one
 * state, `included`, permits text. Every other value - the four the
 * vanilla missed, the one it caught, a state invented by a server newer
 * than this client, a null, a number, a missing field - withholds. A
 * seventh state added upstream next year is withheld by THIS file
 * without anybody editing THIS file, which is the whole property an
 * allow-list buys and the reason it is worth the inversion.
 *
 * THE COST OF THE INVERSION IS NAMED RATHER THAN HIDDEN: a state that
 * genuinely means "fine to show" and is not spelled `included` renders
 * as withheld until somebody adds it below. That is a preview a person
 * does not get. The other direction is a credential on screen. The trade
 * is not close.
 *
 * NOTHING HERE READS OR HOLDS A SECRET VALUE. Pure data. No DOM, no
 * fetch, no imports.
 */

/** The ONE `snippet_state` under which preview text may be rendered. */
export const SNIPPET_INCLUDED = 'included';

/**
 * Every withholding state this client can NAME, for the wording only.
 *
 * Description: membership here is NOT what withholds - `snippetEgress`
 *   withholds on anything that is not `SNIPPET_INCLUDED`, so this table
 *   can never be the thing that lets a state through. It exists so the
 *   note beside a withheld preview can say WHICH layer tripped instead
 *   of "withheld, reason unknown", which is a blank cell wearing a
 *   label. A state absent from here is still withheld; it is just
 *   described in general terms.
 *
 *   Spellings are byte-identical to `src/core/archive_snippet_gate.py`.
 */
export const WITHHELD_REASONS: Readonly<Record<string, string>> = {
    withheld_secret_bearing:
        'the body this match sits in carries detected secret findings',
    withheld_window_detector:
        'the preview window itself scanned as carrying credential material',
    withheld_known_secret_value:
        'the preview window carries a value this corpus has detected as a '
        + 'credential somewhere, even though this body carries no finding of '
        + 'its own',
    withheld_gate_unavailable:
        'the gate could not be built, so whether this preview is safe was '
        + 'NOT EVALUATED. That is not the same as safe',
    withheld_by_request:
        'previews were not requested for this search',
};

/**
 * What a withheld preview says when the state is one this client has
 * never seen.
 *
 * Description: NORMATIVE. It names the state verbatim so an operator can
 *   grep the server for it, and it refuses in the same breath. A client
 *   older than its server must not narrate its own ignorance as safety.
 */
export const UNRECOGNISED_STATE_REASON =
    'the server reported a snippet state this client does not recognise, so '
    + 'whether this preview is safe is NOT KNOWN';

/** What a withheld preview says when the server named no state at all. */
export const ABSENT_STATE_REASON =
    'the server reported no snippet state for this match, so whether this '
    + 'preview is safe is NOT KNOWN';

/**
 * Why a preview is withheld even though the gate PASSED the window.
 *
 * Description: this is the second, independent rung and it is the one
 *   the measurement demands. The server's gate cuts its window around
 *   where the QUERY matched, not around where a finding sits, and then
 *   runs a 60-character `scan_text` over it. That detector is
 *   CONTEXTUAL: `high_entropy_assignment` needs a name saying
 *   token/secret/key immediately before the value, and a window cut at a
 *   query match routinely severs the name from the value. Measured over
 *   12,522 real findings in the live archive, 1,211 of them - 9.7
 *   percent - leave SIXTEEN OR MORE CHARACTERS of a real credential
 *   inside such a window without the fallback scan flagging it.
 *
 *   So `included` is the gate's verdict about the WINDOW, and a positive
 *   `secret_finding_count` is a fact about the BODY. They are different
 *   measurements and the client holds both. When the body is known to
 *   carry a credential, this client does not render a window of it, and
 *   the person is routed to the reader where slice 7's `applyMask` masks
 *   by OFFSET rather than by detector.
 */
export const DECLARED_FINDINGS_REASON =
    'this match sits in a body that declares secret findings. The preview '
    + 'window is cut around the query, not around a finding, so it can carry '
    + 'part of a credential the window scan cannot see. Open the line to read '
    + 'it with offset masking applied';

/**
 * A preview that was simply not supplied, which is NOT a withholding.
 *
 * Description: kept apart from the withheld wording because they are
 *   different findings and this project does not fold a third outcome
 *   into one of the other two. "The server sent no text" and "the server
 *   declined to send text" lead a reader to different next actions.
 */
export const NO_PREVIEW_TEXT = 'no preview text supplied';
