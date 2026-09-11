/**
 * The launch picker's family grouping, and the settings screen's.
 *
 * PORTED FROM tests/test_provider_groups.node.mjs, deleted in the same
 * commit. Every case is here; what changed is the harness, not the
 * assertions.
 *
 * WHY THIS MOVED IN SLICE 6 WHEN NEITHER MODULE DID. `provider-groups.js`
 * and `agent-wrappers-view.js` are classic scripts and stay classic
 * scripts - `providers.js` is slice 7's and these are its rules. What
 * slice 6 changed is the thing that CALLS them: the provider gate now
 * fires from `create-flow.ts` and `entry-flows.ts`, so the rules about
 * which rows that gate offers belong in the suite that runs beside those
 * flows. A regression here breaks a create, and a create is what this
 * slice owns.
 *
 * THEY ARE LOADED IN A `vm` SANDBOX, exactly as the node test loaded
 * them, because they are IIFEs that publish onto `window` and there is no
 * bundler in `client/`. A rewrite into ES modules would be a change to
 * untouched legacy code in a slice that has no business touching it.
 *
 * THE PROPERTIES PINNED HERE are the ones the picker has regressed on
 * before: one row per wrapper with NO duplicates, the default badged
 * exactly once, a heading only where one is useful, and a model step
 * offered only where a model can actually be chosen.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/** Repo root, four levels up from web/src/lib/launchpad. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** One wrapper as the API ships it. */
interface Wrapper {
    id: string;
    family?: string;
    label?: string;
    default?: boolean;
    accepts_model?: boolean;
}

/** One family as the registry ships it. */
interface Family {
    name: string;
    label: string;
    pickable?: boolean;
    needs_model?: boolean;
}

/** One row the picker renders. */
interface PickerItem {
    type: string;
    wrapperId?: string | null;
    agentType?: string | null;
    label: string;
    groupLabel: string | null;
    acceptsModel: boolean;
    needsModel: boolean;
}

/** The two functions the picker's grouping publishes. */
interface GroupsModule {
    buildWrapperItems(wrappers: Wrapper[], families: Family[]): PickerItem[];
    wrapperFamily(wrapper: Partial<Wrapper>): string;
    familyNeedsModel(name: string, families: Family[]): boolean;
}

/** One group the settings screen renders. */
interface FamilyGroup {
    family: { name: string };
    wrappers: Wrapper[];
}

/** The one function the settings view publishes to this test. */
interface ViewModule {
    groupByFamily(wrappers: Wrapper[], families: unknown[]): FamilyGroup[];
}

/**
 * Evaluate one classic client script and hand back its `window` exports.
 *
 * Description: the sandbox carries `window`, a self-referential
 *   `globalThis` and whatever extra globals the module reaches for. It is
 *   the same loader the node suite used, typed.
 * Inputs: file (string) - a name under client/js. extra (object) -
 *   additional sandbox globals.
 * Output: Record<string, unknown> - the sandbox's `window`.
 * Example: loadClientScript('provider-groups.js').ProviderGroups
 */
function loadClientScript(
    file: string,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    const sandbox: Record<string, unknown> = { window: {}, console, ...extra };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(repoRoot, 'client', 'js', file), 'utf8'),
        sandbox,
        { filename: file },
    );
    return sandbox.window as Record<string, unknown>;
}

const Groups = loadClientScript('provider-groups.js').ProviderGroups as GroupsModule;

const View = loadClientScript('agent-wrappers-view.js', {
    document: {
        // `groupByFamily` never touches the DOM; the module's escapeHtml
        // does, and is not exercised here. A minimal stub keeps it
        // loadable.
        createElement: () => ({
            set textContent(v: string) {
                (this as unknown as { _v: string })._v = v;
            },
            get innerHTML(): string {
                return (this as unknown as { _v: string })._v;
            },
        }),
    },
}).AgentWrappersView as ViewModule;

const FAMILIES: Family[] = [
    { name: 'claude', label: 'claude' },
    { name: 'codex', label: 'codex' },
    { name: 'hermes', label: 'hermes' },
    { name: 'openclaw', label: 'openclaw' },
    { name: 'shell', label: 'shell' },
];

