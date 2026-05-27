import { api } from "./api.js";
import { Store } from "./store.js";

const INTERVAL_KEY = "pingme.interval";
const PACKETS_KEY = "pingme.packets";
let applyingInterval = null;

export function getPingDefaults() {
  return {
    interval: clampNumber(localStorage.getItem(INTERVAL_KEY), 1, 0.2, 60),
    packets: clampNumber(localStorage.getItem(PACKETS_KEY), 1, 1, 10),
  };
}

export function initPingSettings() {
  const intervalInput = document.getElementById("hero-interval");
  const packetsInput = document.getElementById("hero-packets");
  if (!intervalInput || !packetsInput) return;

  const defaults = getPingDefaults();
  intervalInput.value = defaults.interval;
  packetsInput.value = defaults.packets;

  intervalInput.addEventListener("input", () => {
    localStorage.setItem(INTERVAL_KEY, intervalInput.value);
  });
  intervalInput.addEventListener("change", () => applyIntervalToHosts(intervalInput));
  intervalInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      intervalInput.blur();
    }
  });
  packetsInput.addEventListener("input", () => {
    localStorage.setItem(PACKETS_KEY, packetsInput.value);
  });
  intervalInput.addEventListener("blur", () => {
    intervalInput.value = clampNumber(intervalInput.value, 1, 0.2, 60);
    localStorage.setItem(INTERVAL_KEY, intervalInput.value);
    applyIntervalToHosts(intervalInput);
  });
  packetsInput.addEventListener("blur", () => {
    packetsInput.value = Math.round(clampNumber(packetsInput.value, 1, 1, 10));
    localStorage.setItem(PACKETS_KEY, packetsInput.value);
  });

  applyIntervalToHosts(intervalInput);
}

async function applyIntervalToHosts(input) {
  if (applyingInterval) {
    try { await applyingInterval; } catch (_) {}
  }
  const interval = clampNumber(input.value, 1, 0.2, 60);
  input.value = interval;
  localStorage.setItem(INTERVAL_KEY, interval);
  const hosts = [...Store.hosts.values()].filter((host) => host.interval_s !== interval);
  if (hosts.length === 0) return;
  input.disabled = true;
  applyingInterval = Promise.all(
    hosts.map((host) => api.updateHost(host.id, { interval_s: interval }))
  );
  try {
    await applyingInterval;
  } catch (e) {
    console.warn("failed to apply ping interval", e);
  } finally {
    applyingInterval = null;
    input.disabled = false;
  }
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
