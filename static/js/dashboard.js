/**
 * Render group dashboard + conversational hero from Store state.
 */
import { Store, SLOW_THRESHOLD_MS } from "./store.js";
import { t } from "./i18n.js";
import { api } from "./api.js";

const groupsEl = document.getElementById("groups");
const heroHostTargetEl = document.getElementById("hero-host-target");
const overallEl = document.getElementById("overall-status");
const metricActiveHostsEl = document.getElementById("metric-active-hosts");
const metricAvgRttEl = document.getElementById("metric-avg-rtt");
const metricPacketsTotalEl = document.getElementById("metric-packets-total");
const metricPacketsSentEl = document.getElementById("metric-packets-sent");
const metricPacketsReturnedEl = document.getElementById("metric-packets-returned");
const metricPacketsLostEl = document.getElementById("metric-packets-lost");
const metricStopPercentEl = document.getElementById("metric-stop-percent");

let onHostClickHandler = null;
export function onHostClick(handler) {
  onHostClickHandler = handler;
}

let onHostEditHandler = null;
export function onHostEdit(handler) {
  onHostEditHandler = handler;
}

let onGroupSettingsHandler = null;
export function onGroupSettings(handler) {
  onGroupSettingsHandler = handler;
}

let viewMode = "groups";  // 'groups' | 'ip'
export function setViewMode(mode) {
  viewMode = mode === "ip" ? "ip" : "groups";
}

export function render() {
  renderKpis();
  if (viewMode === "ip") renderIpList();
  else renderGroups();
}

export function renderLive() {
  renderKpis();
  updateHostCards();
}

function renderIpList() {
  const hosts = [...Store.hosts.values()].slice().sort(ipCompare);
  if (hosts.length === 0) {
    groupsEl.innerHTML = `<div class="empty-state">${t("groups.empty")}</div>`;
    return;
  }
  groupsEl.innerHTML = `
    <section class="group" data-group="__ip_view__">
      <header class="group__head">
        <span></span>
        <h2 class="group__name">${t("view.ip_title")}</h2>
        <div class="group__meta">${hosts.length}</div>
        <span></span>
      </header>
      <div class="host-grid">${hosts.map(hostCardHtml).join("")}</div>
    </section>
  `;
  attachHostCardHandlers();
}

function ipCompare(a, b) {
  // Sort IPv4 numerically; everything else lexicographically after IPs.
  const pa = parseIp(a.address), pb = parseIp(b.address);
  if (pa !== null && pb !== null) return pa - pb;
  if (pa !== null) return -1;
  if (pb !== null) return 1;
  return a.address.localeCompare(b.address);
}
function parseIp(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  const [_, a, b, c, d] = m;
  return ((+a) << 24 >>> 0) + ((+b) << 16) + ((+c) << 8) + (+d);
}

function renderKpis() {
  const c = Store.overallCounts();
  const firstHost = [...Store.hosts.values()][0];
  heroHostTargetEl.textContent = firstHost?.address ?? "no host yet";

  let status = "online";
  if (c.offline > 0 && c.offline === c.total) status = "offline";
  else if (c.offline > 0) status = "degraded";
  overallEl.dataset.status = status;
  overallEl.textContent = t(`header.${status}`);
  renderDashboardMetrics(c);
}

function renderDashboardMetrics(counts) {
  if (!metricActiveHostsEl) return;
  let sent = 0;
  let failed = 0;
  let rttSum = 0;
  let rttCount = 0;
  for (const entry of Store.samples.values()) {
    sent += entry.stats.sent;
    failed += entry.stats.failed;
    for (const sample of entry.samples) {
      if (sample.success && sample.rtt_ms != null) {
        rttSum += sample.rtt_ms;
        rttCount += 1;
      }
    }
  }
  const returned = sent - failed;
  const activePct = counts.total > 0 ? Math.round((counts.online / counts.total) * 100) : 0;
  metricActiveHostsEl.textContent = `${activePct}%`;
  metricAvgRttEl.textContent = rttCount > 0 ? `${(rttSum / rttCount).toFixed(1)} ms` : "-- ms";
  metricPacketsTotalEl.textContent = String(sent);
  metricPacketsSentEl.textContent = String(sent);
  metricPacketsReturnedEl.textContent = String(returned);
  metricPacketsLostEl.textContent = String(failed);
  if (metricStopPercentEl && !metricStopPercentEl.dataset.locked) {
    const successPct = sent > 0 ? Math.round((returned / sent) * 100) : 100;
    metricStopPercentEl.textContent = `${successPct}%`;
  }
}

window.addEventListener("pingme:monitoring-stopped", (event) => {
  if (!metricStopPercentEl) return;
  metricStopPercentEl.dataset.locked = "true";
  metricStopPercentEl.textContent = `${event.detail.successPct}%`;
});

