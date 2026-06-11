/**
 * Render group dashboard + conversational hero from Store state.
 * Bubble layout physics lives in bubble-physics.js.
 */
import { Store, SLOW_THRESHOLD_MS } from "./store.js";
import { t } from "./i18n.js";
import { api } from "./api.js";
import { open as openDrill } from "./drilldown.js";
import { escapeHtml, escapeAttr, clamp } from "./util.js";
import {
  scheduleBubblePhysics, isResultsPageVisible, hostGridShape,
  HOST_DOT_SIZE, HOST_DETAIL_SIZE, HOST_GRID_GAP,
} from "./bubble-physics.js";

const groupsEl = document.getElementById("groups");
const overallEl = document.getElementById("overall-status");
const heroStartControlEl = document.getElementById("hero-start-control");
const metricActiveHostsEl = document.getElementById("metric-active-hosts");
const metricAvgRttEl = document.getElementById("metric-avg-rtt");
const metricPacketsTotalEl = document.getElementById("metric-packets-total");
const metricPacketsSentEl = document.getElementById("metric-packets-sent");
const metricPacketsReturnedEl = document.getElementById("metric-packets-returned");
const metricPacketsLostEl = document.getElementById("metric-packets-lost");
const metricStopPercentEl = document.getElementById("metric-stop-percent");

let groupTooltipTimer = 0;
let groupTooltipEl = null;

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

document.addEventListener("click", (ev) => {
  const card = ev.target.closest?.("[data-host-id]");
  if (!card || !groupsEl.contains(card)) return;
  openHostCard(card, ev);
}, true);

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const card = ev.target.closest?.("[data-host-id]");
  if (!card || !groupsEl.contains(card)) return;
  ev.preventDefault();
  openHostCard(card, ev);
}, true);

window.addEventListener("hashchange", () => {
  const match = /^#host-(\d+)$/.exec(location.hash);
  if (match) openDrill(Number(match[1]));
});

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
  groupsEl.dataset.layout = "bubbles";
  groupsEl.dataset.bubblePhysics = "idle";
  const hosts = [...Store.hosts.values()].slice().sort(ipCompare);
  if (hosts.length === 0) {
    groupsEl.innerHTML = `<div class="empty-state">${escapeHtml(t("groups.empty"))}</div>`;
    return;
  }
  const style = groupBubbleStyle({
    col: 4,
    row: 1,
    span: 6,
    hostCount: hosts.length,
    maxHosts: hosts.length,
    index: 0,
  });
  groupsEl.style.setProperty("--bubble-grid-rows", "6");
  groupsEl.innerHTML = `
    <section class="group group--all" data-group="__ip_view__"
             data-count="${hosts.length}" data-bubble-span="6" style="${style}">
      <header class="group__head">
        ${groupTitleArcHtml(t("view.ip_title"), "ip-view", 6)}
        <h2 class="group__name">${escapeHtml(t("view.ip_title"))}</h2>
      </header>
      <div class="host-grid host-grid--all">${hosts.map(hostCardHtml).join("")}</div>
    </section>
  `;
  attachHostCardHandlers();
  scheduleBubblePhysics({ run: isResultsPageVisible(), fromTop: isResultsPageVisible() });
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

  let status = "online";
  if (c.offline > 0 && c.offline === c.total) status = "offline";
  else if (c.offline > 0) status = "degraded";
  if (overallEl) {
    overallEl.dataset.status = status;
    overallEl.textContent = t(`header.${status}`);
  }
  if (heroStartControlEl) {
    heroStartControlEl.dataset.status = status;
    heroStartControlEl.setAttribute("aria-label", `Network status: ${t(`header.${status}`)}`);
  }
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

