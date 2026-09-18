<!--
  ExportModal - the transcript export preflight, its three integrity
  outcomes, and the stated reason there is no Download button.

  IT MOVES NO BYTES. It reads the HEADERS of an export the server would
  send and reports an integrity finding. The bytes are the server's
  byte-exact artefact and are never composed, masked or re-serialised
  here; see `export-vocab.ts` for why masking them would destroy the only
  property the archive has.

  THREE OUTCOMES, NOT TWO. VERIFIED is the only state that may be styled
  as success, and it is never inferred from a 200. UNVERIFIABLE is a
  COULD NOT EVALUATE - the export streams and uvicorn implements no HTTP
  trailers, so there is no hash of what was actually sent; it is not a
  failure and not known to be corrupt, so it is not dismissible, gets no
  checkmark, and carries the shasum command that performs the
  measurement the server could not. BUSY is the server declining to
  START: nothing failed and nothing was downloaded.

  THE DOWNLOAD BLOCKER IS RENDERED, NOT WORKED AROUND. Measured
  2026-08-31, the export endpoints take `Authorization: Bearer` and
  nothing else; a browser navigation sends no such header and would save
  a 401 error page. So the modal states the blocker with a copyable
  command instead of drawing a button that cannot work. A button that
  cannot work is worse than a stated blocker, because the blocker is at
  least information.

  SHELL-INDEPENDENT. It takes its client, its transcript id, its
  collision count and its `onClose`. It registers with NO modal stack and
  reaches for no global: the modal host is the SECOND documented gap in
  the `app-screen` surface, so escape handling and focus return are the
  parent's, exactly as slices 5 and 7 left them.
-->
<script lang="ts">
    import {
        classifyPreflight, collisionWarning, downloadCapability, shasumCommand,
        type PreflightInfo, type PreflightResult,
    } from './export-preflight';
    import { ACTIONS, CLASS, LABELS, STATES } from './export-vocab';

    /** The one method this modal needs from the granted archive client. */
    interface PreflightTransport {
        preflightArchiveExport(
            transcriptId: number | string, opts?: { verified?: boolean },
        ): Promise<PreflightResult>;
    }

    interface Props {
        /** The granted archive client. */
        client: PreflightTransport;
        /** Which transcript. Null is the refusal case; see `openable`. */
        transcriptId: number | string | null;
        /**
         * How many transcripts download under this filename. NULL MEANS
         * NOT LOOKED UP, which renders as a stated unknown rather than as
         * "unique" - only the caller has the listing.
         */
        sameNameCount?: number | null;
        /** Dismiss. The parent owns escape and focus return. */
        onClose?: () => void;
    }

    let { client, transcriptId, sameNameCount = null, onClose }: Props = $props();

    let info = $state<PreflightInfo | null>(null);

    /** The download blocker, computed once. */
    const cap = downloadCapability();

    /** Whether the blocker block is drawn for this state. */
    const showBlocked = $derived(
        info !== null && !cap.canDownload
        && (info.state === STATES.VERIFIED || info.state === STATES.UNVERIFIABLE),
    );

    /** The collision warning, or null. */
    const collision = $derived(
        info ? collisionWarning(info.filename, sameNameCount) : null,
    );

    /**
     * Run, or re-run, the preflight.
     *
     * Description: EXPORTED so a host can drive it, and it is what Retry
     *   calls on a 503. A transcript id of null refuses VISIBLY rather
     *   than opening an empty modal: the refusal lives here because this
     *   module owns what an export needs.
     * Output: the state token, or null when there was nothing to ask about.
     * Example: await modal.refresh()
     */
    export async function refresh(): Promise<string | null> {
        if (transcriptId === null || transcriptId === undefined) {
            info = {
                state: STATES.CANNOT_DETERMINE, expectedSha: null, actualSha: null,
                expectedBytes: null, filename: null, streamHref: null, verified: false,
                reason: 'no transcript is open, so there is nothing to export.',
            };
            return info.state;
        }
        info = null;
        const r = await client.preflightArchiveExport(transcriptId, { verified: true });
        info = classifyPreflight(r);
        return info.state;
    }

    /** The current finding, for a host that wants to read it. */
    export function finding(): PreflightInfo | null {
        return info;
    }

    void refresh();
</script>

<div class="{CLASS.modalOverlay} {CLASS.overlay}" data-modal="archive-export">
    <div class="{CLASS.modalContent} {CLASS.content}" role="dialog" aria-modal="true">
        <div class="{CLASS.modalHeader} {CLASS.header}">
            export transcript {transcriptId ?? 'NOT KNOWN'}
        </div>
        <div class={CLASS.slot}>
            <div class={CLASS.body} data-export-state={info ? info.state : STATES.PREFLIGHT}>
                <p class={CLASS.label}>
                    {info ? (LABELS[info.state] ?? info.state) : LABELS[STATES.PREFLIGHT]}
                </p>
                <p class={CLASS.reason}>
                    {info ? info.reason : 'checking the export headers.'}
                </p>

                {#if info?.filename}
                    <p class={CLASS.filename}>{info.filename}</p>
                {/if}
                {#if info?.expectedBytes}
                    <p class={CLASS.bytes}>{info.expectedBytes} bytes</p>
                {/if}
                {#if info?.expectedSha}
                    <p class={CLASS.shaExpected}>expected sha256 {info.expectedSha}</p>
                {/if}
                {#if info?.actualSha}
                    <p class={CLASS.shaActual}>actual sha256 {info.actualSha}</p>
                {/if}

                {#if info?.state === STATES.UNVERIFIABLE}
                    <!-- NORMATIVE: not dismissible and never styled as
                         success. It carries the command that performs the
                         measurement the server could not. -->
                    <pre class={CLASS.shasum} data-not-dismissible="true">{
                        shasumCommand(info.filename, info.expectedSha)
                    }</pre>
                {/if}

                {#if collision}
                    <p class={CLASS.collision}>{collision}</p>
                {/if}

                {#if showBlocked}
                    <div class={CLASS.blocked} data-export-state={STATES.BLOCKED_NO_CREDENTIAL}>
                        <p class={CLASS.blockedLabel}>
                            DOWNLOAD BLOCKED: NO CREDENTIAL A BROWSER CAN SEND
                        </p>
                        <p class={CLASS.blockedReason}>{cap.reason}</p>
                    </div>
                {/if}

                <div class={CLASS.actions}>
                    {#if info?.state === STATES.BUSY}
                        <button
                            class={CLASS.retry}
                            type="button"
                            data-action={ACTIONS.RETRY}
                            onclick={() => { void refresh(); }}
                        >retry</button>
                    {/if}
                    <button
                        class={CLASS.cancel}
                        type="button"
                        data-action={ACTIONS.CANCEL}
                        onclick={() => onClose?.()}
                    >cancel</button>
                </div>
            </div>
        </div>
    </div>
</div>
