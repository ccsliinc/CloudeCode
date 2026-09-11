<!--
  The home screen shell: everything on #launchpad-screen that is not one
  of the four lists.

  IT RENDERS ONCE AND HOLDS NO REACTIVE STATE, and that is deliberate
  rather than incidental. Slices 4 and 5 both found the same trap - a
  reactive subscription makes every intermediate assignment a repaint
  where the old renderer painted once at the end - so this component
  reads no store, derives nothing and carries no rune but the props it
  is given. The four lists inside it are the things that move, and each
  of them owns its own subscription. See the repaint note in
  .claude/notes/svelte-migration-launchpad.md slice 4.

  THE CONTAINER MARKUP IS STATIC ON PURPOSE, NOT BY ACCIDENT. Three
  legacy surfaces write into elements this template renders:
  `App._placeStatusLight()` RE-PARENTS the one #statusText node into
  #home-bar-status, `GlobalAudioToggle.place()` inserts its button as a
  sibling of that span, and the section chrome modules write the counts,
  the archive filters and each section's display. A Svelte `{#if}` or
  `{#each}` anywhere over those nodes would re-create them and silently
  drop whatever had been moved in. Nothing in here may become
  conditional without moving those three surfaces first.

  THE FOUR LOAD-BEARING IDS, named so a future edit cannot remove one by
  accident: #launchpad-screen is the MOUNT TARGET and stays in
  client/index.html, untouched by this component, because app.js toggles
  .active on it. #home-bar-status is the status light's anchor.
  #home-bar-status-text is the label app.js writes from that node's
  data-status. Together with #launchpad-screen they are what
  web/src/lib/launchpad/home-anchors.ts enumerates and what the mutation
  test in HomeScreen.behaviour.test.ts removes to prove the guard fails.

  THE CREATE CONTROL LIVES IN ITS OWN ALWAYS-PRESENT ROW and not inside
  a section title, because it is a GLOBAL action whose lifetime must not
  depend on any one list. It used to be a child of the running-sessions
  title row, which is display:none while the user has zero sessions - so
  on a fresh install the only control that creates anything measured 0x0
  and a brand-new user could not create a first session at all. The
  button was in the DOM the whole time with visibility:visible, so every
  markup assertion passed against the broken build; only
  getBoundingClientRect() could see it. See scripts/verify_fresh_install.py.

  NO STANDALONE TITLE BLOCK. "Cloude Code Launcher" and its prompt live
  in the top header (App.showLaunchpad -> setHeaderIdentity). Re-adding
  them here restores the vertical cost that change removed.

  NO ARCHIVE ROW, NO SERVER-MANAGEMENT SECTION. The archive's entry point
  is the #archiveBtn icon in the header, reachable from EVERY screen; the
  server-management section's one control is the home bar's
  server-controls menu. Both were re-added once and removed again.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { t } from '../i18n/index.svelte';
    import HelpDisclosure from './HelpDisclosure.svelte';
    import { HOME_KEYS } from '../../../../client/js/labels/home-screen.js';
    // The two archive filters' TITLES belong to the lists that own their
    // state, so the keys come from those lists' own label modules rather
    // than being restated here.
    import { RECENT_KEYS } from '../../../../client/js/labels/recent-session.js';
    import { PROJECT_TREE_KEYS } from '../../../../client/js/labels/project-tree.js';
    import { mountLaunchpadPanels } from './panels';
    import { bindHeaderHelpToggle, initSectionDisclosures, renderHomeBarVersion, wireServerControls } from './home-chrome';
    import { wireNewFab, type FabAction } from './new-fab';

    interface Props {
        /**
         * What each `data-action` on the speed dial runs. Passed IN
         * rather than imported so this component never reaches a create
         * flow itself - props down, callbacks up.
         */
        fabActions?: Record<string, FabAction>;
    }

    const { fabActions = {} }: Props = $props();

    onMount(() => {
        // ORDER MATTERS ONCE: the panels mount into containers this
        // template just rendered, and the disclosures read those same
        // containers to apply a persisted collapse. Everything else is
        // independent.
        mountLaunchpadPanels();
        renderHomeBarVersion();
        const offControls = wireServerControls(t);
        const offSections = initSectionDisclosures();
        const offHelp = bindHeaderHelpToggle();
        const offFab = wireNewFab(fabActions);
        void offControls;
        return () => {
            offSections();
            offHelp?.();
            offFab?.();
        };
    });