window.addEventListener("pingme:monitoring-started", () => {
  if (metricStopPercentEl) delete metricStopPercentEl.dataset.locked;
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

  const grouped = Store.groupedHosts();
  groupsEl.querySelectorAll(".group[data-group]").forEach((section) => {
    const groupName = section.dataset.group;
    if (groupName === "__ip_view__") return;
    const hosts = grouped.find(([name]) => name === groupName)?.[1] ?? [];
    const gstate = Store.groupState(groupName);
    const online = hosts.filter((h) => statusOf(h.id) === "online" || statusOf(h.id) === "slow").length;
    const offline = hosts.filter((h) => statusOf(h.id) === "offline").length;
    section.dataset.enabled = String(gstate.enabled);
    section.dataset.collapsed = String(gstate.collapsed);
    delete section.dataset.pending;
    const meta = section.querySelector(".group__meta");
    if (meta) {
      meta.textContent = `${hosts.length} · ${gstate.enabled ? `${online} ON · ${offline} OFF` : t("group.disabled")}`;
    }
    const toggle = section.querySelector('[data-group-action="toggle"]');
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(!gstate.enabled));
      toggle.setAttribute("title", gstate.enabled ? t("group.disable_hint") : t("group.enable_hint"));
      toggle.textContent = gstate.enabled ? t("group.disable") : t("group.enable");
    }
  });
}

