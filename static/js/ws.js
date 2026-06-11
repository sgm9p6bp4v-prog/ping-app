/**
 * WebSocket client with exponential-backoff reconnect + jitter.
 */
export function connect({ url, onMessage, onState }) {
  let ws = null;
  let backoff = 250;
  let stopped = false;
  let openedAt = 0;

  function open() {
    onState("disconnected");
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      openedAt = Date.now();
      onState("connected");
    });
    ws.addEventListener("close", () => {
      // Only reset the backoff if the connection stayed open for a while —
      // an accept-then-drop loop must keep backing off, not hammer. Backoff
      // is only read when scheduling the reopen below, so checking the open
      // duration here is equivalent to a reset-after-3s-stable timer.
      if (openedAt && Date.now() - openedAt >= 3000) backoff = 250;
      openedAt = 0;
      ws = null;
      onState("disconnected");
      if (!stopped) scheduleReopen();
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch (_) {}
    });
    ws.addEventListener("message", (ev) => {
      try { onMessage(JSON.parse(ev.data)); }
      catch (e) { console.warn("ws bad msg", e); }
    });
  }

  function scheduleReopen() {
    const jitter = Math.random() * backoff;
    setTimeout(open, backoff + jitter);
    backoff = Math.min(backoff * 2, 10000);
  }

  open();

  return {
    stop() { stopped = true; if (ws) ws.close(); },
  };
}
