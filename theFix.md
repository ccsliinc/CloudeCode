Here are the **top 3 fixes** I recommend, in priority order, with concrete code you can drop into your repo. Each fix addresses the “DevTools open = OK, DevTools closed = broken” race you’re seeing, and they’re designed to be applied independently (start with #1; most teams don’t need #2/#3 once #1 is in place).

---

## 1) Make PTY → xterm writes deterministic (single writer, binary frames, optional back‑pressure)

**Why this likely fixes it**

* With DevTools closed, your WS `onmessage` fires faster and more often. If you call `term.write` re‑entrantly (or coalesce poorly), the same chunks can be flushed **multiple times per frame**—which shows up as “extra blank lines”. DevTools’ slowdown masks this.
* xterm’s `write` is **non‑blocking** and internally buffered; use its callback to know when a chunk is fully parsed, and (optionally) implement **ACK-based flow control** over WebSocket so the OS PTY doesn’t outrun the browser. ([Xterm.js][1])
* Also switch from JSON+base64 to **real binary WS frames** and feed xterm **Uint8Array** directly. This removes string conversions and any accidental `\r/\n` re-encoding. xterm’s `write` accepts `Uint8Array` and the docs explain how to handle binary/encoding cleanly. ([GitHub][2])

### Client (client/index.html)

**a) Initialize the terminal (turn *off* convertEol for PTY sources)**

> xterm recommends not using `convertEol` with a PTY; the PTY’s termios typically handles it. ([Xterm.js][3])

```html
<script type="module">
  import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.3.0/+esm';
  import { FitAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.8.0/+esm';

  const term = new Terminal({
    // IMPORTANT: for PTY sources, let the stream's own line discipline handle EOL
    convertEol: false,
    // You’re not using WebglAddon; default canvas/DOM is fine for now
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const $el = document.getElementById('terminal');
  term.open($el);
  // we'll fit and connect the socket in Fix #2 (init gating)
</script>
```

**b) Consume PTY bytes through a single, frame-gated writer**
This ensures you **never** write the same bytes twice and coalesces bursts into one `write` call per frame.

```html
<script type="module">
  let ws;
  const queue = [];
  let flushing = false;

  function enqueue(bytes) {
    queue.push(bytes);
    if (!flushing) {
      flushing = true;
      requestAnimationFrame(flush);
    }
  }

  function flush() {
    // merge queue into a single Uint8Array
    let total = 0;
    for (const c of queue) total += c.length;
    const merged = new Uint8Array(total);
    let o = 0;
    while (queue.length) {
      const c = queue.shift();
      merged.set(c, o);
      o += c.length;
    }
    // Write once; use callback to signal an ACK (optional but recommended)
    term.write(merged, () => {
      // If you implement ACK on the server, uncomment:
      // ws?.send(JSON.stringify({ type: 'ack', n: merged.length }));
      flushing = false;
      if (queue.length) requestAnimationFrame(flush);
    });
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      // Server will now send raw bytes (no base64/JSON for PTY data)
      if (ev.data instanceof ArrayBuffer) {
        enqueue(new Uint8Array(ev.data));
      } else {
        // handle small JSON control messages (resize, ping, etc.)
        const msg = JSON.parse(ev.data);
        // ...handle control types here...
      }
    };
    // send keyboard input back as raw bytes if needed
    term.onData(s => ws?.send(new TextEncoder().encode(s)));
  }
</script>
```

> Why requestAnimationFrame? xterm processes `write` on a timer-sized budget per frame; aligning your flush with the browser render loop avoids re-entrancy and matches xterm’s model. The **flow control guide** explains `write` buffering and the write-callback semantics. ([Xterm.js][1])

### Server (src/api/websocket.py)

**c) Send PTY output as binary frames (no JSON, no base64)**

```python
# BEFORE (roughly)
# await websocket.send_json({"type": "pty_data", "data": base64.b64encode(b).decode()})

# AFTER
await websocket.send_bytes(b)
```

**d) (Optional but robust) High/low watermark + ACK to pause/resume reading the PTY**
This directly follows the xterm team’s recommended pattern for **flow control over WebSockets**. ([Xterm.js][1])

