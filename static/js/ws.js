/**
 * WebSocket client with exponential-backoff reconnect + jitter.
 */
export function connect({ url, onMessage, onState }) {
  let ws = null;
  let backoff = 250;
  let stopped = false;
  let stableTimer = 0;

  function open() {
    onState("disconnected");
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      // Only reset the backoff once the connection has stayed open for a
      // while — an accept-then-drop loop must keep backing off, not hammer.
      stableTimer = setTimeout(() => {
        stableTimer = 0;
        backoff = 250;
      }, 3000);
      onState("connected");
    });
    ws.addEventListener("close", () => {
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = 0;
      }
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
