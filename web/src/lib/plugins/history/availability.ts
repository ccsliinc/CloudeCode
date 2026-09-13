/**
 * Is the message archive switched on for this server? PORTED from the
 * probe half of `client/js/archive-entry.js`, deleted in the same commit.
 *
 * THE ARCHIVE IS OFF BY DEFAULT, AND THIS IS WHERE THE CLIENT FINDS THAT
 * OUT. `ensure()` measures it once per page load against
 * `GET /api/v1/features`, which the server mounts whether the feature is
 * on or off precisely so that "off" and "on but broken" are different
 * answers rather than the same silence. Every entry point renders HIDDEN
 * and reveals itself only on `enabled`. `unknown` - a failed probe, a
 * client that never loaded, a server that answered something this build
 * does not understand - leaves them hidden: a door drawn on a guess
 * leads onto a wall of 404s, and the two failure directions are not
 * symmetric.
 *
 * WHY THIS IS NOT `Contribution.enabled(context)`, WHICH IS A DEVIATION
 * FROM THE SCOPE AND IS THE MOST IMPORTANT THING IN THIS FILE. Section 3
 * of `docs/history-archive-scope.md` says the archive "reads
 * `message_archive` there, which is where its hand-rolled `/features`
 * probe goes to die." It cannot, for two reasons that compound.
 *
 * FIRST, `PluginContext.flags` DEFAULTS THE WRONG WAY. Its documented
 * rule, carried unchanged from `client/js/ui-flags.js`, is that the
 * ABSENCE of a key means ON - so that a probe that could not run, an
 * older server or an unparseable config all leave a control exactly
 * where the user last saw it. That is right for a show/hide preference
 * and it is exactly backwards here: for the archive, "I could not tell"
 * must mean HIDDEN, because the control leads to routes that 404 when
 * the feature is off. Two opposite defaults over one field is not
 * something a shared context can express.
 *
 * SECOND, `enabled` IS SYNCHRONOUS AND THIS IS A MEASUREMENT. The gate
 * has THREE states and one of them is "nobody has looked yet". A
 * synchronous boolean has to answer during that window, and either
 * answer it could give is a lie.
 *
 * So `Contribution.enabled` stays what it is - a synchronous "does this
 * contribution apply" - and the availability gate stays its own
 * three-state probe, now reached through the screen's GRANTED client
 * rather than through `window.API`. Collapsing a measurement into a flag
 * whose default is the wrong way round would have been a silent
 * regression wearing the shape of a simplification.
 */
import type { EnvelopeResult, ScreenApi } from '../types';

/**
 * The three states this module reports. `unknown` is not a flavour of
 * `disabled`: a user who turned the archive ON and hit a broken config
 * must not see what a user who left it off sees, and an entry point that
 * appears on a guess is exactly the leak the server-side switch exists
 * to prevent.
 */
export const STATE_ENABLED = 'enabled';
export const STATE_DISABLED = 'disabled';
export const STATE_UNKNOWN = 'unknown';

/** Which of the three the last measurement was. */
export type ArchiveState = 'enabled' | 'disabled' | 'unknown';

/** Where the switch is published. Always mounted, on or off. */
export const FEATURES_PATH = '/features';

/** What an availability gate offers. */
export interface Availability {
    /** Measure once per page load. N callers make 1 request. */
    ensure(): Promise<ArchiveState>;
    /** The last measured state. Starts UNKNOWN, never ENABLED. */
    state(): ArchiveState;
    /** The server's sentence explaining it. */
    reason(): string;
    /** Run `fn` once the state resolves, immediately if it already has. */
    onResolved(fn: (state: ArchiveState) => void): void;
}

/**
 * Build the availability gate for one granted client.
 *
 * Description: a factory rather than a module singleton so a test gets
 *   isolation without a `reset()` that would exist for nobody else, and
 *   so the client it probes with is the one the host granted rather than
 *   whatever is on `window` at the time.
 * Inputs: api - the screen's granted client. It must hold `/features`.
 * Output: Availability.
 * Example: const gate = createAvailability(api);
 *          if (await gate.ensure() === 'enabled') showTheDoor();
 */
export function createAvailability(api: ScreenApi): Availability {
    /** Last measured state. Starts UNKNOWN, never ENABLED. */
    let current: ArchiveState = STATE_UNKNOWN;
    /** One sentence from the server naming why. */
    let why = 'the message archive switch has not been read yet.';
    /** Single-flight probe, so N callers make 1 request. */
    let probe: Promise<ArchiveState> | null = null;
    /** Callbacks fired once per resolution. */
    let listeners: ((state: ArchiveState) => void)[] = [];

    /** Publish a resolution to every subscriber exactly once. */
    function settle(next: ArchiveState, reason: string): void {
        current = next;
        why = reason;
        const pending = listeners;
        listeners = [];
        for (const fn of pending) {
            try {
                fn(next);
            } catch {
                // One bad subscriber must not stop the others from
                // learning the answer.
            }
        }
    }

    function ensure(): Promise<ArchiveState> {
        if (probe) return probe;
        if (!api || typeof api.call !== 'function') {
            settle(STATE_UNKNOWN,
                   'the API client is not available, so the message archive '
                   + 'switch could not be read.');
            probe = Promise.resolve(current);
            return probe;
        }
        probe = api.call(FEATURES_PATH).then((data) => {
            // THE TRANSPORT IS ENVELOPE-SHAPED SINCE SLICE 2, so what
            // arrives here is a result carrying the body rather than the
            // body itself, and a failure to REACH the server now
            // RESOLVES instead of rejecting. That rung moved from the
            // `.catch()` below to here; the verdict it produces is the
            // same UNKNOWN it always was, but the sentence names the
            // real cause rather than "the server did not report a
            // state", which is what a fall-through would have said.
            const result = data as EnvelopeResult | null;
            if (result && result.transportError) {
                settle(STATE_UNKNOWN,
                       'the message archive switch could not be read: '
                       + result.transportError);
                return current;
            }
            const body = (result ? result.envelope : null) as {
                message_archive?: { state?: unknown; reason?: unknown } } | null;
            const block = (body && body.message_archive) || null;
            if (!block || typeof block.state !== 'string') {
                settle(STATE_UNKNOWN,
                       'the server did not report a message archive state.');
                return current;
            }
            const reason = typeof block.reason === 'string' ? block.reason : '';
            if (block.state === STATE_ENABLED) settle(STATE_ENABLED, reason);
            else if (block.state === STATE_DISABLED) settle(STATE_DISABLED, reason);
            else {
                // cannot_determine, or a value this client does not
                // know. Both are "nobody measured it", which is UNKNOWN
                // here.
                settle(STATE_UNKNOWN, reason);
            }
            return current;
        }).catch((err: unknown) => {
            // STILL REACHED, AND THE GRANT IS WHAT REACHES IT. The
            // transport resolves every transport outcome itself, so the
            // one rejection left on this path is `GrantRefusedError` -
            // a screen that declared no `/features` grant. That is a
            // refusal to answer, which is UNKNOWN, not DISABLED.
            const message = err && typeof err === 'object' && 'message' in err
                ? String((err as { message: unknown }).message) : String(err);
            settle(STATE_UNKNOWN,
                   'the message archive switch could not be read: ' + message);
            return current;
        });
        return probe;
    }

    function onResolved(fn: (state: ArchiveState) => void): void {
        if (typeof fn !== 'function') return;
        if (current !== STATE_UNKNOWN) { fn(current); return; }
        listeners.push(fn);
    }

    return { ensure, state: () => current, reason: () => why, onResolved };
}