```python
import asyncio, os, json

HIGH = 512 * 1024  # bytes in-flight
LOW  = 256 * 1024

async def stream_pty(master_fd, websocket):
    in_flight = 0
    paused = False

    async def pty_reader():
        nonlocal in_flight, paused
        loop = asyncio.get_running_loop()
        while True:
            if paused:
                await asyncio.sleep(0.005)
                continue
            # read PTY on threadpool to avoid blocking
            chunk = await loop.run_in_executor(None, os.read, master_fd, 65536)
            if not chunk:
                break
            await websocket.send_bytes(chunk)
            in_flight += len(chunk)
            if in_flight > HIGH:
                paused = True  # stop pulling from PTY (lets OS apply back-pressure)

    async def ws_reader():
        nonlocal in_flight, paused
        async for message in websocket.iter_text():
            try:
                msg = json.loads(message)
            except Exception:
                continue
            if msg.get("type") == "ack":
                n = int(msg.get("n", 0))
                in_flight = max(in_flight - n, 0)
                if paused and in_flight < LOW:
                    paused = False

    await asyncio.gather(pty_reader(), ws_reader())
```

> If you prefer not to write your own plumbing, you can also use **@xterm/addon-attach** to attach a WebSocket directly (it expects a stable write path and can consume binary). ([GitHub][4])

---

## 2) Gate the first write until the terminal’s geometry is *actually* ready (fonts loaded + fit() done)

**Why this helps**

xterm measures character cell size using hidden DOM elements; if you start streaming **before** fonts load or before the container has a real size, you can get bogus dimensions and odd row spacing until the next render/fits—DevTools can incidentally change timing so it looks “fixed”. Deferring the socket connection and the **first** `term.write` until fonts are ready and `FitAddon.fit()` has run removes that race.

```html
<script type="module">
  // Wait for fonts + layout, then fit, then connect:
  async function waitForFontsAndLayout(container) {
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch {}
    }
    // Ensure the container has non-zero size
    const t0 = performance.now();
    while ((container.offsetWidth|0) === 0 || (container.offsetHeight|0) === 0) {
      if (performance.now() - t0 > 2000) break;
      await new Promise(r => setTimeout(r, 16));
    }
    // Let layout settle
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }

  (async () => {
    const $el = document.getElementById('terminal');
    await waitForFontsAndLayout($el);
    fitAddon.fit();
    // Notify backend of real size (if you propagate cols/rows)
    ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    connect(); // from Fix #1
  })();

  // Keep it correct on resize:
  const ro = new ResizeObserver(() => {
    fitAddon.fit();
    ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
  ro.observe(document.getElementById('terminal-wrapper'));
</script>
```

---

## 3) Normalize EOL + shield xterm from global CSS (and try the built-in code paths first)

**Why this may be the remaining culprit**

* Double translations (`ONLCR` on the slave, **and** `convertEol: true` in xterm) can create blank lines, and different timing paths decide whether (or how often) conversions happen. The xterm API docs explicitly say **don’t** use `convertEol` with a PTY. ([Xterm.js][3])
* Aggressive global CSS (e.g., `* { line-height: 1.6 }`, `letter-spacing`, transforms) can distort xterm’s character measurement element causing visual “extra lines”. This is rare but easy to bulletproof.

### Concrete steps

1. **Terminal options** (client/index.html)

```js
const term = new Terminal({
  convertEol: false,       // PTY handles EOL, avoid double-translation
  // rendererType: 'canvas', // default is fine; switch to 'dom' temporarily to A/B
});
```

2. **PTY termios** (src/utils/pty_session.py) — let PTY be vanilla
   (You already reverted ONLCR/ICRNL; keep it that way for debugging fidelity.)

3. **CSS guard**
   Put this in your stylesheet to prevent global rules from changing xterm’s char metrics during its measurement:

```css
/* Prevent line-height/letter-spacing from bleeding into xterm measurement */
.xterm, .xterm * {
  line-height: normal !important;
  letter-spacing: normal !important;
  font-kerning: normal !important;
}
```

4. **If you still suspect renderer race**, temporarily try:

