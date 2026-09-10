// Injected via Playwright's add_init_script(), so this runs BEFORE any
// application script on every navigation - including the very first
// paint of index.html. It instruments two things this harness cannot
// measure any other way:
//
// 1. Every WebSocket this page opens: each outgoing .send() and every
//    incoming 'message' event is timestamped with performance.now() and
//    appended to window.__wsLog, tagged by the socket's URL. This is
//    added as a CAPTURE-ORDER 'message' listener at construction time,
//    before the application ever gets a chance to set `.onmessage` or
//    call `.addEventListener('message', ...)` itself, so it observes
//    every frame the application observes and none it doesn't.
//
// 2. xterm.js's own onRender callback, once window.TerminalController.term
//    exists (armed lazily by arm(), polled from Python, since the
//    Terminal instance is not constructed until a session is entered).
//    onRender is xterm's OWN paint-completion signal - it fires after the
//    renderer has redrawn the rows the parser touched, which is the
//    "actual rendered echo" the plan requires, as distinct from onData
//    (fires when the parser has decoded a chunk, before anything is
//    necessarily painted) or a raw WebSocket message event (fires before
//    the bytes have even reached the terminal parser).
//
// Nothing here modifies application behavior: every wrapped method still
// calls straight through to the real implementation.
(function () {
  if (window.__perfInstrumented) return;
  window.__perfInstrumented = true;
  window.__wsLog = [];
  window.__renderLog = [];

  const NativeWebSocket = window.WebSocket;
  function PerfWebSocket(url, protocols) {
    const sock = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    const tag = String(url);
    sock.addEventListener('message', function (ev) {
      const entry = { t: performance.now(), dir: 'recv', url: tag, size: 0, preview: '' };
      window.__wsLog.push(entry);
      // Best-effort decode for debugging/diagnostics only - nothing in
      // measurement code reads `preview` or `size`, so a decode that
      // never resolves (should not happen) cannot stall a measurement.
      if (typeof ev.data === 'string') {
        entry.size = ev.data.length;
        entry.preview = ev.data.slice(0, 120);
      } else if (ev.data && typeof ev.data.size === 'number') {
        entry.size = ev.data.size;
        if (typeof ev.data.text === 'function') {
          ev.data.text().then(function (t) { entry.preview = t.slice(0, 120); });
        }
      } else if (ev.data instanceof ArrayBuffer) {
        entry.size = ev.data.byteLength;
        entry.preview = new TextDecoder().decode(ev.data).slice(0, 120);
      }
    });
    const nativeSend = sock.send.bind(sock);
    sock.send = function (data) {
      let size = 0;
      let preview = '';
      if (typeof data === 'string') { size = data.length; preview = data.slice(0, 120); }
      else if (data instanceof ArrayBuffer) { size = data.byteLength; preview = new TextDecoder().decode(data).slice(0, 120); }
      else if (data && typeof data.byteLength === 'number') { size = data.byteLength; }
      window.__wsLog.push({ t: performance.now(), dir: 'send', url: tag, size: size, preview: preview });
      return nativeSend(data);
    };
    return sock;
  }
  PerfWebSocket.prototype = NativeWebSocket.prototype;
  PerfWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PerfWebSocket.OPEN = NativeWebSocket.OPEN;
  PerfWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PerfWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = PerfWebSocket;

  // Arms the xterm onRender hook against whatever terminal instance is
  // live right now. Idempotent per xterm Terminal instance (a session
  // switch may reuse the same instance or hand back a new one; either
  // way this is safe to call repeatedly from Python).
  window.__armRenderHook = function () {
    const term = window.TerminalController && window.TerminalController.term;
    if (!term || term.__perfHooked) return !!term;
    term.__perfHooked = true;
    term.onRender(function () {
      // Join every currently-VISIBLE row (the viewport), not just the
      // cursor's row: a keystroke echo lands at the cursor, but a
      // session-switch marker printed earlier can be anywhere on screen.
      // Capped to term.rows, which is small (tens of lines), so this is
      // cheap even at typing cadence.
      let text = '';
      try {
        const buf = term.buffer.active;
        const rows = [];
        for (let i = 0; i < term.rows; i++) {
          const line = buf.getLine(buf.viewportY + i);
          rows.push(line ? line.translateToString(true) : '');
        }
        text = rows.join('\n');
      } catch (e) {
        text = '';
      }
      window.__renderLog.push({ t: performance.now(), text: text });
    });
    return true;
  };

  // Clears both logs and returns the current browser-clock time, so a
  // Python-side measurement can bracket exactly one interaction.
  // True once at least one render has painted something other than blank
  // lines. The server's WS handshake drops any input that arrives before
  // the client's own pty_resize response completes ("the user can't have
  // typed anything yet" - see tests/real_hook_app.py's module docstring
  // for the same finding against this exact server), so a keystroke sent
  // the instant #terminal-screen becomes visible can be silently dropped.
  // The shell's OWN first prompt painting is proof the handshake and the
  // pty are both live; Python polls this before sending anything timed.
  window.__nonBlankRendered = function () {
    return window.__renderLog.some(function (r) { return r.text && r.text.trim().length > 0; });
  };

  window.__armEcho = function () {
    window.__wsLog = [];
    window.__renderLog = [];
    return performance.now();
  };

  // A compact snapshot for the Python poll loop: whether a render has
  // happened since arm() whose visible line contains `needle`, plus the
  // raw send/recv timestamps closest to it for phase attribution.
  window.__echoSnapshot = function (needle) {
    const hit = window.__renderLog.find(function (r) { return needle === '' || r.text.indexOf(needle) !== -1; });
    const sends = window.__wsLog.filter(function (w) { return w.dir === 'send'; });
    const recvs = window.__wsLog.filter(function (w) { return w.dir === 'recv'; });
    return {
      rendered: !!hit,
      renderAt: hit ? hit.t : null,
      sentAt: sends.length ? sends[0].t : null,
      recvAt: recvs.length ? recvs[0].t : null,
    };
  };

  // Generic bounding-box + visibility probe, shared by the menu/settings/
  // toast measurements. A box with zero area is not "visible" no matter
  // what the DOM's presence or computed opacity claims - the same
  // standard scripts/verify_toast_stacking.py already holds toasts to.
  window.__visibleBox = function (selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // A slide-out panel (session sidebar, some modals) keeps a non-zero
    // LAYOUT box while transformed off-screen, so width/height alone
    // would call it visible before it has actually slid into view. The
    // on-screen intersection test is what catches that: the painted box
    // must actually overlap the viewport, not merely exist somewhere off
    // to the side of it.
    const onScreen = rect.right > 0 && rect.left < (window.innerWidth || 0)
      && rect.bottom > 0 && rect.top < (window.innerHeight || 0);
    const visible = rect.width > 0 && rect.height > 0 && onScreen
      && style.visibility !== 'hidden' && style.display !== 'none'
      && parseFloat(style.opacity || '1') > 0.01;
    return { visible: visible, width: rect.width, height: rect.height, t: performance.now() };
  };
})();
