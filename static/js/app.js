/**
 * ping.me — front-end entry point.
 *
 * Wires together: i18n + theme + footer + WS + REST API + reactive store +
 * dashboard renderer + drill-down + editor.
 */
import { loadLang, initLangButtons, t } from "./i18n.js";
import { Store } from "./store.js";
import { connect as connectWS } from "./ws.js";
import { api } from "./api.js";
import {
  render as renderDashboard, renderLive, onHostEdit, onGroupSettings, setViewMode,
} from "./dashboard.js?v=hero-input-flow-5";
import { openAdd, openEdit } from "./editor.js";
import * as monitoring from "./monitoring.js?v=readymag-pitch-pages-5";
import { open as openGroupSettings } from "./group-settings.js";
import { refresh as refreshSuggestions } from "./suggestions.js";
import { initMotion, enhanceMotion } from "./motion.js";
import { initPingSettings } from "./ping-settings.js";
import { initDesignExamples } from "./design-examples.js?v=readymag-pitch-pages-5";

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

// ---- clock ------------------------------------------------------------------

function tickClock() {
  if (!document.getElementById("clock")) return;
  const d = new Date();
  document.getElementById("clock").textContent =
    d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
tickClock();
setInterval(tickClock, 1000);

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
      refreshSuggestions();
      break;
    case "host_deleted":
      Store.deleteHost(msg.host_id);
      refreshSuggestions();
      break;
    case "group_updated":
      Store.upsertGroup(msg.group);
      refreshSuggestions();
      break;
    case "group_cidrs_changed":
      refreshSuggestions();
      break;
    case "monitoring_state":
      monitoring.onWsState(msg);
      break;
    default:
      console.warn("ws: unknown message type", msg.type, msg);
  }
}

function onWsState(state) {
  const el = document.getElementById("ws-state");
  el.dataset.state = state;
  el.textContent = state === "connected" ? t("ws.connected") : t("ws.disconnected");
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
  await loadGroups();
  await loadHosts();
  await monitoring.init();
  await refreshSuggestions();
  setView(localStorage.getItem("netping.view") === "ip" ? "ip" : "groups");
  initPingSettings();
  initMotion();

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  connectWS({
    url: `${wsProto}://${location.host}/ws`,
    onMessage: onWsMessage,
    onState: onWsState,
  });
})();
