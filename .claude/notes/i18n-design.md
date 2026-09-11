# The string layer

**One catalog, read by both clients, so a label cannot exist in two languages in one app.**
Owner's direction, verbatim: "making classsed code and probably should have
language vars if we can get this to be bigger and people want to use this". This
is the architecture that makes translations possible, not the translations.
Issue #61, PR #62.

## Why this had to land before slice 2

**Every screen slices 2 to 7 port is a screen that gets rewritten twice
otherwise.** `.claude/notes/svelte-migration-launchpad.md` moves
`client/js/launchpad.js` into Svelte in seven slices and slice 1 has shipped.
Each remaining slice rewrites a screen. If they port screens as they are and
translation is retrofitted after, every one of those files is touched again to
pull its strings out, and the second pass is the expensive one because by then
the file is new and nobody remembers which literals were user-visible.

It also closes a duplication the repo already pays for:
`client/js/session-status-ui.js` and `web/src/lib/status-dot.ts` hold the same
status vocabulary as two literal tables, guarded by `StatusLed.parity.test.ts`.

## 1. Format and location

**A plain ES module `.js` file under `client/js/i18n/`, because all four
consumers can read one without a build step.** The catalog is
`client/js/i18n/catalog.en.js`, `export default` over a flat object.

`client/` has no bundler, so a file there must be valid in the browser exactly
as written. That rules out TypeScript. It is an ES module rather than a classic
IIFE because Vite has to `import` it statically, which is what keeps the Svelte
bundle free of any runtime fetch. The four readers:

| reader | how |
|---|---|
| Svelte bundle | `import` at build time, bundled into `client/dist/app.js` |
| legacy browser client | `client/js/i18n/boot.js`, one same-origin `<script type="module">` |
| vitest (`web/src/**/*.test.ts`) | `import` |
| node suite (`tests/*.node.mjs`) | `import`, then injected into the `vm` sandbox |

That last row is what made this shape work: the node tests are real ESM, so they
import the catalog and hand it to the sandbox the way they already hand it
`console`.

**Not JSON**, the obvious alternative: it carries no comments, and translator
context ("is this a verb or an adjective") is exactly what a comment holds.

**A second locale is one new file and two lines.** Copy `catalog.en.js`,
translate the values, leave the keys, then import it in
`client/js/i18n/catalogs.js` and add one registry entry. Every locale is
bundled rather than fetched: `default-src 'self'` means there is nowhere to
lazy-load from, and the whole en catalog is 25 strings.

**A missing key renders the key itself, loudly, and never throws.** Not an
empty string, which is invisible and loses a label for a whole release. Not
`???`, which is visible and unattributable. The key names itself, so a
screenshot of the bug is the fix. It is reported through `console.error` on
every path including production, because a missing key is a bug that shipped,
and it is deduped so a key missing on a two-hundred-row list logs once. The
same rule covers a missing runtime: a legacy caller with no
`globalThis.CloudeI18n` gets keys back and never a second copy of the strings.

## 2. Key scheme

**Flat, dotted, and named after the domain, never the screen.**
`session.summary.none`, not `sidebar.groupheader.emptylabel`.

A key that names where a string appears dies when that screen is rewritten,
which is precisely what slices 2 to 7 are going to do. A key that names what
the string means survives the move, and surviving the move is the entire point.

Flat rather than nested because `grep -rn "session.summary.none"` then finds
every use across both trees with no mental reassembly, and because a nested
catalog invites `t('session.status.' + key)`, which makes an extraction guard
impossible to write.

Shape is `<domain>.<thing>[.<variant>]`. Domains are concepts the server also
knows about (`session`, `project`, `toast`), not files.

## 3. Interpolation and plurals

**No library, because the browser already has the correct implementation and
CSP forbids the alternatives.** Every ICU MessageFormat runtime worth using
compiles a message into a function, and `script-src 'self'` refuses
`new Function` and `eval`. The ones that would work at all ship a parser for a
feature set this uses a fraction of. Against a dependency policy that says
prefer the standard library, `Intl.PluralRules` and `Intl.NumberFormat` are not
a close call. Both are memoized per locale, because constructing them is the
expensive part and these run per row per paint.

Interpolation is `{name}` and one replace pass. No expressions inside braces: a
mini-language in a message is the road back to a runtime compiler. A parameter
whose value is a number goes through `Intl.NumberFormat`, so 1234 renders
`1,234` in en and `1.234` in de without any call site knowing that difference
exists. A hole with no value is left verbatim and reported, so `{count}` on
screen names the parameter that went missing.

A plural message is an object keyed by CLDR plural category, selected by
`Intl.PluralRules` on the parameter named `count`, with `other` mandatory.
English ships `one` and `other`; Arabic needs all six; Japanese needs only
`other`. That is CLDR's own shape, so no locale can need a form this cannot
express, and a category the catalog lacks falls back to `other` so a partly
translated locale degrades to a real sentence.

**The zero case is chosen by the caller, not by the plural rule, and this is
what people get wrong.** `Intl.PluralRules('en').select(0)` is `other`, not
`zero`, so a plural set alone renders "0 sessions", which is grammatical and is
still the wrong copy. "no sessions" is a different message and picking it is a
product decision, so it lives in a branch a reader can see.

## 4. How both trees read one source

**The copy has one source and the assembly has one implementation; neither is
duplicated.**

`client/js/i18n/boot.js` is a same-origin module script in `client/index.html`,
above the bundle's tag. Module scripts are deferred and run in document order,
so it publishes `window.CloudeI18n` before `app.js` evaluates and before
`DOMContentLoaded`, which is before any legacy render. The classic scripts above
it run first, which is why every legacy consumer reaches for `t()` at render
time and never while it is being defined.

