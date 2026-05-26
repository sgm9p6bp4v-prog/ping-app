/**
 * NetPing — front-end entry point.
 *
 * Wires together: i18n + theme + footer + WS + REST API + reactive store +
 * dashboard renderer + drill-down + editor.
 */
import { loadLang, initLangButtons, t } from "./i18n.js";
import { Store } from "./store.js";
import { connect as connectWS } from "./ws.js";
import { api } from "./api.js";
import { render as renderDashboard, onHostClick, onHostEdit } from "./dashboard.js";
import { open as openDrill } from "./drilldown.js";
import { openAdd, openEdit } from "./editor.js";

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

// ---- clock ------------------------------------------------------------------

function tickClock() {
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
    document.getElementById("server-info").textContent = `${i.hostname} · ${i.lan_ip}`;
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
      break;
    case "host_deleted":
      Store.deleteHost(msg.host_id);
      break;
  }
}

function onWsState(state) {
  const el = document.getElementById("ws-state");
  el.dataset.state = state;
  el.textContent = state === "connected" ? t("ws.connected") : t("ws.disconnected");
}

// ---- click handlers ---------------------------------------------------------

onHostClick((id) => openDrill(id));
onHostEdit((id) => openEdit(id));
document.getElementById("fab-add").addEventListener("click", openAdd);

// ---- subscribe dashboard re-render -----------------------------------------

Store.subscribe(() => renderDashboard());

// ---- bootstrap --------------------------------------------------------------

(async () => {
  const lang = localStorage.getItem("netping.lang") ?? "en";
  await loadLang(lang);
  initLangButtons(() => {
    // re-render with new strings
    onWsState(document.getElementById("ws-state").dataset.state ?? "disconnected");
    renderDashboard();
  });
  document.getElementById(`lang-${lang}`)?.setAttribute("aria-pressed", "true");
  document.querySelectorAll("[id^=lang-]").forEach((b) =>
    b.setAttribute("aria-pressed", b.id === `lang-${lang}` ? "true" : "false")
  );

  await refreshServerInfo();
  await loadHosts();
  renderDashboard();

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  connectWS({
    url: `${wsProto}://${location.host}/ws`,
    onMessage: onWsMessage,
    onState: onWsState,
  });
})();