</script>

<div class="launchpad-scroll">
    <div class="launchpad-container">
        <!-- STAGE C: the session-attribution prompt. Always present and
             always EMPTY when there is nothing to ask, so an unasked
             question costs no layout. -->
        <div id="attribution-prompt" class="attribution-prompt-slot"></div>

        <HelpDisclosure />

        <div class="launchpad-actions" id="launchpad-actions">
            <div class="new-fab" id="new-fab">
                <button
                    class="new-fab__trigger"
                    id="new-fab-trigger"
                    type="button"
                    aria-label={t(HOME_KEYS.newTrigger)}
                    title={t(HOME_KEYS.newTrigger)}
                    aria-haspopup="menu"
                    aria-expanded="false"
                >
                    <svg class="new-fab__plus" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
                <div class="new-fab__menu" role="menu" aria-label={t(HOME_KEYS.newMenu)}>
                    <!-- TOP ITEM. It is named for what it MAKES, and it
                         carries the app's OWN icon asset rather than a
                         glyph traced by hand. Never redraw a mark here;
                         if an asset you need does not exist, say so
                         instead of approximating one. -->
                    <button class="new-fab__item" type="button" role="menuitem" data-action="new-claude-project" tabindex="-1">
                        <span class="new-fab__icon" aria-hidden="true">
                            <img class="new-fab__icon-img" src="/static/assets/icons/header-icon.png" srcset="/static/assets/icons/header-icon.png 1x, /static/assets/icons/header-icon@2x.png 2x" alt="" />
                        </span>
                        <span class="new-fab__label">{t(HOME_KEYS.newClaudeProject)}</span>
                    </button>
                    <!-- SECOND ITEM. Adds a session to a project that
                         already exists. It never creates a project, and
                         with none to choose from it says so rather than
                         opening an empty picker. -->
                    <button class="new-fab__item" type="button" role="menuitem" data-action="new-session" tabindex="-1">
                        <span class="new-fab__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="16" rx="2" />
                                <line x1="12" y1="9" x2="12" y2="15" />
                                <line x1="9" y1="12" x2="15" y2="12" />
                            </svg>
                        </span>
                        <span class="new-fab__label">{t(HOME_KEYS.newSession)}</span>
                    </button>
                    <!-- NO "open from folder" ITEM. Opening a folder
                         already on disk is one of the three ways to
                         start a claude project, not a peer of starting
                         one, so it is the third choice inside "new
                         claude project" above. Two entry points to one
                         flow is what removing it fixed. -->
                    <button class="new-fab__item" type="button" role="menuitem" data-action="connect-openclaw" tabindex="-1">
                        <span class="new-fab__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M6 3v6a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4" />
                                <path d="M6 3l-2 2" />
                                <path d="M6 3l2 2" />
                                <path d="M18 21l-2-2" />
                                <path d="M18 21l2-2" />
                            </svg>
                        </span>
                        <span class="new-fab__label">{t(HOME_KEYS.newOpenclaw)}</span>
                    </button>
                    <button class="new-fab__item" type="button" role="menuitem" data-action="connect-hermes" tabindex="-1">
                        <span class="new-fab__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" />
                            </svg>
                        </span>
                        <span class="new-fab__label">{t(HOME_KEYS.newHermes)}</span>
                    </button>
                    <button class="new-fab__item" type="button" role="menuitem" data-action="new-console" tabindex="-1">
                        <span class="new-fab__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="4 7 9 12 4 17" />
                                <line x1="12" y1="18" x2="20" y2="18" />
                            </svg>
                        </span>
                        <span class="new-fab__label">{t(HOME_KEYS.newConsole)}</span>
                    </button>
                </div>
            </div>
        </div>

        <div id="running-sessions-section" class="launchpad-section running-sessions-section" style="display:none;">
            <div class="launchpad-section-title launchpad-section-title--row">
                <button type="button" class="launchpad-section-toggle" id="running-sessions-toggle" aria-expanded="true" aria-controls="running-sessions-list">
                    <span class="launchpad-section-chevron" aria-hidden="true">&#9658;</span>
                    <span class="launchpad-section-title__text">{t(HOME_KEYS.sectionRunning)}</span>
                    <span class="launchpad-section-count" id="running-sessions-count" data-listing-ok="1"></span>
                </button>
            </div>
            <div id="running-sessions-list"></div>
        </div>

        <!-- RECENT is datastore-backed, NOT a live tmux probe. Every row
             is lifecycle='stopped' read straight from the sessions
             table. The list, the count, the archive filter and this
             section's own visibility belong to RecentSessions.svelte;
             only this heading is shell markup, because the collapse
             binding lives on it. -->
        <div id="recent-sessions-section" class="launchpad-section recent-sessions-section" style="display:none;">
            <div class="launchpad-section-title">
                <button type="button" class="launchpad-section-toggle" id="recent-sessions-toggle" aria-expanded="true" aria-controls="recent-sessions-list">
                    <span class="launchpad-section-chevron" aria-hidden="true">&#9658;</span>
                    <span class="launchpad-section-title__text">{t(HOME_KEYS.sectionRecent)}</span>
                    <span class="launchpad-section-count" id="recent-sessions-count" data-state="ok"></span>
                </button>
                <!-- SHOW-ARCHIVED, RECENT's copy. The only route to a
                     session record the user archived. Without it those
                     rows exist in the database and on the wire and are
                     reachable from nowhere, which is how an archived row
                     took a live conversation with it on 2026-09-07.
                     Same shape as the projects control beside it, a
                     different verb: a session's archive is a soft
                     DELETE, not a shelf. Its state, its title and its
                     click all belong to RecentSessions.svelte through
                     ./recent-chrome.ts, which addresses it by id - so
                     this markup is a mount point, not a control. -->
                <button type="button" class="launchpad-archived-toggle" id="recent-show-deleted-toggle" aria-pressed="false" title={t(RECENT_KEYS.archiveShow)}>
                    <span class="launchpad-archived-toggle__box" aria-hidden="true"></span>
                    <span class="launchpad-archived-toggle__label">{t(HOME_KEYS.showArchived)}</span>
                </button>
            </div>
            <div id="recent-sessions-list"></div>
        </div>

        <div class="launchpad-section" id="projects-section">
            <div class="launchpad-section-title">
                <button type="button" class="launchpad-section-toggle" id="projects-section-toggle" aria-expanded="true" aria-controls="project-list">
                    <span class="launchpad-section-chevron" aria-hidden="true">&#9658;</span>
                    {t(HOME_KEYS.sectionProjects)}
                </button>
                <!-- SHOW-ARCHIVED, PROJECTS' copy. PERMANENTLY VISIBLE,
                     never conditional on there BEING archived projects,
                     and that is the whole discoverability guarantee:
                     knowing whether any exist would need a second fetch
                     of the very rows the toggle excludes, so the control
                     announces itself instead. An archived project is
                     therefore always one click from being on screen and
                     one more from being restored - archive can never
                     become a place work quietly disappears to. Owned by
                     ProjectTree.svelte through ./project-chrome-control.ts. -->
                <button type="button" class="launchpad-archived-toggle" id="projects-show-archived-toggle" aria-pressed="false" title={t(PROJECT_TREE_KEYS.archivedShow)}>
                    <span class="launchpad-archived-toggle__box" aria-hidden="true"></span>
                    <span class="launchpad-archived-toggle__label">{t(HOME_KEYS.showArchived)}</span>
                </button>
            </div>
            <div id="project-list" class="project-list">
                <div class="launchpad-empty">{t(HOME_KEYS.projectsLoading)}</div>
            </div>
        </div>
    </div>