It is separate from the Svelte bundle on purpose: copy must not depend on the
newest thing, and nothing about the legacy tree's strings changes on the day
slice 7 deletes `launchpad.js`.

The Svelte tree ADOPTS that instance rather than building one. Two instances
would be two current locales, and moving one would leave the other painting the
old language.

**Reactivity is one `$state` counter.** `web/src/lib/i18n/index.svelte.ts` holds
a module-scope rune, bumps it from a single subscription, and `t()` reads it
before delegating. Any component template calling `t()` is therefore a
subscriber automatically, with no store, no context and no per-component wiring
to forget. Mirroring the catalog into runes would be a second copy of state for
nothing.

Shared assembly lives in `client/js/labels/`. `session-summary.js` is the worked
example: the Svelte tree imports it directly, the legacy tree reaches it through
`globalThis.CloudeLabels`. One function, one catalog, two callers. A catalog
alone would still let two assemblers drift on which keys they combine and in
what order, which renders as two different sentences for one state.

## 5. Locale selection

**Browser-local, through a named ladder, and that is a decision rather than an
oversight.** Ladder, in order: an explicit override in
`localStorage['cloude.locale']`, then `navigator.languages` prefix-matched so
`en-GB` finds `en`, then `en`.

Not a server setting yet, for two reasons. Locale must resolve synchronously at
first paint, and a setting arriving on an async config fetch paints the wrong
language and then flips, which is the most recognisable i18n bug there is. And
issue #43 is redesigning the `ui_preferences` block right now, so building on it
today is a design collision rather than a merge one.

**The ladder is the seam.** Making locale a server preference later is one rung
inserted at the top plus a `setLocale()` when the config lands, and the repaint
that needs already works and is tested.

## 6. RTL and long strings

**Not solved, and the exposure is measured rather than guessed.**
`client/css/` holds 235 physical-direction declarations
(`margin-left`, `right:`, and so on) across 49 files and 16,924 lines, and zero
logical equivalents (`margin-inline-start`, `inset-inline`). So RTL is a CSS
project of its own, not a string project, and nothing in this design blocks it
or makes it harder.

Long strings are the nearer risk and the pseudo-locale already tests for them:
German runs about a third longer than English, so the pseudo transform pads by
40 percent. The fixed-width surfaces are where it will show first: the sidebar
row, the status pill and the terminal header.

## 7. Server strings: out of scope, and what it would cost

**Deliberately excluded this round, for reasons that are about data and not
about effort.**

The server persists some of its user-visible prose. Toast bodies are stored, so
a toast raised in English and read after a locale switch would still be English.
Translating at write time is wrong; translating at read time means storing a key
plus parameters instead of a sentence, which is a schema change and a migration.
Nothing in the API carries a locale today either, and the server's user-visible
text is not separable from its log text by inspection.

What a later round needs:

- a message id plus parameters on the stored toast record, keeping the rendered
  body as a fallback column for rows written before the change
- `Accept-Language` on the API client, and a locale threaded to the refusal
  builders in `src/core/session_respawn.py` and its neighbours
- a Python catalog sharing this key namespace

**The cheap thing done now to make that possible: the catalog is data, not
code.** No functions in values, no template literals, no TypeScript. It converts
to a Python dict by inspection, and the key scheme carries no JS in it.

## 8. How to port a screen into this

For the author of slices 2 to 7. Five steps, and the last one is the one that
keeps the guard honest.

1. **Find the user-visible literals.** Every `+ 'text'`, every template literal
   in a label, every `n === 1 ? 'a' : 'b'` ternary. That ternary is always a
   plural and is only correct for two-form languages.
2. **Add keys to `client/js/i18n/catalog.en.js`**, named for what the string
   means. Put punctuation and separators INSIDE the message, never in a `+` in
   the caller, because word order and punctuation are exactly what a translation
   changes. A count gets a plural set; an explicit zero gets its own key.
3. **Put the assembly in `client/js/labels/<screen>.js`** as a pure ES module
   taking `(data, t)`. Import it from the Svelte side; publish it on
   `globalThis.CloudeLabels` in `client/js/i18n/boot.js` for the legacy side.
   Do not write the sentence twice.
4. **Call it.** Svelte components use `t` from `web/src/lib/i18n/index.svelte`,
   which repaints on a locale change. Legacy classic scripts use
   `globalThis.CloudeI18n.t` at render time, never at module-definition time.
   A legacy module loaded in a `vm` sandbox by a node test needs `CloudeI18n`
   and `CloudeLabels` injected into its context, the way
   `tests/test_status_summary.node.mjs` does.
5. **Add the file to `PORTED_FILES` in
   `web/src/lib/i18n/coverage.test.ts`.** This is the step that makes the guard
   grow with the migration. A file not on that list is simply not covered.

## 9. The guards, and how they were proven

**Two guards, because neither covers the other's gap, and that was measured
rather than assumed.**

- **Behavioural.** Render the surface in the pseudo-locale and require every
  sentence to be a balanced bracketed span, plus an exact count of how many
  catalog messages went into it. The pseudo catalog is DERIVED from `en` at
  runtime, so it cannot go stale.
- **Source.** Read the ported files and refuse any string literal that looks
  like a sentence. Comments and `console.*` arguments are stripped first,
  because developer diagnostics are not user copy.

Mutation results, run on 2026-09-10:

| mutation | balanced-span | bracket count | source guard |
|---|---|---|---|
| a literal returned at the top level | FAIL | FAIL | FAIL |
| a literal interpolated INTO another message | pass | FAIL | FAIL |

The second row is the point. A hardcoded fragment passed as a parameter is
wrapped by the outer message, so the span check cannot see it. That is why the
count assertion and the source scan both exist.