/** Build a wrapper object with test defaults. */
function w(id: string, family?: string, extra: Partial<Wrapper> = {}): Wrapper {
    return { id, family, label: id, default: false, accepts_model: false, ...extra };
}

/** The live config on the owner's box: two claude wrappers. */
const LIVE: Wrapper[] = [
    w('claude-skip-permissions', 'claude', { label: 'claude', default: true }),
    w('cld', 'claude', { label: 'cld (keychain-backed)' }),
];

const MULTI: Wrapper[] = [
    w('cld', 'claude', { default: true }),
    w('cldor', 'claude', { accepts_model: true }),
    w('my-codex', 'codex', { default: true }),
    w('fancy-shell', 'shell'),
];

describe('one row per wrapper, and the default badged once', () => {
    test('one row per wrapper, no duplicates', () => {
        const items = Groups.buildWrapperItems(LIVE, FAMILIES);
        expect(items).toHaveLength(2);
        const ids = items.map((i) => i.wrapperId);
        expect(ids).toEqual(['claude-skip-permissions', 'cld']);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('the default wrapper is badged, and only it', () => {
        const items = Groups.buildWrapperItems(LIVE, FAMILIES);
        const badged = items.filter((i) => i.label.includes('(default)'));
        expect(badged).toHaveLength(1);
        expect(badged[0]!.wrapperId).toBe('claude-skip-permissions');
        expect(badged[0]!.label).toBe('claude (default)');
    });

    test('a single-family install gets no group headings', () => {
        const items = Groups.buildWrapperItems(LIVE, FAMILIES);
        expect(items.every((i) => i.groupLabel === null)).toBe(true);
    });

    test('there is never a synthetic bare claude row alongside wrappers', () => {
        const items = Groups.buildWrapperItems(LIVE, FAMILIES);
        expect(items.every((i) => i.type === 'wrapper')).toBe(true);
    });
});

describe('multi-family installs group without duplicating', () => {
    test('still exactly one row per wrapper', () => {
        const items = Groups.buildWrapperItems(MULTI, FAMILIES);
        expect(items).toHaveLength(4);
        expect(new Set(items.map((i) => i.wrapperId)).size).toBe(4);
    });

    test('a heading rides on each group first row only', () => {
        const items = Groups.buildWrapperItems(MULTI, FAMILIES);
        const headed = items.filter((i) => i.groupLabel);
        expect(headed.map((i) => i.groupLabel)).toEqual(['claude', 'codex', 'shell']);
        expect(headed.map((i) => i.wrapperId)).toEqual(['cld', 'my-codex', 'fancy-shell']);
    });

    test('rows come out in registry family order', () => {
        const items = Groups.buildWrapperItems(MULTI, FAMILIES);
        expect(items.map((i) => i.wrapperId)).toEqual([
            'cld',
            'cldor',
            'my-codex',
            'fancy-shell',
        ]);
    });

    test('only accepts_model wrappers advertise the model step', () => {
        const items = Groups.buildWrapperItems(MULTI, FAMILIES);
        expect(items.filter((i) => i.acceptsModel).map((i) => i.wrapperId)).toEqual(['cldor']);
    });

    test('a family with no wrappers contributes no rows and no heading', () => {
        const items = Groups.buildWrapperItems(MULTI, FAMILIES);
        expect(items.every((i) => i.groupLabel !== 'hermes')).toBe(true);
        expect(items.every((i) => i.groupLabel !== 'openclaw')).toBe(true);
    });
});

describe('a malformed or old config is shown, never dropped', () => {
    test('a wrapper with no family field is treated as claude', () => {
        const items = Groups.buildWrapperItems([{ id: 'legacy', label: 'legacy' }], FAMILIES);
        expect(items).toHaveLength(1);
        expect(Groups.wrapperFamily({ id: 'legacy' })).toBe('claude');
    });

    test('a wrapper in an unknown family is still shown', () => {
        const items = Groups.buildWrapperItems([w('cld', 'claude'), w('x', 'martian')], FAMILIES);
        expect(items).toHaveLength(2);
        expect(items.some((i) => i.wrapperId === 'x')).toBe(true);
    });

    test('empty inputs produce no rows rather than throwing', () => {
        expect(Groups.buildWrapperItems([], FAMILIES)).toEqual([]);
        expect(Groups.buildWrapperItems([], [])).toEqual([]);
    });

    test('a missing families list still groups by the wrappers own families', () => {
        const items = Groups.buildWrapperItems(MULTI, []);
        expect(items).toHaveLength(4);
        expect(new Set(items.map((i) => i.wrapperId)).size).toBe(4);
    });
});

describe('the settings screen groups the same wrappers its own way', () => {
    const FAMILY_SUMMARIES = FAMILIES.map((f) => ({
        ...f,
        command: '',
        description: '',
        wrapper_count: 0,
        in_use: true,
        command_field: `${f.name}_command`,
    }));

    test('every family gets a group, even an empty one', () => {
        const groups = View.groupByFamily(LIVE, FAMILY_SUMMARIES);
        expect(groups.map((g) => g.family.name)).toEqual([
            'claude',
            'codex',
            'hermes',
            'openclaw',
            'shell',
        ]);
        expect(groups[0]!.wrappers).toHaveLength(2);
        expect(groups[1]!.wrappers).toHaveLength(0);
    });

    test('wrappers land in their declared family only', () => {
        const groups = View.groupByFamily(MULTI, FAMILY_SUMMARIES);
        const byName = Object.fromEntries(
            groups.map((g) => [g.family.name, g.wrappers.map((x) => x.id)]),
        );
        expect(byName.claude).toEqual(['cld', 'cldor']);
        expect(byName.codex).toEqual(['my-codex']);
        expect(byName.shell).toEqual(['fancy-shell']);
        expect(byName.hermes).toEqual([]);
    });

    test('an unknown family gets a trailing group, never dropped', () => {
        const groups = View.groupByFamily([w('x', 'martian')], FAMILY_SUMMARIES);
        const last = groups[groups.length - 1]!;
        expect(last.family.name).toBe('martian');
        expect(last.wrappers.map((g) => g.id)).toEqual(['x']);
    });

    test('a legacy wrapper with no family lands under claude', () => {
        const groups = View.groupByFamily([{ id: 'legacy', label: 'legacy' }], FAMILY_SUMMARIES);
        expect(groups[0]!.wrappers.map((g) => g.id)).toEqual(['legacy']);
    });
});

describe('a pickable family with no wrappers gets a pinned row', () => {
    const PICKABLE: Family[] = [
        { name: 'claude', label: 'claude', pickable: true },
        { name: 'codex', label: 'codex', pickable: true },
        { name: 'hermes', label: 'hermes', pickable: true },
        { name: 'openclaw', label: 'openclaw', pickable: true },
        { name: 'shell', label: 'shell', pickable: false },
    ];

    test('exactly one pinned row, of type family', () => {
        const codex = Groups.buildWrapperItems(LIVE, PICKABLE).filter(
            (i) => i.agentType === 'codex',
        );
        expect(codex).toHaveLength(1);
        expect(codex[0]!.type).toBe('family');
        expect(codex[0]!.label).toBe('codex');
    });

    test('a pinned family row never advertises the model step', () => {
        const items = Groups.buildWrapperItems(LIVE, PICKABLE);
        for (const item of items.filter((i) => i.type === 'family')) {
            expect(item.acceptsModel).toBe(false);
        }
    });

    test('shell is never offered - it has its own new-console entry point', () => {
        const items = Groups.buildWrapperItems(LIVE, PICKABLE);
        expect(items.every((i) => i.agentType !== 'shell')).toBe(true);
        expect(items.every((i) => i.groupLabel !== 'shell')).toBe(true);
    });

    test('pinned rows follow registry order, so codex sits under claude', () => {
        const names = Groups.buildWrapperItems(LIVE, PICKABLE).map(
            (i) => i.agentType || 'claude-wrapper',
        );
        expect(names.indexOf('codex')).toBe(2);
        expect(names.indexOf('codex')).toBeLessThan(names.indexOf('hermes'));
        expect(names.indexOf('hermes')).toBeLessThan(names.indexOf('openclaw'));
    });

    test('a family WITH wrappers gets its wrappers, never a pinned row too', () => {
        // Offering both would launch the same family two different ways
        // from two adjacent rows.
        const items = Groups.buildWrapperItems(MULTI, PICKABLE);
        expect(items.filter((i) => i.type === 'family' && i.agentType === 'codex')).toHaveLength(
            0,
        );
    });

    test('every pinned row carries its own heading when groups are multiple', () => {
        const codex = Groups.buildWrapperItems(LIVE, PICKABLE).filter(
            (i) => i.agentType === 'codex',
        )[0]!;
        expect(codex.groupLabel).toBe('codex');
    });

    test('an older server that omits pickable changes nothing', () => {
        // THE COMPATIBILITY GUARANTEE, asserted rather than assumed.
        const before = Groups.buildWrapperItems(LIVE, FAMILIES);
        expect(before.every((i) => i.type === 'wrapper')).toBe(true);
        expect(before).toHaveLength(2);
    });
});

describe('a needs_model family routes to a catalog instead of launching', () => {
    const WITH_LOCAL: Family[] = [
        { name: 'claude', label: 'claude', pickable: true },
        { name: 'codex', label: 'codex', pickable: true },
        { name: 'local', label: 'local (lm studio)', pickable: true, needs_model: true },
        { name: 'shell', label: 'shell', pickable: false },
    ];

    /** The live config on the mini: `local` HAS a wrapper. */
    const WITH_CLDL: Wrapper[] = LIVE.concat([
        w('cldor', 'claude', { label: 'cldor (openrouter)', accepts_model: true }),
        w('cldl', 'local', { label: 'cldl (lm studio)', accepts_model: true }),
    ]);

    test('a needs_model family advertises the model step', () => {
        // It CANNOT launch bare - the server refuses rather than
        // downgrading - so the row must go to the model step rather than
        // offer a launch that is going to fail.
        const local = Groups.buildWrapperItems(LIVE, WITH_LOCAL).filter(
            (i) => i.agentType === 'local',
        )[0]!;
        expect(local).toBeTruthy();
        expect(local.needsModel).toBe(true);
        expect(local.acceptsModel).toBe(true);
    });

    test('a modelless pinned family still launches on Enter', () => {
        const codex = Groups.buildWrapperItems(LIVE, WITH_LOCAL).filter(
            (i) => i.agentType === 'codex',
        )[0]!;
        expect(codex.needsModel).toBe(false);
        expect(codex.acceptsModel).toBe(false);
    });

    test('familyNeedsModel reads false when the server omits the field', () => {
        expect(Groups.familyNeedsModel('local', FAMILIES)).toBe(false);
        expect(Groups.familyNeedsModel('local', WITH_LOCAL)).toBe(true);
    });

    test('local is not offered when the server says it is not pickable', () => {
        const notPickable = WITH_LOCAL.map((f) =>
            f.name === 'local' ? { ...f, pickable: false } : f,
        );
        const items = Groups.buildWrapperItems(LIVE, notPickable);
        expect(items.every((i) => i.agentType !== 'local')).toBe(true);
    });

    test('a wrapper inherits its family needs_model', () => {
        const cldl = Groups.buildWrapperItems(WITH_CLDL, WITH_LOCAL).filter(
            (i) => i.wrapperId === 'cldl',
        )[0]!;
        expect(cldl, 'cldl must be offered').toBeTruthy();
        expect(cldl.needsModel, 'cldl must route to the LOCAL catalog').toBe(true);
        expect(cldl.acceptsModel).toBe(true);
    });

    test('NEGATIVE CONTROL: an OpenRouter wrapper is NOT needs_model', () => {
        // The discriminating half. `accepts_model` is true for BOTH
        // cldor and cldl, so a test that only pinned cldl would pass just
        // as happily against code that marked every wrapper needsModel.
        const cldor = Groups.buildWrapperItems(WITH_CLDL, WITH_LOCAL).filter(
            (i) => i.wrapperId === 'cldor',
        )[0]!;
        expect(cldor).toBeTruthy();
        expect(cldor.acceptsModel).toBe(true);
        expect(cldor.needsModel, 'cldor must keep the OpenRouter catalog').toBe(false);
    });

    test('a family with a wrapper contributes no pinned row', () => {
        const items = Groups.buildWrapperItems(WITH_CLDL, WITH_LOCAL);
        expect(items.every((i) => i.agentType !== 'local')).toBe(true);
        expect(items.filter((i) => i.wrapperId === 'cldl')).toHaveLength(1);
    });
});
