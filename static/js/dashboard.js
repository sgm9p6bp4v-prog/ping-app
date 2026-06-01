/**
 * Render group dashboard + conversational hero from Store state.
 */
import { Store, SLOW_THRESHOLD_MS } from "./store.js";
import { t } from "./i18n.js";
import { api } from "./api.js";
import { open as openDrill } from "./drilldown.js";

const groupsEl = document.getElementById("groups");
const overallEl = document.getElementById("overall-status");
const metricActiveHostsEl = document.getElementById("metric-active-hosts");
const metricAvgRttEl = document.getElementById("metric-avg-rtt");
const metricPacketsTotalEl = document.getElementById("metric-packets-total");
const metricPacketsSentEl = document.getElementById("metric-packets-sent");
const metricPacketsReturnedEl = document.getElementById("metric-packets-returned");
const metricPacketsLostEl = document.getElementById("metric-packets-lost");
const metricStopPercentEl = document.getElementById("metric-stop-percent");

let bubbleLayoutRaf = 0;
let bubblePhysicsFrame = 0;
let bubblePhysicsRunId = 0;
let bubblePhysicsItems = [];
let bubblePhysicsBounds = null;
let bubblePhysicsAttractor = null;
let bubbleFocusScrollFrame = 0;
let bubbleFocusScrollStartedAt = 0;
let bubbleFocusScrollFrom = 0;
let bubbleFocusScrollTo = 0;
let bubbleFocusScrollDuration = 0;
let bubbleFocusScrollTarget = null;
let groupTooltipTimer = 0;
let groupTooltipEl = null;

const HOST_DOT_SIZE = 30;
const HOST_DETAIL_SIZE = 68;
const HOST_GRID_GAP = 14;

const bubblePhysicsStats = {
  elapsedMs: 0,
  frames: 0,
  itemCount: 0,
  pairChecks: 0,
  estimatedPairChecksPerFrame: 0,
  profile: "",
  running: false,
};

if (typeof window !== "undefined") window.__pingMePhysicsStats = bubblePhysicsStats;

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

const deckMainEl = document.getElementById("deck-main");
if (deckMainEl) {
  new MutationObserver(() => {
    if (deckMainEl.dataset.page === "1" && groupsEl.dataset.layout === "bubbles") {
      scheduleBubblePhysics({ run: true, fromTop: true });
    }
  }).observe(deckMainEl, { attributes: true, attributeFilter: ["data-page"] });
}