</div>

<!-- THE HOME BAR. A flex row whose direct children are its items:
     everything before .home-bar__spacer hugs the left edge, everything
     after it the right. Adding an item later is adding one child on the
     side it belongs to - no slot table, no layout to rewrite.

     HOME SCREEN ONLY. This markup is rendered into #launchpad-screen and
     nowhere else, so it cannot appear on the terminal screen, which
     spends its vertical pixels on the terminal. -->
<div class="home-bar" role="toolbar" aria-label={t(HOME_KEYS.barLabel)}>
    <button type="button" id="server-controls-btn" class="home-bar__btn" aria-haspopup="menu" aria-expanded="false" aria-label={t(HOME_KEYS.barServerControls)} title={t(HOME_KEYS.barServerControls)}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" stroke="currentColor" stroke-width="1.5" />
            <path d="M13 8c0-.38-.04-.75-.12-1.1l1.34-.98-1.5-2.6-1.55.62a5.05 5.05 0 0 0-1.9-1.1L9.05 1h-3l-.22 1.84c-.7.24-1.35.62-1.9 1.1l-1.55-.62-1.5 2.6 1.34.98a5.1 5.1 0 0 0 0 2.2l-1.34.98 1.5 2.6 1.55-.62c.55.48 1.2.86 1.9 1.1L6.05 15h3l.22-1.84c.7-.24 1.35-.62 1.9-1.1l1.55.62 1.5-2.6-1.34-.98c.08-.35.12-.72.12-1.1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
    </button>
    <!-- THE STATUS LIGHT'S ANCHOR, and the dot is deliberately NOT in
         this markup. This is a MOUNT POINT, not a copy: the one
         #statusText node lives in the header on the auth and terminal
         screens and is MOVED in here by App._placeStatusLight() while
         the home screen is up - the same node-moving rule
         header-menu.js follows, because that node is addressed by id by
         app.js and terminal.js. The label is written from its
         data-status by App._observeStatusText(), so the string still has
         exactly one author. GlobalAudioToggle.place() inserts its button
         as this span's SIBLING, so .home-bar has to stay a real,
         non-conditional parent too. Do not invent a message bus for
         either of them; an anchor is the contract. -->
    <span class="home-bar__status" id="home-bar-status">
        <span class="home-bar__status-text" id="home-bar-status-text"></span>
    </span>
    <span class="home-bar__spacer" aria-hidden="true"></span>
    <!-- A MOUNT POINT TOO: version-footer.js owns the string, so the bar
         and the sidebar footer can never show two different versions. -->
    <span class="home-bar__version" id="home-bar-version"></span>
    <a class="home-bar__link" href="https://nyedis.ai" target="_blank" rel="noopener noreferrer" aria-label={t(HOME_KEYS.barSiteLink)} title={t(HOME_KEYS.barSiteLink)}>
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 986 937" role="img" aria-label={t(HOME_KEYS.barSiteMark)}>
            <path d="M 409.0 883.5 L 408.5 882.0 L 458.5 804.0 L 489.5 748.0 L 488.0 747.5 L 453.0 783.5 L 437.0 797.5 L 403.0 823.5 L 377.0 839.5 L 376.5 838.0 L 398.5 816.0 L 438.5 771.0 L 469.5 732.0 L 478.5 718.0 L 474.0 719.5 L 436.0 750.5 L 388.0 785.5 L 394.5 766.0 L 409.5 739.0 L 408.0 738.5 L 386.0 753.5 L 377.0 758.5 L 375.5 758.0 L 382.5 743.0 L 394.5 725.0 L 410.5 705.0 L 410.5 703.0 L 374.0 704.5 L 361.0 702.5 L 360.5 701.0 L 409.0 681.5 L 481.0 647.5 L 520.0 625.5 L 546.0 607.5 L 565.5 589.0 L 570.5 580.0 L 570.5 576.0 L 561.0 575.5 L 542.0 580.5 L 545.5 574.0 L 560.5 556.0 L 594.0 522.5 L 632.5 489.0 L 630.0 487.5 L 588.0 488.5 L 551.0 493.5 L 516.0 500.5 L 529.5 487.0 L 532.5 480.0 L 532.0 473.5 L 515.0 472.5 L 491.0 468.5 L 451.0 455.5 L 435.5 448.0 L 452.0 439.5 L 456.5 435.0 L 456.0 433.5 L 420.0 426.5 L 402.0 420.5 L 394.5 416.0 L 427.0 414.5 L 442.0 411.5 L 445.0 410.5 L 445.0 408.5 L 399.0 408.5 L 375.0 406.5 L 333.0 400.5 L 305.5 393.0 L 306.0 391.5 L 309.0 391.5 L 344.0 394.5 L 429.0 395.5 L 461.0 394.5 L 461.0 392.5 L 426.0 390.5 L 378.0 384.5 L 302.0 370.5 L 249.0 358.5 L 180.0 339.5 L 138.0 331.5 L 75.0 314.5 L 34.0 299.5 L 19.0 291.5 L 15.5 287.0 L 18.0 285.5 L 173.5 287.0 L 173.0 285.5 L 125.0 275.5 L 91.0 264.5 L 68.0 252.5 L 59.5 244.0 L 59.0 238.5 L 134.0 251.5 L 227.5 271.0 L 225.5 266.0 L 218.0 259.5 L 181.5 238.0 L 185.0 237.5 L 297.0 264.5 L 434.0 294.5 L 546.0 316.5 L 613.0 326.5 L 613.5 325.0 L 607.0 320.5 L 591.0 312.5 L 561.0 301.5 L 509.0 287.5 L 450.0 276.5 L 449.5 275.0 L 483.0 262.5 L 505.0 257.5 L 534.0 253.5 L 600.0 252.5 L 625.0 255.5 L 632.5 255.0 L 622.0 245.5 L 609.0 239.5 L 588.0 233.5 L 551.5 228.0 L 568.0 220.5 L 585.0 217.5 L 612.0 217.5 L 644.0 221.5 L 692.0 232.5 L 737.0 247.5 L 741.0 247.5 L 747.0 241.5 L 754.0 237.5 L 771.0 233.5 L 797.0 235.5 L 814.0 240.5 L 827.0 246.5 L 841.5 259.0 L 844.5 265.0 L 845.5 281.0 L 843.5 288.0 L 836.5 301.0 L 824.5 316.0 L 805.0 334.5 L 782.0 351.5 L 769.5 365.0 L 761.5 379.0 L 761.5 390.0 L 765.0 393.5 L 767.0 393.5 L 778.0 388.5 L 795.0 383.5 L 807.0 381.5 L 827.0 381.5 L 852.0 387.5 L 865.0 393.5 L 879.0 402.5 L 904.5 426.0 L 925.5 454.0 L 946.5 492.0 L 957.5 518.0 L 961.5 532.0 L 944.0 513.5 L 932.0 503.5 L 923.0 497.5 L 903.0 488.5 L 889.0 485.5 L 873.0 485.5 L 853.0 490.5 L 839.0 497.5 L 829.0 504.5 L 814.5 519.0 L 783.5 561.0 L 754.5 604.0 L 737.5 635.0 L 737.5 659.0 L 740.0 661.5 L 765.0 671.5 L 816.0 696.5 L 826.0 699.5 L 843.0 709.5 L 857.0 720.5 L 879.5 743.0 L 894.5 762.0 L 895.5 768.0 L 881.0 780.5 L 879.5 771.0 L 875.5 764.0 L 870.0 758.5 L 856.5 750.0 L 847.5 731.0 L 834.0 716.5 L 821.0 708.5 L 808.0 704.5 L 799.0 704.5 L 800.0 700.5 L 780.0 689.5 L 722.0 666.5 L 716.5 662.0 L 715.5 650.0 L 710.0 643.5 L 705.0 641.5 L 688.0 641.5 L 683.5 644.0 L 682.5 651.0 L 689.0 666.5 L 752.0 692.5 L 793.0 711.5 L 808.0 722.5 L 824.5 738.0 L 834.5 751.0 L 840.5 762.0 L 838.5 766.0 L 828.0 772.5 L 816.0 774.5 L 815.5 762.0 L 811.5 753.0 L 805.5 744.0 L 794.0 732.5 L 786.0 729.5 L 777.0 728.5 L 765.0 729.5 L 764.5 728.0 L 768.0 724.5 L 774.0 722.5 L 774.5 721.0 L 767.0 719.5 L 734.0 699.5 L 701.0 684.5 L 681.0 679.5 L 670.0 679.5 L 668.5 671.0 L 664.0 665.5 L 657.0 663.5 L 651.0 664.5 L 646.5 669.0 L 643.5 677.0 L 645.5 705.0 L 644.5 753.0 L 643.5 756.0 L 641.0 756.5 L 637.5 748.0 L 633.0 742.5 L 627.0 739.5 L 620.5 740.0 L 623.5 754.0 L 623.5 772.0 L 620.5 790.0 L 616.0 803.5 L 614.5 795.0 L 611.0 789.5 L 603.0 783.5 L 595.0 782.5 L 593.5 798.0 L 589.5 812.0 L 581.5 826.0 L 567.0 840.5 L 564.5 841.0 L 566.5 830.0 L 566.5 816.0 L 565.5 807.0 L 564.0 806.5 L 549.5 828.0 L 532.0 845.5 L 514.0 858.5 L 512.5 858.0 L 519.5 849.0 L 523.5 840.0 L 526.5 828.0 L 526.0 823.5 L 503.0 844.5 L 479.0 860.5 L 487.5 844.0 L 495.5 819.0 L 501.5 788.0 L 500.0 786.5 L 461.5 835.0 L 427.0 869.5 L 409.0 883.5 Z" fill="currentColor"/>
        </svg>
    </a>
</div>