```js
const term = new Terminal({ rendererType: 'dom' }); // debug: if this fixes it, it was a renderer sizing quirk
```

---

# Code references (your paths)

* **Terminal init & settings**: `client/index.html`

  * Init block around **lines 186–265** → add the `convertEol: false` config and the **init gating** from Fix #2.
  * WS connect + handlers around **lines 423–530** → replace `term.write(decodedData)` loop with the **single-writer queue** from Fix #1; switch to `ws.binaryType = 'arraybuffer'` and feed `Uint8Array`.

* **WebSocket server**: `src/api/websocket.py`

  * **lines 71–145 / 206–232** → change PTY streaming from `send_json(base64)` to `send_bytes(data)`; add optional **ACK/HIGH-LOW watermark** logic in the reader/writer tasks (Fix #1d).

* **PTY session**: `src/utils/pty_session.py`

  * **lines 52–116** → keep defaults (no ONLCR/ICRNL twiddling) while debugging Fix #1.
  * Add a temporary **hex dump** to verify what’s leaving the PTY (first ~64 bytes per burst):

    ```python
    def _hex(b): return ' '.join(f'{x:02x}' for x in b[:64])
    logger.debug("PTY→WS %dB: %s", len(chunk), _hex(chunk))
    ```

---

## How to validate quickly

1. **Delay-only smoke test**: add `setTimeout(connect, 2000)` before you change anything. If the bug disappears, it’s almost certainly a write/initialization race (Fix #1/#2 are the right direction).

2. **Byte-for-byte check**: compare your PTY hex dump with a hex dump of the first merged chunk on the client; they should match exactly (no extra `0d`/`0a` pairs).

3. **Throughput sanity**: run `yes | head -n 2000` in the terminal. With Fix #1, it should stream without gaps, and Ctrl‑C should be responsive. (This is the exact workload the xterm team uses to explain flow control and write callbacks. ([Xterm.js][1]))

---

## Sources & why they matter

* **xterm flow control & write callback semantics (including WS ACK sketch)** — the model Fix #1 implements. ([Xterm.js][1])
* **Encoding/binary inputs and using Uint8Array with `write`** — remove base64/UTF‑16 pitfalls. ([GitHub][2])
* **`convertEol` guidance** — should not be used with PTY streams. ([Xterm.js][3])
* **Attach addon** (optional, if you want a prebuilt WS->xterm bridge). ([GitHub][4])

---

### If it still misbehaves after #1 + #2

* **Bump xterm.js to latest 5.5+** (your report mentions 5.3.0; multiple rendering and sizing fixes have landed since). ([GitHub][5])
* Try forcing `rendererType: 'dom'` briefly; if the bug disappears only with one renderer, we’ve isolated a renderer/measurement issue. (Recent webgl/canvas rendering issues have been fixed in newer releases.) ([GitHub][6])

---

### TL;DR

* **Fix #1 (binary frames + single writer + optional ACK)** addresses the real world timing bug that DevTools hides.
* **Fix #2 (init gating)** removes geometry races at startup.
* **Fix #3 (EOL/CSS hygiene)** eliminates the last class of newline/spacing surprises.

Apply #1 first; it typically resolves “extra blank lines when DevTools is closed” by making your write path deterministic and paced the way xterm expects.

[1]: https://xtermjs.org/docs/guides/flowcontrol/ "Flowcontrol"
[2]: https://github.com/xtermjs/xterm.js/discussions/4481?utm_source=chatgpt.com "Display Error UTF-8 to ASCII · xtermjs xterm.js - GitHub"
[3]: https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/?utm_source=chatgpt.com "Interface: ITerminalOptions"
[4]: https://github.com/xtermjs/xterm.js/blob/master/addons/addon-attach/README.md?utm_source=chatgpt.com "xterm.js/addons/addon-attach/README.md at master - GitHub"
[5]: https://github.com/xtermjs/xterm.js/releases?utm_source=chatgpt.com "Releases: xtermjs/xterm.js - GitHub"
[6]: https://github.com/xtermjs/xterm.js/issues/5357?utm_source=chatgpt.com "Terminal can go blank in webgl extension · Issue #5357 · xtermjs/xterm.js"