function updateHostCards() {
  groupsEl.querySelectorAll("[data-host-id]").forEach((card) => {
    const host = Store.hosts.get(Number(card.dataset.hostId));
    if (!host) return;
    const entry = Store.samples.get(host.id);
    const status = entry?.status ?? "idle";
    const stats = entry?.stats;
    card.dataset.status = status;
    card.setAttribute(
      "aria-label",
      `${host.name} (${host.address}) — ${t(`host.status.${status}`)}`
    );
    const rtt = card.querySelector(".host-card__rtt");
    const statusEl = card.querySelector(".host-card__status");
    if (rtt) rtt.innerHTML = rttHtml(stats?.last, status);
    if (statusEl) statusEl.textContent = t(`host.status.${status}`);
  });

  groupsEl.querySelectorAll(".group[data-group]").forEach((section) => {
    const groupName = section.dataset.group;
    if (groupName === "__ip_view__") return;
    const hosts = Store.groupedHosts().find(([name]) => name === groupName)?.[1] ?? [];
    const gstate = Store.groupState(groupName);
    const online = hosts.filter((h) => statusOf(h.id) === "online" || statusOf(h.id) === "slow").length;
    const offline = hosts.filter((h) => statusOf(h.id) === "offline").length;
    const meta = section.querySelector(".group__meta");
    if (meta) {
      meta.textContent = `${hosts.length} · ${gstate.enabled ? `${online} ON · ${offline} OFF` : t("group.disabled")}`;
    }
  });
}

function renderGroups() {
  const grouped = Store.groupedHosts();
  if (grouped.length === 0) {
    groupsEl.innerHTML = `<div class="empty-state">${t("groups.empty")}</div>`;
    return;
  }
  const html = [];
  for (const [groupName, hosts] of grouped) {
    const gstate = Store.groupState(groupName);
    const collapsed = gstate.collapsed || !gstate.enabled; // disabled groups default to collapsed
    const online = hosts.filter((h) => statusOf(h.id) === "online" || statusOf(h.id) === "slow").length;
    const offline = hosts.filter((h) => statusOf(h.id) === "offline").length;
    const stateLabel = gstate.enabled ? `${online} ON · ${offline} OFF` : t("group.disabled");
    html.push(`
      <section class="group" data-group="${escapeAttr(groupName)}"
               data-enabled="${gstate.enabled}" data-collapsed="${collapsed}">
        <header class="group__head">
          <button class="group__collapse" data-group-action="collapse"
                  aria-label="${escapeAttr(t("group.collapse"))}"
                  aria-expanded="${!collapsed}">${collapsed ? "▶" : "▼"}</button>
          <h2 class="group__name">${escapeHtml(groupName)}</h2>
          <div class="group__meta">${hosts.length} · ${stateLabel}</div>
          <button class="group__toggle" data-group-action="toggle"
                  aria-pressed="${!gstate.enabled}"
                  title="${escapeAttr(gstate.enabled ? t("group.disable_hint") : t("group.enable_hint"))}">
            ${gstate.enabled ? t("group.disable") : t("group.enable")}
          </button>
          <button class="group__settings" data-group-action="settings"
                  aria-label="${escapeAttr(t("group.settings"))}"
                  title="${escapeAttr(t("group.settings"))}">⚙</button>
        </header>
        ${collapsed ? "" : `<div class="host-grid">${hosts.map(hostCardHtml).join("")}</div>`}
      </section>
    `);
  }
  groupsEl.innerHTML = html.join("");
  attachHostCardHandlers();
  groupsEl.querySelectorAll("[data-group-action]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const section = btn.closest(".group");
      const name = section.dataset.group;
      const action = btn.dataset.groupAction;
      const current = Store.groupState(name);
      try {
        if (action === "collapse") {
          await api.updateGroup(name, { collapsed: !current.collapsed });
        } else if (action === "toggle") {
          await api.updateGroup(name, { enabled: !current.enabled });
        } else if (action === "settings") {
          if (onGroupSettingsHandler) onGroupSettingsHandler(name);
        }
      } catch (e) {
        console.warn("group action failed", e);
      }
    });
  });
}

function attachHostCardHandlers() {
  groupsEl.querySelectorAll("[data-host-id]").forEach((el) => {
    const id = Number(el.dataset.hostId);
    const openDetail = (ev) => {
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
        if (onHostEditHandler) onHostEditHandler(id);
      } else if (onHostClickHandler) {
        onHostClickHandler(id);
      }
    };
    el.addEventListener("click", openDetail);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openDetail(ev);
      }
    });
  });
}

function hostCardHtml(host) {
  const entry = Store.samples.get(host.id);
  const status = entry?.status ?? "idle";
  const stats = entry?.stats;
  const last = stats?.last;
  const label = `${host.name} (${host.address}) — ${t(`host.status.${status}`)}`;
  return `
    <article class="host-card" data-status="${status}" data-host-id="${host.id}"
             role="button" tabindex="0"
             aria-label="${escapeAttr(label)}"
             title="Click: details · Shift+Click: edit">
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
