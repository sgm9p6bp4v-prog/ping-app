/**
 * Full-screen drill-down view for one host.
 */
import { Store } from "./store.js";
import { t } from "./i18n.js";
import { escapeHtml, escapeAttr } from "./util.js";

let panel = null;
let currentHostId = null;
let unsubscribe = null;

export function open(hostId) {
  const id = Number(hostId);
  if (!Number.isFinite(id)) return;
  const host = findHost(id);
  if (!host) return;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  currentHostId = host.id;
  if (!panel) panel = buildPanel();
  panel.style.display = "grid";
  fill(host);
  unsubscribe = Store.subscribe(() => {
    if (currentHostId !== host.id) return;
    // Host disappeared mid-drill → close the panel instead of leaving a stale title.
    if (!findHost(currentHostId)) {
      close();
      return;
    }
    refreshChart();
  });
  document.body.style.overflow = "hidden";
}

export function close() {
  if (panel) panel.style.display = "none";
  currentHostId = null;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  document.body.style.overflow = "";
  if (/^#host-\d+$/.test(window.location.hash)) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function buildPanel() {
  const el = document.createElement("section");
  el.className = "drill";
  el.innerHTML = `
    <button class="drill__back" id="drill-close" aria-label="${escapeAttr(t("drill.close"))}">←</button>
    <div class="drill__chrome drill__chrome--top-left">
      <span>Pitch Deck</span>
      <span>Momentum</span>
    </div>
    <div class="drill__chrome drill__chrome--top-right">
      <span>Problem</span>
      <span>Solution</span>
      <span>Team</span>
      <span>Raise</span>
      <span>Contact</span>
    </div>
    <div class="drill__chrome drill__chrome--bottom-left">
      <span>Data Flow</span>
    </div>
    <div class="drill__chrome drill__chrome--bottom-right">
      <span>2026</span>
    </div>
    <div class="drill__copy">
      <h1 class="drill__title" id="drill-title">—</h1>
      <p>${escapeHtml(t("drill.chart_title"))}</p>
    </div>
    <div class="drill__metric">
      <strong id="drill-last">—</strong>
      <span>Ping latency</span>
    </div>
    <div class="drill__bars" id="drill-bars" aria-label="Sixty seconds of latency"></div>
  `;
  document.body.appendChild(el);
  el.querySelector("#drill-close").addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (panel?.style.display === "grid" && ev.key === "Escape") close();
  });
  return el;
}

function fill(host) {
  panel.querySelector("#drill-title").textContent = host.name;
  refreshChart();
}

function refreshChart() {
  const entry = Store.samples.get(Number(currentHostId));
  const samples = (entry?.samples ?? []).slice(-60);
  const values = samples.map((s) => (s.success && s.rtt_ms != null ? s.rtt_ms : null));
  const max = Math.max(1, ...values.filter((v) => v != null && v > 0));
  const last = [...values].reverse().find((v) => v != null && v > 0);
  const bars = panel.querySelector("#drill-bars");
  const lastEl = panel.querySelector("#drill-last");
  lastEl.textContent = last == null ? "—" : `${last.toFixed(1)} ms`;
  bars.innerHTML = values.map((value) => {
    const height = value == null || value <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
    const label = value == null ? "timeout" : `${value.toFixed(1)} ms`;
    return `<span class="drill__bar" style="--bar-height:${height}%" title="${escapeAttr(label)}"></span>`;
  }).join("");
}

function findHost(hostId) {
  return Store.hosts.get(Number(hostId));
}
