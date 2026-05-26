/**
 * Full-screen drill-down view: 60s chart + recent events for one host.
 * Chart.js is global (vendored UMD).
 */
import { Store } from "./store.js";
import { t } from "./i18n.js";
import { api } from "./api.js";

let panel = null;
let chart = null;
let currentHostId = null;
let unsubscribe = null;

export function open(hostId) {
  const host = Store.hosts.get(hostId);
  if (!host) return;
  currentHostId = hostId;
  if (!panel) panel = buildPanel();
  panel.style.display = "grid";
  fill(host);
  unsubscribe = Store.subscribe(() => {
    if (currentHostId === hostId) refreshChart();
  });
  document.body.style.overflow = "hidden";
}

export function close() {
  if (panel) panel.style.display = "none";
  currentHostId = null;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (chart) { chart.destroy(); chart = null; }
  document.body.style.overflow = "";
}

function buildPanel() {
  const el = document.createElement("section");
  el.className = "drill";
  el.innerHTML = `
    <header class="drill__head">
      <h1 class="drill__title" id="drill-title">—</h1>
      <button id="drill-close" data-i18n="drill.close">Close</button>
    </header>
    <div class="drill__body">
      <div class="drill__section">
        <h2 data-i18n="drill.chart_title">Sixty seconds of latency.</h2>
        <div class="drill__chart-wrapper">
          <canvas id="drill-chart"></canvas>
        </div>
      </div>
      <div class="drill__section">
        <h2 data-i18n="drill.events_title">Recent events.</h2>
        <div class="events" id="drill-events"></div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector("#drill-close").addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (panel?.style.display === "grid" && ev.key === "Escape") close();
  });
  return el;
}

function fill(host) {
  panel.querySelector("#drill-title").innerHTML =
    `${escapeHtml(host.name)} <small>${escapeHtml(host.address)}</small>`;
  refreshChart();
  refreshEvents();
}

function refreshChart() {
  const entry = Store.samples.get(currentHostId);
  const samples = entry?.samples ?? [];
  const labels = samples.map((s) => s.ts.slice(11, 19));
  const data = samples.map((s) => (s.success ? s.rtt_ms : null));

  const canvas = panel.querySelector("#drill-chart");
  if (!chart) {
    const cssFg = getCssVar("--fg");
    const cssMuted = getCssVar("--muted");
    const cssHairline = getCssVar("--hairline");
    chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data,
          borderColor: cssFg,
          backgroundColor: "transparent",
          borderWidth: 1.5,
          tension: 0,
          pointRadius: 0,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
        scales: {
          x: { ticks: { color: cssMuted, font: { family: "Inter" } }, grid: { color: cssHairline } },
          y: { ticks: { color: cssMuted, font: { family: "Inter" } }, grid: { color: cssHairline }, beginAtZero: true },
        },
      },
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update("none");
  }
}

async function refreshEvents() {
  const wrap = panel.querySelector("#drill-events");
  try {
    const evs = await api.events({ host_id: currentHostId, limit: 50 });
    if (!evs.length) {
      wrap.innerHTML = `<div class="empty-state">${t("drill.no_events")}</div>`;
      return;
    }
    wrap.innerHTML = evs.map((e) => `
      <div class="event">
        <div class="event__ts">${escapeHtml(e.ts.slice(11, 19))}</div>
        <div class="event__type">${escapeHtml(e.type)}</div>
        <div class="event__msg">${escapeHtml(e.message ?? "")}</div>
      </div>
    `).join("");
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
