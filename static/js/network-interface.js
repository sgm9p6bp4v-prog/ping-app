import { api } from "./api.js";
import { escapeHtml, escapeAttr } from "./util.js";

const triggerEl = document.getElementById("hero-interface-trigger");
const labelEl = document.getElementById("hero-host-target");
const menuEl = document.getElementById("hero-interface-menu");

let snapshot = null;

export async function initNetworkInterface() {
  if (!triggerEl || !labelEl || !menuEl) return;
  triggerEl.addEventListener("click", () => setOpen(!isOpen()));
  triggerEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      setOpen(!isOpen());
    } else if (ev.key === "Escape") {
      setOpen(false);
    }
  });
  document.addEventListener("click", (ev) => {
    if (!triggerEl.contains(ev.target) && !menuEl.contains(ev.target)) setOpen(false);
  });
  await refreshNetworkInterface();
}

export async function refreshNetworkInterface() {
  if (!triggerEl || !labelEl || !menuEl) return;
  try {
    snapshot = await api.networkInterfaces();
    renderNetworkInterface();
  } catch (err) {
    console.warn("network interface refresh failed", err);
    labelEl.textContent = "interface unavailable";
  }
}

function renderNetworkInterface() {
  if (!snapshot) return;
  labelEl.textContent = heroLabel(snapshot);
  triggerEl.title = "Change ping interface";
  menuEl.innerHTML = snapshot.interfaces.map(optionHtml).join("");
  menuEl.querySelectorAll("[data-interface-name]").forEach((option) => {
    option.addEventListener("click", async () => {
      await chooseInterface(option.dataset.interfaceName);
    });
  });
}

async function chooseInterface(name) {
  if (!name) return;
  setBusy(true);
  try {
    snapshot = await api.updateNetworkInterface(name);
    renderNetworkInterface();
    setOpen(false);
  } catch (err) {
    console.warn("network interface update failed", err);
  } finally {
    setBusy(false);
  }
}

function setOpen(open) {
  triggerEl.setAttribute("aria-expanded", open ? "true" : "false");
  menuEl.hidden = !open;
}

function isOpen() {
  return triggerEl.getAttribute("aria-expanded") === "true";
}

function setBusy(busy) {
  triggerEl.disabled = busy;
  triggerEl.setAttribute("aria-busy", busy ? "true" : "false");
}

function heroLabel(data) {
  const selected = data.selected ?? "auto";
  const selectedOption = data.interfaces.find((item) => item.name === selected);
  if (selected === "auto") {
    return selectedOption?.label ?? "auto";
  }
  return selectedOption?.label ?? data.active?.label ?? selected;
}

function optionHtml(item) {
  const selected = item.name === snapshot.selected;
  const active = item.name === snapshot.active?.name;
  const tags = [
    selected ? "selected" : "",
    active && item.name !== "auto" ? "active" : "",
  ].filter(Boolean).join(" · ");
  return `
    <button class="hero__interface-option" type="button" role="option"
            aria-selected="${selected}" data-interface-name="${escapeAttr(item.name)}">
      <span>${escapeHtml(item.label)}</span>
      ${tags ? `<small>${escapeHtml(tags)}</small>` : ""}
    </button>
  `;
}
