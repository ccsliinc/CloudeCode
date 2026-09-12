/**
 * Shared sandbox loader for the legacy client/js LED renderer.
 *
 * StatusLed.test.ts used to hold this once, and two of its describe
 * blocks each compared the TypeScript port's output against the shipped
 * legacy modules: the drift guard (now StatusLed.drift-guard.test.ts) and
 * the byte-for-byte equivalence proof (now StatusLed.parity.test.ts).
 * Extracted here so both files share one loader instead of risking two
 * copies that drift apart from each other - the exact failure mode this
 * project keeps a rule against.
 *
 * Run with: npm test   (from web/)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/** Repo root, two levels up from web/src/lib. */
export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The shape the legacy files publish, as far as these tests use it. */
export interface LegacyApi {
    dotHtml(status?: unknown, signals?: unknown): string;
    ledStateFor(signals?: unknown): { inner: string; outer: string };
    ledHtml(opts?: unknown): string;
    /** The legacy module's OWN vocabularies, for the drift guard below. */
    INNER_STATES: string[];
    OUTER_STATES: string[];
}

/**
 * Load the two legacy client modules in one bare sandbox.
 *
 * Description: status-led.js publishes onto `globalThis` and
 *   session-status-ui.js onto `window`, so the sandbox supplies a bare
 *   `window` object and nothing else. There is deliberately no document:
 *   both modules claim to need none, and a reach for one throws here,
 *   which is the point.
 * Inputs: none.
 * Output: LegacyApi - the two entry points these tests compare against.
 * Example: legacy().dotHtml('idle', {unread: true})
 */
export function legacy(): LegacyApi {
    const context: Record<string, unknown> = { console, window: {} };
    vm.createContext(context);
    for (const file of ['status-led.js', 'session-status-ui.js']) {
        const src = fs.readFileSync(path.join(repoRoot, 'client', 'js', file), 'utf8');
        vm.runInContext(src, context);
    }
    const led = context['StatusLed'] as LegacyApi;
    const ui = (context['window'] as Record<string, unknown>)[
        'SessionStatusUI'
    ] as LegacyApi;
    return {
        dotHtml: (status, signals) => ui.dotHtml(status, signals),
        ledStateFor: (signals) => led.ledStateFor(signals),
        ledHtml: (opts) => led.ledHtml(opts),
        INNER_STATES: led.INNER_STATES,
        OUTER_STATES: led.OUTER_STATES,
    };
}
