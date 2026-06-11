/**
 * ping.me — front-end entry point.
 *
 * Wires together: i18n + theme + footer + WS + REST API + reactive store +
 * dashboard renderer + drill-down + editor.
 *
 * Cache busting happens ONLY here (the ?v= on the <script> tag in index.html).
 * Inter-module imports must stay suffix-free, otherwise the browser
 * instantiates the same module twice with separate state.
 */
import { loadLang, initLangButtons, t } from "./i18n.js";
import { Store } from "./store.js";
import { connect as connectWS } from "./ws.js";
import { api } from "./api.js";
import {
  render as renderDashboard, renderLive, onHostEdit, onGroupSettings, setViewMode,
} from "./dashboard.js";
import { openAdd, openEdit } from "./editor.js";
import { open as openDrill } from "./drilldown.js";
import * as monitoring from "./monitoring.js";
import { open as openGroupSettings } from "./group-settings.js";
import { refresh as refreshSuggestions } from "./suggestions.js";
import { initMotion, enhanceMotion } from "./motion.js";
import { initPingSettings } from "./ping-settings.js";
import { initDesignExamples } from "./design-examples.js";
import { initNetworkInterface } from "./network-interface.js";

// ---- theme ------------------------------------------------------------------

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("netping.theme", theme);
  document.getElementById("theme-light").setAttribute("aria-pressed", theme === "light");
  document.getElementById("theme-dark").setAttribute("aria-pressed", theme === "dark");
}
document.getElementById("theme-light").addEventListener("click", () => setTheme("light"));
document.getElementById("theme-dark").addEventListener("click", () => setTheme("dark"));
setTheme(localStorage.getItem("netping.theme") ?? "light");
initDesignExamples();

// ---- footer / server info ---------------------------------------------------

async function refreshServerInfo() {
  try {
    const i = await api.info();
    document.getElementById("footer-host").textContent = `${i.hostname} (${i.lan_ip})`;
    document.getElementById("footer-version").textContent = i.version;
    const serverInfo = document.getElementById("server-info");
    if (serverInfo) serverInfo.textContent = `${i.hostname} · ${i.lan_ip}`;
    Store.serverInfo = i;
  } catch (e) {
    document.getElementById("footer-host").textContent = "—";
  }
}

// ---- initial host snapshot --------------------------------------------------

async function loadHosts() {
  try {
    const hosts = await api.listHosts();
    Store.setHosts(hosts);
  } catch (e) {
    console.warn("loadHosts failed", e);
  }
}

async function loadGroups() {
  try {
    const groups = await api.listGroups();
    Store.setGroups(groups);
  } catch (e) {
    console.warn("loadGroups failed", e);
  }
}

// ---- suggestions (debounced) ------------------------------------------------

// Bulk host updates (e.g. interval apply across N hosts) fire one WS message
// per host; coalesce the refetches into a single trailing GET.
let suggestionsTimer = 0;
function scheduleSuggestionsRefresh() {
  clearTimeout(suggestionsTimer);
  suggestionsTimer = setTimeout(() => {
    suggestionsTimer = 0;
    refreshSuggestions();
  }, 400);
}

// ---- WebSocket --------------------------------------------------------------

function onWsMessage(msg) {
  switch (msg.type) {
    case "snapshot":
      Store.setHosts(msg.hosts);
      break;
    case "sample":
      Store.addSample(msg);
      break;
    case "host_created":
    case "host_updated":
      Store.upsertHost(msg.host);
      scheduleSuggestionsRefresh();
      break;
    case "host_deleted":
      Store.deleteHost(msg.host_id);
      scheduleSuggestionsRefresh();
      break;
    case "group_updated":
      Store.upsertGroup(msg.group);
      scheduleSuggestionsRefresh();
      break;
    case "group_renamed":
      loadHosts();
      loadGroups();
      scheduleSuggestionsRefresh();
      break;
    case "group_deleted":
      Store.deleteGroup(msg.name);
      scheduleSuggestionsRefresh();
      break;
    case "group_cidrs_changed":
      scheduleSuggestionsRefresh();
      break;
    case "monitoring_state":
      monitoring.onWsState(msg);
      break;
    default:
      console.warn("ws: unknown message type", msg.type, msg);
  }
}

// On reconnect the server only pushes a host snapshot; group_* and
// monitoring_state events missed during the outage are gone. Re-fetch that
// state explicitly on every disconnected→connected transition after the first.
let wsEverConnected = false;
let lastWsState = null;
function onWsState(state) {
  const el = document.getElementById("ws-state");
  el.dataset.state = state;
  el.textContent = state === "connected" ? t("ws.connected") : t("ws.disconnected");
  if (state === "connected" && lastWsState === "disconnected") {
    if (wsEverConnected) {
      loadGroups();
      refreshSuggestions();
      monitoring.resync();
    }
    wsEverConnected = true;
  }
  lastWsState = state;
}

// ---- click handlers ---------------------------------------------------------

onHostEdit((id) => openEdit(id));
onGroupSettings((name) => openGroupSettings(name));
document.getElementById("fab-add").addEventListener("click", openAdd);

// ---- View toggle ------------------------------------------------------------

function setView(mode) {
  setViewMode(mode);
  document.getElementById("view-groups").setAttribute("aria-pressed", mode === "groups");
  document.getElementById("view-ip").setAttribute("aria-pressed", mode === "ip");
  localStorage.setItem("netping.view", mode);
  renderDashboard();
  enhanceMotion();
}
document.getElementById("view-groups").addEventListener("click", () => setView("groups"));
document.getElementById("view-ip").addEventListener("click", () => setView("ip"));

// ---- subscribe dashboard re-render -----------------------------------------

// Coalesce renders to one per animation frame; at 254 hosts x 1 Hz the naive
// per-sample render burned through ~250 full innerHTML rebuilds per second.
let renderPending = false;
let pendingReason = "sample";
Store.subscribe((reason = "sample") => {
  if (reason === "structure") pendingReason = "structure";
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (pendingReason === "structure") {
      renderDashboard();
      enhanceMotion();
    } else {
      renderLive();
    }
    pendingReason = "sample";
  });
});

// ---- bootstrap --------------------------------------------------------------

(async () => {
  // A partial bootstrap failure must not leave a dead dashboard:
  // always connect the WS at the end, even if a setup step threw.
  try {
    const lang = localStorage.getItem("netping.lang") ?? "en";
    await loadLang(lang);
    initLangButtons(() => {
      // re-render with new strings
      onWsState(document.getElementById("ws-state").dataset.state ?? "disconnected");
      renderDashboard();
      enhanceMotion();
    });
    document.getElementById(`lang-${lang}`)?.setAttribute("aria-pressed", "true");
    document.querySelectorAll("[id^=lang-]").forEach((b) =>
      b.setAttribute("aria-pressed", b.id === `lang-${lang}` ? "true" : "false")
    );

    await refreshServerInfo();
    await initNetworkInterface();
    await loadGroups();
    await loadHosts();
    const initialHostMatch = /^#host-(\d+)$/.exec(window.location.hash);
    if (initialHostMatch) openDrill(Number(initialHostMatch[1]));
    await monitoring.init();
    await refreshSuggestions();
    setView(localStorage.getItem("netping.view") === "ip" ? "ip" : "groups");
    initPingSettings();
    initMotion();
  } catch (e) {
    console.error("bootstrap failed (continuing with WS connect)", e);
  }

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  connectWS({
    url: `${wsProto}://${location.host}/ws`,
    onMessage: onWsMessage,
    onState: onWsState,
  });
})();