function renderGroups() {
  groupsEl.dataset.layout = "bubbles";
  groupsEl.dataset.bubblePhysics = "idle";
  const grouped = Store.groupedHosts();
  if (grouped.length === 0) {
    groupsEl.innerHTML = `<div class="empty-state">${escapeHtml(t("groups.empty"))}</div>`;
    return;
  }
  const html = [];
  const packedGroups = packBubbleGroups(grouped);
  groupsEl.style.setProperty("--bubble-grid-rows", String(packedGroups.rows));
  for (let titleIndex = 0; titleIndex < packedGroups.items.length; titleIndex += 1) {
    const item = packedGroups.items[titleIndex];
    const { groupName, hosts, style } = item;
    const gstate = Store.groupState(groupName);
    const collapsed = gstate.collapsed;
    const online = hosts.filter((h) => statusOf(h.id) === "online" || statusOf(h.id) === "slow").length;
    const offline = hosts.filter((h) => statusOf(h.id) === "offline").length;
    const stateLabel = gstate.enabled ? `${online} ON · ${offline} OFF` : t("group.disabled");
    html.push(`
      <section class="group" data-group="${escapeAttr(groupName)}"
               data-enabled="${gstate.enabled}" data-collapsed="${collapsed}"
               data-count="${hosts.length}" data-bubble-span="${item.span}"
               data-tooltip="${escapeAttr(t("group.context_hint"))}"
               style="${style}">
        <header class="group__head">
          ${groupTitleArcHtml(groupName, `group-${titleIndex}`, item.span)}
          <button class="group__collapse" data-group-action="collapse"
                  aria-label="${escapeAttr(t("group.collapse"))}"
                  aria-expanded="${!collapsed}">${collapsed ? "▶" : "▼"}</button>
          <h2 class="group__name" contenteditable="true" spellcheck="false"
              data-group-action="rename"
              aria-label="Rename group">${escapeHtml(groupName)}</h2>
          <div class="group__meta">${hosts.length} · ${escapeHtml(stateLabel)}</div>
          <button class="group__toggle" data-group-action="toggle"
                  aria-pressed="${!gstate.enabled}"
                  title="${escapeAttr(gstate.enabled ? t("group.disable_hint") : t("group.enable_hint"))}">
            ${escapeHtml(gstate.enabled ? t("group.disable") : t("group.enable"))}
          </button>
          <button class="group__delete" data-group-action="delete"
                  aria-label="Delete group"
                  title="Delete group">+</button>
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
  attachGroupNameHandlers();
  attachGroupContextHandlers();
  attachGroupTooltipHandlers();
  scheduleBubblePhysics({ run: isResultsPageVisible(), fromTop: isResultsPageVisible() });
  groupsEl.querySelectorAll("[data-group-action]").forEach((btn) => {
    if (btn.dataset.groupAction === "rename") return;
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
          const updated = await api.updateGroup(name, { enabled: !current.enabled });
          Store.upsertGroup(updated);
        } else if (action === "delete") {
          const count = section.querySelectorAll("[data-host-id]").length;
          const msg = t("group.delete_confirm")
            .replace("{name}", () => name)
            .replace("{count}", () => String(count));
          const ok = confirm(msg);
          if (!ok) return;
          await api.deleteGroup(name);
          Store.deleteGroup(name);
        } else if (action === "settings") {
          if (onGroupSettingsHandler) onGroupSettingsHandler(name);
        }
      } catch (e) {
        console.warn("group action failed", e);
      }
    });
  });
}

function groupTitleArcHtml(groupName, idSeed, span) {
  const pathId = `group-title-curve-${idSeed}`;
  return `
    <svg class="group__title-arc" viewBox="0 0 240 240"
         data-group-title-display="true" aria-hidden="true" focusable="false">
      <path class="group__title-path" id="${escapeAttr(pathId)}"
            d="M 38 170 A 96 96 0 1 1 202 170"></path>
      <text class="group__title-text" style="${groupTitleStyle(groupName, span)}"${groupTitleLengthAttrs(groupName, span)}>
        <textPath class="group__title-text-path" href="#${escapeAttr(pathId)}"
                  startOffset="50%" text-anchor="middle">${escapeHtml(groupName)}</textPath>
      </text>
    </svg>
  `;
}

function groupTitleStyle(groupName, span) {
  const length = groupName.trim().replace(/\s+/g, " ").length;
  const base = 8 + span * 4.2;
  const boost = length >= 34 ? span * 6 : length >= 22 ? span * 3.2 : length >= 14 ? span * 1.1 : 0;
  const size = Math.round(clamp(13, base + boost, 62));
  const spacing = length >= 34 ? "-0.015em" : length >= 20 ? "0" : "0.01em";
  return `--group-title-size:${size}px;--group-title-spacing:${spacing}`;
}

function groupTitleLengthAttrs(groupName, span) {
  const target = groupTitleTextLength(groupName, span);
  return target ? ` textLength="${target}" lengthAdjust="spacingAndGlyphs"` : "";
}

function groupTitleTextLength(groupName, span) {
  const length = groupName.trim().replace(/\s+/g, " ").length;
  const threshold = span >= 4 ? 18 : 18;
  if (length <= threshold) return null;
  const maxLength = span >= 4 ? 430 : span >= 3 ? 300 : 170;
  if (length > threshold + 28) return maxLength;
  if (length > threshold + 16) return Math.round(maxLength * 0.82);
  if (length > threshold + 8) return Math.round(maxLength * 0.68);
  return Math.round(maxLength * 0.55);
}

function syncGroupTitleDisplay(el) {
  const section = el.closest(".group");
  const titlePath = section?.querySelector(".group__title-text-path");
  const titleText = section?.querySelector(".group__title-text");
  if (!section || !titlePath || !titleText) return;
  const title = el.textContent.trim() || section.dataset.group;
  titlePath.textContent = title;
  const target = groupTitleTextLength(title, Number(section.dataset.bubbleSpan) || 2);
  titleText.setAttribute("style", groupTitleStyle(title, Number(section.dataset.bubbleSpan) || 2));
  if (target) {
    titleText.setAttribute("textLength", String(target));
    titleText.setAttribute("lengthAdjust", "spacingAndGlyphs");
  } else {
    titleText.removeAttribute("textLength");
    titleText.removeAttribute("lengthAdjust");
  }
}

function selectEditableText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusGroupName(section) {
  const name = section?.querySelector(".group__name[contenteditable]");
  if (!section || !name) return;
  section.classList.add("is-editing");
  name.focus();
  selectEditableText(name);
}

function attachGroupNameHandlers() {
  groupsEl.querySelectorAll(".group[data-group]").forEach((section) => {
    section.addEventListener("click", (ev) => {
      if (ev.target.closest?.("[data-host-id], button, .host-card")) return;
      const rect = section.getBoundingClientRect();
      if (ev.clientY - rect.top > rect.height * 0.34) return;
      ev.stopPropagation();
      focusGroupName(section);
    });
  });

  groupsEl.querySelectorAll("[data-group-title-display]").forEach((display) => {
    display.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const section = display.closest(".group");
      focusGroupName(section);
    });
  });

  groupsEl.querySelectorAll(".group__name[contenteditable]").forEach((el) => {
    el.dataset.originalName = el.textContent.trim();
    el.addEventListener("focus", () => {
      el.closest(".group")?.classList.add("is-editing");
    });
    el.addEventListener("input", () => syncGroupTitleDisplay(el));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        el.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        el.textContent = el.dataset.originalName;
        syncGroupTitleDisplay(el);
        el.blur();
      }
    });
    el.addEventListener("blur", async () => {
      const section = el.closest(".group");
      section?.classList.remove("is-editing");
      const oldName = section.dataset.group;
      const newName = el.textContent.trim();
      if (!newName || newName === oldName) {
        el.textContent = oldName;
        syncGroupTitleDisplay(el);
        return;
      }
      try {
        const renamed = await api.updateGroup(oldName, { name: newName });
        if (renamed.name !== newName) {
          throw new Error("Server needs reload before group rename is available");
        }
        const [hosts, groups] = await Promise.all([api.listHosts(), api.listGroups()]);
        Store.setHosts(hosts);
        Store.setGroups(groups);
      } catch (e) {
        console.warn("group rename failed", e);
        el.textContent = oldName;
        syncGroupTitleDisplay(el);
        alert(e.message || "Could not rename group");
      }
    });
  });
}

function attachGroupContextHandlers() {
  groupsEl.querySelectorAll(".group[data-group]").forEach((section) => {
    if (section.dataset.group === "__ip_view__") return;
    section.addEventListener("contextmenu", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const name = section.dataset.group;
      const current = Store.groupState(name);
      section.dataset.pending = "true";
      try {
        const updated = await api.updateGroup(name, { enabled: !current.enabled });
        Store.upsertGroup(updated);
      } catch (e) {
        console.warn("group context toggle failed", e);
        delete section.dataset.pending;
      }
    });
  });
}

function ensureGroupTooltip() {
  if (groupTooltipEl) return groupTooltipEl;
  groupTooltipEl = document.createElement("div");
  groupTooltipEl.className = "bubble-tooltip";
  groupTooltipEl.hidden = true;
  document.body.append(groupTooltipEl);
  return groupTooltipEl;
}

function hideGroupTooltip() {
  if (groupTooltipTimer) {
    clearTimeout(groupTooltipTimer);
    groupTooltipTimer = 0;
  }
  if (groupTooltipEl) groupTooltipEl.hidden = true;
}

function positionGroupTooltip(section) {
  const tooltip = ensureGroupTooltip();
  tooltip.textContent = section.dataset.tooltip || t("group.context_hint");
  tooltip.dataset.theme = section.dataset.enabled === "false" ? "light" : "dark";
  tooltip.hidden = false;

  requestAnimationFrame(() => {
    const rect = section.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const gap = 10;
    const left = clamp(12, rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 12);
    let top = rect.top - tipRect.height - gap;
    if (top < 12) top = Math.min(window.innerHeight - tipRect.height - 12, rect.bottom + gap);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  });
}

function attachGroupTooltipHandlers() {
  hideGroupTooltip();
  groupsEl.querySelectorAll(".group[data-group]").forEach((section) => {
    if (section.dataset.group === "__ip_view__") return;
    section.addEventListener("pointerenter", () => {
      hideGroupTooltip();
      groupTooltipTimer = window.setTimeout(() => {
        groupTooltipTimer = 0;
        positionGroupTooltip(section);
      }, 1000);
    });
    section.addEventListener("pointerleave", hideGroupTooltip);
    section.addEventListener("focusout", hideGroupTooltip);
  });
}

function attachHostCardHandlers() {
  groupsEl.querySelectorAll("[data-host-id]").forEach((el) => {
    el.setAttribute("role", "button");
  });
}

function openHostCard(card, ev) {
  const id = Number(card.dataset.hostId);
  if (!Number.isFinite(id)) return;
  ev.preventDefault();
  if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
    if (onHostEditHandler) onHostEditHandler(id);
  } else if (onHostClickHandler) {
    onHostClickHandler(id);
  } else {
    openDrill(id);
  }
}

function hostCardHtml(host) {
  const entry = Store.samples.get(host.id);
  const status = entry?.status ?? "idle";
  const last = entry?.stats?.last;
  const label = `${host.name} (${host.address}) — ${t(`host.status.${status}`)}`;
  return `
    <a class="host-card" data-status="${status}" data-host-id="${host.id}"
             href="#host-${host.id}" role="button"
             aria-label="${escapeAttr(label)}"
             title="Click: details · Shift+Click: edit">
      <span class="host-card__detail">
        <span class="host-card__name">${escapeHtml(host.name)}</span>
        <span class="host-card__rtt">${rttHtml(last, status)}</span>
      </span>
    </a>
  `;
}

function packBubbleGroups(grouped) {
  const maxHosts = Math.max(1, ...grouped.map(([, hosts]) => hosts.length));
  const items = grouped
    .map(([groupName, hosts], index) => ({
      groupName,
      hosts,
      index,
      span: bubbleSpan(hosts.length, maxHosts),
    }))
    .sort((a, b) => (
      b.span - a.span
      || b.hosts.length - a.hosts.length
      || a.groupName.localeCompare(b.groupName)
    ));

  const columns = 12;
  const occupied = [];
  const placed = [];

  for (const item of items) {
    const candidates = [
      ...preferredBubblePlacements(item.span),
      ...allBubblePlacements(item.span, columns),
    ];
    const slot = candidates.find(([col, row]) => bubbleSlotFits(occupied, col, row, item.span, columns));
    const [col, row] = slot ?? [1, Math.max(1, occupied.length + 1)];
    occupyBubbleSlot(occupied, col, row, item.span);
    placed.push({
      ...item,
      col,
      row,
      style: groupBubbleStyle({
        col,
        row,
        span: item.span,
        hostCount: item.hosts.length,
        maxHosts,
        index: placed.length,
      }),
    });
  }

  const rows = Math.max(6, ...placed.map((item) => item.row + item.span - 1));
  return { items: placed, rows };
}

function bubbleSpan(hostCount, maxHosts) {
  const relativeArea = Math.sqrt(hostCount / Math.max(1, maxHosts));
  return Math.max(2, Math.min(4, Math.round(relativeArea * 4)));
}

function preferredBubblePlacements(span) {
  const bySpan = {
    4: [[3, 1], [7, 3], [1, 1], [5, 1], [1, 3], [9, 1]],
    3: [[7, 1], [10, 1], [1, 3], [5, 4], [9, 4], [1, 1]],
    2: [[1, 1], [1, 3], [7, 1], [9, 1], [11, 1], [7, 3], [11, 3], [1, 5], [3, 5], [5, 5], [10, 5]],
    1: [[10, 5], [11, 5], [10, 6], [12, 5], [11, 6], [12, 6]],
  };
  return bySpan[span] ?? [];
}

function allBubblePlacements(span, columns) {
  const placements = [];
  for (let row = 1; row <= 24; row += 1) {
    for (let col = 1; col <= columns - span + 1; col += 1) {
      placements.push([col, row]);
    }
  }
  return placements;
}

function bubbleSlotFits(occupied, col, row, span, columns) {
  if (col < 1 || col + span - 1 > columns) return false;
  for (let y = row; y < row + span; y += 1) {
    for (let x = col; x < col + span; x += 1) {
      if (occupied[y]?.[x]) return false;
    }
  }
  return true;
}

function occupyBubbleSlot(occupied, col, row, span) {
  for (let y = row; y < row + span; y += 1) {
    occupied[y] ??= [];
    for (let x = col; x < col + span; x += 1) {
      occupied[y][x] = true;
    }
  }
}

function groupBubbleStyle({ col, row, span, hostCount, maxHosts, index }) {
  const density = Math.sqrt(hostCount / Math.max(1, maxHosts));
  const { cols: hostCols } = hostGridShape(hostCount);
  const titleSize = Math.round(Math.max(14, Math.min(40, 10 + span * 5)));
  const mobileSize = span * 130;
  return [
    `--bubble-col:${col}`,
    `--bubble-row:${row}`,
    `--bubble-span:${span}`,
    `--bubble-left:50%`,
    `--bubble-top:50%`,
    `--bubble-size:${span * 120}px`,
    `--bubble-sway:${index % 2 === 0 ? 28 : -28}px`,
    `--bubble-delay:${index * 70}ms`,
    `--bubble-title-size:${titleSize}px`,
    `--bubble-mobile-size:${mobileSize}px`,
    `--host-cols:${hostCols}`,
    `--host-gap:${HOST_GRID_GAP}px`,
    `--host-dot-size:${HOST_DOT_SIZE}px`,
    `--host-detail-size:${HOST_DETAIL_SIZE}px`,
  ].join(";");
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
