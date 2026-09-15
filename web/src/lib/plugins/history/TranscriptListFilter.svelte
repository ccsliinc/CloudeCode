<!--
  TranscriptListFilter - the compact scheme chooser and the three
  per-column fuzzy inputs.

  THE SCHEME CHOOSER IS A REAL `<select>` AND THAT WAS AN OWNER RULING.
  The vanilla file argued for a hand-built trigger-plus-menu on the
  grounds that the options carried an `aria-pressed` contract a
  `<select>` cannot grow. The owner overruled it on sight: "i dont like
  the dropdown its fake and doesnt match." He was right about the thing
  the argument never addressed - a div dressed as a select inherits none
  of the platform's control behaviour and none of the app's own form
  styling, so it reads as a foreign object in its own header no matter
  how correct its ARIA is. What replaces `aria-pressed` is the platform's
  own selected-option semantics plus `data-scheme-active` on the select,
  so a test can still assert the active choice without reading `value`.

  THE TWO FILTERS HAVE DIFFERENT SCOPES AND ARE NEVER DESCRIBED IN ONE
  SENTENCE. The scheme filter is SERVER-side: it re-queries the whole
  project, so its counts are scope counts. The fuzzy filter is
  CLIENT-side over the rows ALREADY FETCHED, and it cannot see a row on a
  page nobody has loaded. Merging the two notes would make one of them a
  lie in whichever direction the reader happened to guess.

  AN UNRECOGNISED SCHEME IS NAMED, not silently shown as the first
  option. A `<select>` cannot hold a value no `<option>` carries, so
  `value` goes blank and `data-scheme-active` is the only place that fact
  survives - which is why both are written, together.

  NOTHING HERE FETCHES, PAGES OR HOLDS ROWS. It emits changes through two
  callbacks and renders what it is told.

  Ported from client/js/archive-tlist-filter.js.
-->
<script lang="ts">
    import { CLASS, COLUMNS, SCHEME_DEFS } from './tlist-vocab';
    import { activeSchemeLabel } from './tlist-row';

    interface Props {
        /** The scheme filter in force. */
        scheme: string;
        /** The typed text per column key. */
        queries: Readonly<Record<string, string>>;
        /** The fuzzy filter's own honesty line, or '' to draw nothing. */
        note?: string;
        /**
         * Hide the scheme chooser. The unattributed route takes no scheme
         * filter, so the control is hidden for that scope rather than
         * shown and silently ignored - a control that does nothing is
         * worse than no control.
         */
        hideScheme?: boolean;
        /** The user picked a scheme. The parent reloads; this does not. */
        onScheme?: (value: string) => void;
        /** The user typed. Called with the full column map, every keystroke. */
        onQuery?: (queries: Readonly<Record<string, string>>) => void;
    }

    let {
        scheme,
        queries,
        note = '',
        hideScheme = false,
        onScheme,
        onQuery,
    }: Props = $props();

    const label = $derived(activeSchemeLabel(scheme, SCHEME_DEFS));

    /**
     * Emit the picked scheme. The parent owns the reload AND the repaint
     * of this control, so nothing is recorded locally: a control that
     * remembered its own choice could disagree with the list beside it.
     * Inputs: event - the change event off the select. Output: void.
     */
    function pickScheme(event: Event): void {
        const el = event.currentTarget as HTMLSelectElement | null;
        if (!el || typeof onScheme !== 'function') return;
        onScheme(el.value);
    }

    /**
     * Emit the full column map after one keystroke.
     * Inputs: key - the column typed in. event - the input event.
     * Output: void.
     */
    function type(key: string, event: Event): void {
        const el = event.currentTarget as HTMLInputElement | null;
        if (!el || typeof onQuery !== 'function') return;
        const next: Record<string, string> = {};
        for (const col of COLUMNS) {
            next[col.key] = queries[col.key] || '';
        }
        next[key] = el.value || '';
        onQuery(next);
    }
</script>

<div class={CLASS.filters}>
    {#if !hideScheme}
        <div class={CLASS.schemeBox}>
            <label class={CLASS.schemeLabel} for="{CLASS.root}-scheme"
                >Showing</label>
            <select
                class={CLASS.scheme}
                id="{CLASS.root}-scheme"
                aria-label="Session reference scheme filter"
                data-scheme-active={scheme}
                title="Showing: {label}. Changes which kind of transcript this list asks the server for."
                value={scheme}
                onchange={pickScheme}
            >
                {#each SCHEME_DEFS as def (def.v)}
                    <option
                        class={CLASS.schemeOption}
                        value={def.v}
                        data-scheme-filter={def.v}
                        title={def.hint}
                    >{def.label}</option>
                {/each}
            </select>
        </div>
    {/if}

    <div
        class={CLASS.fuzzy}
        role="group"
        aria-label="Filter the rows already loaded, by name, ref or date"
    >
        {#each COLUMNS as col (col.key)}
            <input
                class={CLASS.fuzzyInput}
                type="search"
                data-fuzzy-column={col.key}
                placeholder={col.placeholder}
                value={queries[col.key] || ''}
                title="Fuzzy filter on {col.label.toLowerCase()}. Matches characters in order, not as one block, and only across the rows already loaded into this list."
                aria-label="Filter loaded rows by {col.label.toLowerCase()}"
                oninput={(e) => type(col.key, e)}
            />
        {/each}
    </div>

    <p class={CLASS.fuzzyNote}>{note}</p>
</div>