document.getElementById("results-page")?.addEventListener("wheel", cancelBubbleFocusScroll, { passive: true });

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
    groupsEl.innerHTML = `<div class="empty-state">${t("groups.empty")}</div>`;
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
        <h2 class="group__name">${escapeHtml(t("view.ip_title"))}</h2>
      </header>
      <div class="host-grid host-grid--all">${hosts.map(hostCardHtml).join("")}</div>
    </section>
  `;
  attachHostCardHandlers();
  scheduleHostLabelNormalization();
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

  groupsEl.querySelectorAll(".group[data-group]").forEach((section) => {
    const groupName = section.dataset.group;
    if (groupName === "__ip_view__") return;
    const hosts = Store.groupedHosts().find(([name]) => name === groupName)?.[1] ?? [];
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
    groupsEl.innerHTML = `<div class="empty-state">${t("groups.empty")}</div>`;
    return;
  }
  const html = [];
  const packedGroups = packBubbleGroups(grouped);
  groupsEl.style.setProperty("--bubble-grid-rows", String(packedGroups.rows));
  for (const item of packedGroups.items) {
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
          <button class="group__collapse" data-group-action="collapse"
                  aria-label="${escapeAttr(t("group.collapse"))}"
                  aria-expanded="${!collapsed}">${collapsed ? "▶" : "▼"}</button>
          <h2 class="group__name" contenteditable="true" spellcheck="false"
              data-group-action="rename"
              aria-label="Rename group">${escapeHtml(groupName)}</h2>
          <div class="group__meta">${hosts.length} · ${stateLabel}</div>
          <button class="group__toggle" data-group-action="toggle"
                  aria-pressed="${!gstate.enabled}"
                  title="${escapeAttr(gstate.enabled ? t("group.disable_hint") : t("group.enable_hint"))}">
            ${gstate.enabled ? t("group.disable") : t("group.enable")}
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
  scheduleHostLabelNormalization();
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

window.addEventListener("resize", () => {
  if (groupsEl.dataset.layout === "bubbles") {
    scheduleBubblePhysics({ run: false, fromTop: false });
  }
});

function attachGroupNameHandlers() {
  groupsEl.querySelectorAll(".group__name[contenteditable]").forEach((el) => {
    el.dataset.originalName = el.textContent.trim();
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        el.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        el.textContent = el.dataset.originalName;
        el.blur();
      }
    });
    el.addEventListener("blur", async () => {
      const section = el.closest(".group");
      const oldName = section.dataset.group;
      const newName = el.textContent.trim();
      if (!newName || newName === oldName) {
        el.textContent = oldName;
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

function scheduleHostLabelNormalization() {
  queueMicrotask(normalizeHostLabels);
  requestAnimationFrame(normalizeHostLabels);
}

function normalizeHostLabels() {
  groupsEl.querySelectorAll(".host-card__name").forEach((el) => {
    if (!el.querySelector(".motion-char")) return;
    el.textContent = el.dataset.motionText || el.textContent;
    delete el.dataset.motionText;
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

function scheduleBubblePhysics({ run = true, fromTop = true } = {}) {
  if (bubbleLayoutRaf) cancelAnimationFrame(bubbleLayoutRaf);
  bubbleLayoutRaf = requestAnimationFrame(() => {
    bubbleLayoutRaf = 0;
    layoutBubblePhysics({ run, fromTop });
  });
}

function isResultsPageVisible() {
  return deckMainEl?.dataset.page === "1";
}

function layoutBubblePhysics({ run, fromTop }) {
  if (groupsEl.dataset.layout !== "bubbles") return;
  cancelBubblePhysics();
  cancelBubbleFocusScroll();
  const bubbles = [...groupsEl.querySelectorAll(":scope > .group")];
  if (bubbles.length === 0) return;

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  groupsEl.style.setProperty("--bubble-canvas-height", "100%");
  let rect = groupsEl.getBoundingClientRect();
  const visibleHeight = groupsEl.closest(".results-page")?.clientHeight || window.innerHeight;
  const styles = getComputedStyle(groupsEl);
  const padding = {
    left: cssPx(styles.paddingLeft),
    right: cssPx(styles.paddingRight),
    top: cssPx(styles.paddingTop),
    bottom: cssPx(styles.paddingBottom),
  };
  const usableWidth = Math.max(280, rect.width - padding.left - padding.right);
  const initialUsableHeight = Math.max(260, rect.height - padding.top - padding.bottom);
  const previewItems = createBubblePhysicsItems(bubbles, usableWidth, initialUsableHeight);
  const canvasHeight = estimateBubbleCanvasHeight(previewItems, usableWidth, visibleHeight, padding);
  groupsEl.style.setProperty("--bubble-canvas-height", `${canvasHeight}px`);
  groupsEl.dataset.overflow = String(canvasHeight > window.innerHeight + 4);
  rect = groupsEl.getBoundingClientRect();
  const usableHeight = Math.max(260, rect.height - padding.top - padding.bottom);
  const bounds = {
    left: padding.left,
    right: rect.width - padding.right,
    top: padding.top,
    bottom: rect.height - Math.min(padding.bottom, 28),
    attractorX: rect.width / 2,
    attractorY: rect.height / 2,
  };
  const items = createBubblePhysicsItems(bubbles, usableWidth, usableHeight);
  bubblePhysicsItems = items;
  bubblePhysicsBounds = bounds;
  bubblePhysicsAttractor = centerOf(bounds);
  bindBubblePhysicsInteractions(items);

  if (!run || reducedMotion) {
    placeBubblesAtRest(items, bounds);
    groupsEl.dataset.bubblePhysics = "settled";
    return;
  }

  groupsEl.dataset.bubblePhysics = "running";
  seedBubblePhysics(items, bounds, fromTop);
  startBubblePhysicsLoop({ minDuration: 2100, maxDuration: 6200 });
}

function cancelBubblePhysics() {
  bubblePhysicsRunId += 1;
  bubblePhysicsItems = [];
  bubblePhysicsBounds = null;
  bubblePhysicsAttractor = null;
  bubblePhysicsStats.running = false;
  if (bubblePhysicsFrame) {
    cancelAnimationFrame(bubblePhysicsFrame);
    bubblePhysicsFrame = 0;
  }
}

function startBubblePhysicsLoop({ minDuration = 1800, maxDuration = 7000 } = {}) {
  if (!bubblePhysicsItems.length || !bubblePhysicsBounds || !bubblePhysicsAttractor) return;
  if (bubblePhysicsFrame) cancelAnimationFrame(bubblePhysicsFrame);
  groupsEl.dataset.bubblePhysics = "running";
  animateBubblePhysics(bubblePhysicsItems, bubblePhysicsBounds, { minDuration, maxDuration });
}

function createBubblePhysicsItems(bubbles, usableWidth, usableHeight) {
  const maxHosts = Math.max(1, ...bubbles.map((el) => Number(el.dataset.count) || 1));
  const viewportMaxSize = Math.min(usableWidth * 0.58, usableHeight * 0.72, 720);
  const minSize = Math.min(viewportMaxSize, Math.max(96, Math.min(usableWidth, usableHeight) * 0.14));
  const items = bubbles.map((el, index) => {
    const hostCount = Number(el.dataset.count) || 1;
    const span = Number(el.dataset.bubbleSpan) || 2;
    const density = Math.sqrt(hostCount / maxHosts);
    const gridSize = (usableWidth / 12) * span * 1.08;
    const contentSize = minBubbleSizeForHosts(hostCount);
    const maxSize = Math.max(viewportMaxSize, contentSize);
    const size = clamp(minSize, Math.max(gridSize + density * 26, contentSize), maxSize);
    return {
      el,
      index,
      hostCount,
      size,
      r: size / 2,
      mass: Math.max(1, size * size),
      scale: 1,
      targetScale: 1,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    };
  });
  const areaLimit = usableWidth * usableHeight * 0.58;
  const area = items.reduce((sum, item) => sum + Math.PI * item.r * item.r, 0);
  if (area > areaLimit) {
    const scale = Math.sqrt(areaLimit / area);
    for (const item of items) {
      item.size = Math.max(minBubbleSizeForHosts(item.hostCount), item.size * scale);
      item.r = item.size / 2;
      item.mass = Math.max(1, item.size * item.size);
    }
  }
  for (const item of items) syncHostSizing(item);
  return items;
}

function estimateBubbleCanvasHeight(items, usableWidth, currentHeight, padding) {
  if (items.length === 0) return currentHeight;
  const totalArea = items.reduce((sum, item) => sum + Math.PI * item.r * item.r, 0);
  const tallest = Math.max(...items.map((item) => item.size));
  const areaHeight = (totalArea / Math.max(1, usableWidth)) * 2.05;
  const breathingRoom = tallest * 0.55 + padding.top + padding.bottom;
  return Math.ceil(Math.max(window.innerHeight, currentHeight, areaHeight + breathingRoom));
}

function hostGridShape(hostCount) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, hostCount))));
  return {
    cols,
    rows: Math.max(1, Math.ceil(Math.max(1, hostCount) / cols)),
  };
}

function minBubbleSizeForHosts(hostCount) {
  const { cols, rows } = hostGridShape(hostCount);
  const widthNeeded = (cols * HOST_DETAIL_SIZE + Math.max(0, cols - 1) * HOST_GRID_GAP) / 0.8;
  const heightNeeded = (rows * HOST_DETAIL_SIZE + Math.max(0, rows - 1) * HOST_GRID_GAP) / 0.48;
  return Math.max(widthNeeded, heightNeeded);
}

function syncHostSizing(item) {
  const hostCount = item.hostCount || Number(item.el.dataset.count) || 1;
  const { cols, rows } = hostGridShape(hostCount);
  const gap = HOST_GRID_GAP;
  const availableWidth = item.size * 0.8;
  const availableHeight = item.size * 0.52;
  const cellWidth = (availableWidth - Math.max(0, cols - 1) * gap) / cols;
  const cellHeight = (availableHeight - Math.max(0, rows - 1) * gap) / rows;
  const detailSize = Math.min(HOST_DETAIL_SIZE, Math.floor(Math.min(cellWidth, cellHeight)));
  item.el.style.setProperty("--host-cols", String(cols));
  item.el.style.setProperty("--host-gap", `${gap}px`);
  item.el.style.setProperty("--host-detail-size", `${detailSize}px`);
  item.el.style.setProperty("--host-dot-size", `${HOST_DOT_SIZE}px`);
  item.el.style.setProperty("--host-name-size", `${clamp(7, detailSize * 0.13, 13).toFixed(1)}px`);
  item.el.style.setProperty("--host-rtt-size", `${clamp(6, detailSize * 0.11, 12).toFixed(1)}px`);
  if (hostCount >= 8) {
    item.el.style.setProperty("--host-grid-top", "30%");
    item.el.style.setProperty("--host-grid-hover-top", "32%");
  } else if (hostCount >= 4) {
    item.el.style.setProperty("--host-grid-top", "36%");
    item.el.style.setProperty("--host-grid-hover-top", "38%");
  } else if (hostCount >= 2) {
    item.el.style.setProperty("--host-grid-top", "48%");
    item.el.style.setProperty("--host-grid-hover-top", "49%");
  } else {
    item.el.style.setProperty("--host-grid-top", "67%");
    item.el.style.setProperty("--host-grid-hover-top", "67%");
  }
  item.el.style.setProperty("--host-grid-bottom", "8%");
}

function seedBubblePhysics(items, bounds, fromEdges) {
  const center = centerOf(bounds);
  const spreadX = bounds.right - bounds.left;
  const spreadY = bounds.bottom - bounds.top;
  const directions = [
    [-0.95, -0.72], [-0.28, -1], [0.56, -0.92], [1, -0.08],
    [0.78, 0.78], [0.06, 1], [-0.82, 0.66], [-1, 0.12],
  ];
  items.forEach((item, index) => {
    const jitter = seededUnit(`${item.el.dataset.group}:${index}`) - 0.5;
    const radius = physicsRadius(item);
    const direction = directions[index % directions.length];
    const sideBias = fromEdges ? 1 : 0.56;
    const radialJitter = 0.42 + Math.abs(jitter) * 0.22;
    const startX = center.x + direction[0] * spreadX * sideBias * radialJitter;
    const startY = center.y + direction[1] * spreadY * sideBias * (0.42 + (0.5 - Math.abs(jitter)) * 0.18);
    item.x = clamp(bounds.left + radius, startX, bounds.right - radius);
    item.y = clamp(bounds.top + radius, startY, bounds.bottom - radius);

    const dx = center.x - item.x;
    const dy = center.y - item.y;
    const distance = Math.hypot(dx, dy) || 1;
    const speed = 4.5 + (index % 4) * 0.7;
    item.vx = (dx / distance) * speed + jitter * 1.8;
    item.vy = (dy / distance) * speed - jitter * 1.2;
    applyBubblePosition(item);
  });
}

function animateBubblePhysics(items, bounds, { minDuration, maxDuration }) {
  const runId = bubblePhysicsRunId;
  const startedAt = performance.now();
  let lastTime = startedAt;
  const profile = bubblePhysicsProfile(items.length);
  const pairCount = (items.length * Math.max(0, items.length - 1)) / 2;
  let pairChecks = 0;
  let frames = 0;

  Object.assign(bubblePhysicsStats, {
    elapsedMs: 0,
    frames: 0,
    itemCount: items.length,
    pairChecks: 0,
    estimatedPairChecksPerFrame: pairCount * profile.substeps * profile.collisionIterations,
    profile: profile.name,
    running: true,
  });
  publishBubblePhysicsStats();

  function frame(now) {
    if (runId !== bubblePhysicsRunId) return;
    frames += 1;
    const dt = clamp(0.5, (now - lastTime) / 16.67, 2);
    lastTime = now;

    for (let substep = 0; substep < profile.substeps; substep += 1) {
      integrateBubbles(items, bounds, dt / profile.substeps);
      for (let iteration = 0; iteration < profile.collisionIterations; iteration += 1) {
        resolveBubbleCollisions(items);
        pairChecks += pairCount;
        resolveBubbleWalls(items, bounds);
      }
    }

    let maxMotion = 0;
    let maxScaleDelta = 0;
    for (const item of items) {
      item.scale += (item.targetScale - item.scale) * 0.18;
      maxScaleDelta = Math.max(maxScaleDelta, Math.abs(item.targetScale - item.scale));
      item.vx *= 0.968;
      item.vy *= 0.968;
      if (Math.abs(item.vx) < 0.025) item.vx = 0;
      if (Math.abs(item.vy) < 0.025) item.vy = 0;
      maxMotion = Math.max(maxMotion, Math.abs(item.vx) + Math.abs(item.vy));
      applyBubblePosition(item);
    }

    const elapsed = now - startedAt;
    Object.assign(bubblePhysicsStats, {
      elapsedMs: Math.round(elapsed),
      frames,
      pairChecks,
      running: true,
    });

    if (elapsed < maxDuration && (elapsed < minDuration || maxMotion > profile.motionThreshold || maxScaleDelta > 0.004)) {
      bubblePhysicsFrame = requestAnimationFrame(frame);
      return;
    }

    for (let i = 0; i < profile.settleSteps; i += 1) {
      integrateBubbles(items, bounds, 0.25);
      resolveBubbleCollisions(items);
      pairChecks += pairCount;
      resolveBubbleWalls(items, bounds);
      for (const item of items) {
        item.vx *= 0.72;
        item.vy *= 0.72;
      }
    }
    for (const item of items) {
      item.vx = 0;
      item.vy = 0;
      item.scale = item.targetScale;
      applyBubblePosition(item);
    }
    groupsEl.dataset.bubblePhysics = "settled";
    Object.assign(bubblePhysicsStats, {
      elapsedMs: Math.round(performance.now() - startedAt),
      frames,
      pairChecks,
      running: false,
    });
    publishBubblePhysicsStats();
    bubblePhysicsFrame = 0;
  }

  bubblePhysicsFrame = requestAnimationFrame(frame);
}

function bubblePhysicsProfile(count) {
  if (count >= 24) {
    return {
      name: "dense",
      substeps: 1,
      collisionIterations: 3,
      settleSteps: 82,
      motionThreshold: 0.1,
    };
  }
  if (count >= 14) {
    return {
      name: "medium",
      substeps: 1,
      collisionIterations: 3,
      settleSteps: 96,
      motionThreshold: 0.1,
    };
  }
  return {
    name: "light",
    substeps: 2,
    collisionIterations: 3,
    settleSteps: 120,
    motionThreshold: 0.07,
  };
}

function publishBubblePhysicsStats() {
  groupsEl.dataset.physicsProfile = bubblePhysicsStats.profile;
  groupsEl.dataset.physicsItems = String(bubblePhysicsStats.itemCount);
  groupsEl.dataset.physicsFrames = String(bubblePhysicsStats.frames);
  groupsEl.dataset.physicsPairChecks = String(bubblePhysicsStats.pairChecks);
  groupsEl.dataset.physicsElapsed = String(bubblePhysicsStats.elapsedMs);
  groupsEl.dataset.physicsPairChecksPerFrame = String(bubblePhysicsStats.estimatedPairChecksPerFrame);
  groupsEl.dataset.physicsRunning = String(bubblePhysicsStats.running);
}

function integrateBubbles(items, bounds, dt) {
  const center = bubblePhysicsAttractor ?? centerOf(bounds);
  for (const item of items) {
    const dx = center.x - item.x;
    const dy = center.y - item.y;
    const distance = Math.hypot(dx, dy) || 1;
    const pull = clamp(0.04, distance * 0.0022, 0.72);
    item.vx += (dx / distance) * pull * dt;
    item.vy += (dy / distance) * pull * dt;
    item.x += item.vx * dt;
    item.y += item.vy * dt;
  }
}

function resolveBubbleWalls(items, bounds) {
  const restitution = 0.18;
  for (const item of items) {
    const radius = physicsRadius(item);
    if (item.x - radius < bounds.left) {
      item.x = bounds.left + radius;
      if (item.vx < 0) item.vx = -item.vx * restitution;
    } else if (item.x + radius > bounds.right) {
      item.x = bounds.right - radius;
      if (item.vx > 0) item.vx = -item.vx * restitution;
    }
    if (item.y - radius < bounds.top) {
      item.y = bounds.top + radius;
      if (item.vy < 0) item.vy = -item.vy * restitution;
    } else if (item.y + radius > bounds.bottom) {
      item.y = bounds.bottom - radius;
      if (item.vy > 0) item.vy = -item.vy * restitution;
    }
  }
}

function resolveBubbleCollisions(items) {
  const restitution = 0.08;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDistance = physicsRadius(a) + physicsRadius(b) + 8;
      let distSq = dx * dx + dy * dy;
      if (distSq >= minDistance * minDistance) continue;
      if (distSq < 0.0001) distSq = 0.0001;
      const distance = Math.sqrt(distSq);
      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = minDistance - distance;
      const invA = 1 / a.mass;
      const invB = 1 / b.mass;
      const invTotal = invA + invB;
      const correction = (Math.max(0, overlap - 0.35) / invTotal) * 0.66;
      a.x -= nx * correction * invA;
      a.y -= ny * correction * invA;
      b.x += nx * correction * invB;
      b.y += ny * correction * invB;

      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal > 0) continue;
      const impulse = (-(1 + restitution) * velAlongNormal) / invTotal;
      a.vx -= impulse * nx * invA;
      a.vy -= impulse * ny * invA;
      b.vx += impulse * nx * invB;
      b.vy += impulse * ny * invB;
    }
  }
}

function placeBubblesAtRest(items, bounds) {
  bubblePhysicsAttractor = centerOf(bounds);
  seedBubblePhysics(items, bounds, false);
  for (let i = 0; i < 260; i += 1) {
    integrateBubbles(items, bounds, 1);
    for (let j = 0; j < 5; j += 1) {
      resolveBubbleCollisions(items);
      resolveBubbleWalls(items, bounds);
    }
    for (const item of items) {
      item.vx *= 0.9;
      item.vy *= 0.9;
    }
  }
  for (const item of items) {
    item.vx = 0;
    item.vy = 0;
    applyBubblePosition(item);
  }
}

function applyBubblePosition(item) {
  item.el.style.setProperty("--bubble-left", `${Math.round(item.x - item.r)}px`);
  item.el.style.setProperty("--bubble-top", `${Math.round(item.y - item.r)}px`);
  item.el.style.setProperty("--bubble-size", `${Math.round(item.size)}px`);
  item.el.style.setProperty("--bubble-scale", item.scale.toFixed(3));
}

function bindBubblePhysicsInteractions(items) {
  for (const item of items) {
    const el = item.el;
    if (el.dataset.bubblePointerBound === "true") continue;
    el.dataset.bubblePointerBound = "true";
    el.addEventListener("pointerenter", () => {
      const current = bubblePhysicsItems.find((candidate) => candidate.el === el);
      if (!current) return;
      current.targetScale = 1.18;
      el.classList.add("is-expanded");
      nudgeBubblesFrom(current, bubblePhysicsItems, 2.8);
      scrollBubbleIntoFocus(el);
      startBubblePhysicsLoop({ minDuration: 420, maxDuration: 1600 });
    });
    el.addEventListener("pointerleave", () => {
      const current = bubblePhysicsItems.find((candidate) => candidate.el === el);
      if (!current) return;
      current.targetScale = 1;
      el.classList.remove("is-expanded");
      cancelBubbleFocusScroll();
      startBubblePhysicsLoop({ minDuration: 360, maxDuration: 1300 });
    });
  }
}

function scrollBubbleIntoFocus(el) {
  const scroller = el.closest(".results-page");
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  const focusTop = scrollerRect.top + scrollerRect.height * 0.28;
  const focusBottom = scrollerRect.bottom - scrollerRect.height * 0.28;
  if (centerY >= focusTop && centerY <= focusBottom) return;

  const focusCenter = scrollerRect.top + scrollerRect.height * 0.5;
  const delta = (centerY - focusCenter) * 0.42;
  const maxStep = Math.max(140, scrollerRect.height * 0.26);
  const target = clamp(
    0,
    scroller.scrollTop + clamp(-maxStep, delta, maxStep),
    scroller.scrollHeight - scroller.clientHeight,
  );
  const distance = Math.abs(target - scroller.scrollTop);
  if (distance < 16) return;
  animateBubbleFocusScroll(scroller, target, 950 + Math.min(850, distance * 1.4));
}

function animateBubbleFocusScroll(scroller, target, duration) {
  cancelBubbleFocusScroll();
  bubbleFocusScrollTarget = scroller;
  bubbleFocusScrollStartedAt = performance.now();
  bubbleFocusScrollFrom = scroller.scrollTop;
  bubbleFocusScrollTo = target;
  bubbleFocusScrollDuration = duration;

  function step(now) {
    if (!bubbleFocusScrollTarget) return;
    const elapsed = now - bubbleFocusScrollStartedAt;
    const progress = clamp(0, elapsed / bubbleFocusScrollDuration, 1);
    const eased = easeInOutCubic(progress);
    bubbleFocusScrollTarget.scrollTop = bubbleFocusScrollFrom + (bubbleFocusScrollTo - bubbleFocusScrollFrom) * eased;
    if (progress < 1) {
      bubbleFocusScrollFrame = requestAnimationFrame(step);
    } else {
      cancelBubbleFocusScroll();
    }
  }

  bubbleFocusScrollFrame = requestAnimationFrame(step);
}

function cancelBubbleFocusScroll() {
  if (bubbleFocusScrollFrame) {
    cancelAnimationFrame(bubbleFocusScrollFrame);
    bubbleFocusScrollFrame = 0;
  }
  bubbleFocusScrollTarget = null;
}

function easeInOutCubic(value) {
  return value < 0.5 ? 4 * value * value * value : 1 - ((-2 * value + 2) ** 3) / 2;
}

function nudgeBubblesFrom(source, items, force) {
  const sourceRadius = physicsRadius(source) * 1.22;
  for (const item of items) {
    if (item === source) continue;
    const dx = item.x - source.x;
    const dy = item.y - source.y;
    const distance = Math.hypot(dx, dy) || 1;
    const influence = sourceRadius + physicsRadius(item) + 84;
    if (distance > influence) continue;
    const strength = ((influence - distance) / influence) * force;
    item.vx += (dx / distance) * strength;
    item.vy += (dy / distance) * strength;
  }
}

function physicsRadius(item) {
  return item.r * item.scale;
}

function centerOf(bounds) {
  return {
    x: Number.isFinite(bounds.attractorX) ? bounds.attractorX : (bounds.left + bounds.right) / 2,
    y: Number.isFinite(bounds.attractorY) ? bounds.attractorY : (bounds.top + bounds.bottom) / 2,
  };
}

function seededUnit(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function cssPx(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(min, value, max) {
  return Math.min(max, Math.max(min, value));
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
