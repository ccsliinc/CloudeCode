/**
 * ProviderGroups — pure grouping helpers for the launch picker's wrapper
 * step (feat/universal-wrappers).
 *
 * Split out of client/js/providers.js to keep that file inside the repo's
 * 500-line budget, and because these are the rules most worth testing
 * without a DOM: exactly one row per wrapper, no duplicates, the default
 * badged, and a family heading only where one is actually useful.
 *
 * Loaded as a plain script (window.ProviderGroups) and also importable by
 * the node test suite, which reads the file and evaluates it against a
 * stub window — the same pattern the other node suites in tests/ use.
 */
(function (root) {
    'use strict';

    /**
     * The family a wrapper belongs to, tolerating a wrapper stored before
     * the field existed (an unmigrated or hand-edited config.json).
     * @param {object} w wrapper object from the API
     * @returns {string} family name, defaulting to 'claude'
     */
    function wrapperFamily(w) {
        return (w && w.family) || 'claude';
    }

    /**
     * Family names in registry order, with any family present in the
     * wrapper data but absent from the registry appended rather than
     * dropped — a wrapper must never become unreachable because the
     * server did not name its family.
     * @param {Array} wrappers configured wrappers
     * @param {Array} families family summaries from the API
     * @returns {string[]} ordered family names
     */
    function familyOrder(wrappers, families) {
        var names = (families || []).map(function (f) { return f.name; });
        (wrappers || []).forEach(function (w) {
            var name = wrapperFamily(w);
            if (names.indexOf(name) === -1) names.push(name);
        });
        return names;
    }

    /**
     * Display label for a family name.
     * @param {string} name family name
     * @param {Array} families family summaries from the API
     * @returns {string} the registry's label, or the name itself
     */
    function familyLabel(name, families) {
        var match = (families || []).filter(function (f) { return f.name === name; })[0];
        return (match && match.label) || name;
    }

    /**
     * Build the picker's wrapper-step nav items, grouped by family.
     *
     * EXACTLY one item per wrapper, in family order. The family heading is
     * carried ON the first item of each group (`groupLabel`) rather than
     * being an item of its own, so the list stays a pure sequence of
     * selectable things and every index/arrow/type-ahead path in
     * providers.js is unchanged. A single-family install (every install
     * today) gets no headings at all, since one heading over the whole
     * list is noise.
     * @param {Array} wrappers configured wrappers, all families
     * @param {Array} families family summaries from the API
     * @returns {Array} nav items of type 'wrapper'
     */
    function buildWrapperItems(wrappers, families) {
        var order = familyOrder(wrappers, families);
        var groupsPresent = order.filter(function (name) {
            return (wrappers || []).some(function (w) { return wrapperFamily(w) === name; });
        });
        var multi = groupsPresent.length > 1;
        var items = [];
        groupsPresent.forEach(function (name) {
            var inFamily = (wrappers || []).filter(function (w) { return wrapperFamily(w) === name; });
            inFamily.forEach(function (w, i) {
                items.push({
                    type: 'wrapper',
                    wrapperId: w.id,
                    label: w.default ? (w.label + ' (default)') : w.label,
                    acceptsModel: !!w.accepts_model,
                    groupLabel: (multi && i === 0) ? familyLabel(name, families) : null,
                });
            });
        });
        return items;
    }

    root.ProviderGroups = {
        wrapperFamily: wrapperFamily,
        familyOrder: familyOrder,
        familyLabel: familyLabel,
        buildWrapperItems: buildWrapperItems,
    };
})(typeof window !== 'undefined' ? window : globalThis);
