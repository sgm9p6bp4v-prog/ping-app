/**
 * Monitoring lifecycle UI: START/STOP toggle.
 * The server boots PAUSED. Pressing START kicks off pinging for
 * the configured packet limit, then broadcasts state via WS.
 */
import { api } from "./api.js";
import { t } from "./i18n.js";
import { Store } from "./store.js";
import { getPacketLimit } from "./ping-settings.js";

const toggleEl = document.getElementById("monitoring-toggle");
const stateEl = document.getElementById("monitoring-state");
const countdownEl = document.getElementById("monitoring-countdown");

let state = { active: false, expires_at: null, duration_s: 1800 };
let tickerId = null;

export async function init() {
  try {
    state = await api.monitoring();
    render();
    if (state.active) startTicker();
  } catch (e) {
    console.warn("monitoring init failed", e);
  }
  toggleEl.addEventListener("click", onToggle);
}

export function onWsState(s) {
  const wasActive = state.active;
  state = s;
  render();
  if (state.active) startTicker();
  else stopTicker();
  if (!wasActive && state.active) emitMonitoringStarted();
  if (wasActive && !state.active) emitMonitoringStopped();
}

async function onToggle() {
  toggleEl.disabled = true;
  const wasActive = state.active;
  try {
    state = state.active
      ? await api.monitoringStop()
      : await api.monitoringStart({ packet_limit: getPacketLimit() });
    render();
    if (state.active) {
      startTicker();
      if (!wasActive) emitMonitoringStarted();
      const deck = document.getElementById("deck-main");
      if (deck) deck.dataset.page = "1";
    } else {
      stopTicker();
      if (wasActive) emitMonitoringStopped();
    }
  } catch (e) {
    console.warn("monitoring toggle failed", e);
  } finally {
    toggleEl.disabled = false;
  }
}

function emitMonitoringStarted() {
  window.dispatchEvent(new CustomEvent("pingme:monitoring-started"));
}

function emitMonitoringStopped() {
  window.dispatchEvent(new CustomEvent("pingme:monitoring-stopped", {
    detail: pingSuccessSnapshot(),
  }));
}

function pingSuccessSnapshot() {
  let sent = 0;
  let failed = 0;
  for (const entry of Store.samples.values()) {
    sent += entry.stats.sent;
    failed += entry.stats.failed;
  }
  const returned = sent - failed;
  const successPct = sent > 0 ? Math.round((returned / sent) * 100) : 100;
  return { sent, returned, failed, successPct };
}

function render() {
  if (state.active) {
    toggleEl.textContent = "STOP";
    toggleEl.dataset.state = "active";
    stateEl.textContent = t("monitor.active");
  } else {
    toggleEl.textContent = "START";
    toggleEl.dataset.state = "paused";
    stateEl.textContent = t("monitor.paused");
    countdownEl.textContent = "";
  }
}

function startTicker() {
  stopTicker();
  tickerId = setInterval(tick, 1000);
  tick();
}

function stopTicker() {
  if (tickerId !== null) { clearInterval(tickerId); tickerId = null; }
  countdownEl.textContent = "";
}

function tick() {
  if (!state.active || !state.expires_at) {
    countdownEl.textContent = "";
    return;
  }
  const remainingMs = new Date(state.expires_at).getTime() - Date.now();
  if (remainingMs <= 0) {
    countdownEl.textContent = "00:00";
    return;
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  countdownEl.textContent = `${m}:${s}`;
}
