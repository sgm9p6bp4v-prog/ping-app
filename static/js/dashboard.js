/**
 * Render group dashboard + KPI hero from Store state.
 */
import { Store, SLOW_THRESHOLD_MS } from "./store.js";
import { t } from "./i18n.js";

const groupsEl = document.getElementById("groups");
const heroOnlineEl = document.getElementById("hero-online");
const kpiHostsEl = document.getElementById("kpi-hosts");
const kpiOnlineEl = document.getElementById("kpi-online");
const kpiOfflineEl = document.getElementById("kpi-offline");
const kpiLossEl = document.getElementById("kpi-loss");
const overallEl = document.getElementById("overall-status");

let onHostClickHandler = null;
export function onHostClick(handler) {
  onHostClickHandler = handler;
}

let onHostEditHandler = null;
export function onHostEdit(handler) {
  onHostEditHandler = handler;
}

export function render() {
  renderKpis();
  renderGroups();
}

function renderKpis() {
  const c = Store.overallCounts();
  heroOnlineEl.innerHTML = `${c.online}<small>/${c.total}</small>`;
  kpiHostsEl.textContent = c.total;
  kpiOnlineEl.textContent = c.online;
  kpiOfflineEl.textContent = c.offline;
  kpiLossEl.textContent = `${c.loss.toFixed(1)}%`;

  let status = "online";
  if (c.offline > 0 && c.offline === c.total) status = "offline";
  else if (c.offline > 0) status = "degraded";
  overallEl.dataset.status = status;
  overallEl.textContent = t(`header.${status}`);
}

function renderGroups() {
  const grouped = Store.groupedHosts();
  if (grouped.length === 0) {
    groupsEl.innerHTML = `<div class="empty-state">${t("groups.empty")}</div>`;
    return;
  }
  const html = [];
  for (const [groupName, hosts] of grouped) {
    const online = hosts.filter((h) => statusOf(h.id) === "online" || statusOf(h.id) === "slow").length;
    const offline = hosts.filter((h) => statusOf(h.id) === "offline").length;
    html.push(`
      <section class="group" data-group="${escapeAttr(groupName)}">
        <header class="group__head">
          <h2 class="group__name">${escapeHtml(groupName)}</h2>
          <div class="group__meta">${hosts.length} · ${online} ON · ${offline} OFF</div>
        </header>
        <div class="host-grid">
          ${hosts.map(hostCardHtml).join("")}
        </div>
      </section>
    `);
  }
  groupsEl.innerHTML = html.join("");
  groupsEl.querySelectorAll("[data-host-id]").forEach((el) => {
    const id = Number(el.dataset.hostId);
    el.addEventListener("click", (ev) => {
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
        if (onHostEditHandler) onHostEditHandler(id);
      } else if (onHostClickHandler) {
        onHostClickHandler(id);
      }
    });
  });
}

function hostCardHtml(host) {
  const entry = Store.samples.get(host.id);
  const status = entry?.status ?? "idle";
  const stats = entry?.stats;
  const last = stats?.last;
  return `
    <article class="host-card" data-status="${status}" data-host-id="${host.id}" title="Click: details · Shift+Click: edit">
      <div class="host-card__name">${escapeHtml(host.name)}</div>
      <div class="host-card__addr">${escapeHtml(host.address)}</div>
      <div class="host-card__rtt">${rttHtml(last, status)}</div>
      <div class="host-card__status">${t(`host.status.${status}`)}</div>
    </article>
  `;
}

function rttHtml(rtt, status) {
  if (rtt == null) return "—";
  const v = rtt.toFixed(1);
  const unit = `<small style="font-size:0.5em;color:var(--muted);margin-left:4px;">ms</small>`;
  return `${v}${unit}`;
}

function statusOf(id) {
  return Store.samples.get(id)?.status ?? "idle";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
