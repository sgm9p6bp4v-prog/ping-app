import { api } from "./api.js";
import { Store } from "./store.js";

const INTERVAL_KEY = "pingme.interval.v4";
const PACKETS_KEY = "pingme.packets.v4";
const PACKET_INFINITY = "∞";
const PACKET_MAX = 1000;
let applyingInterval = null;

export function getPingDefaults() {
  return {
    interval: clampNumber(localStorage.getItem(INTERVAL_KEY), 1, 0.2, 60),
    packets: parsePacketLimit(localStorage.getItem(PACKETS_KEY)),
  };
}

export function getPacketLimit() {
  const input = document.getElementById("hero-packets");
  return parsePacketLimit(input?.value ?? localStorage.getItem(PACKETS_KEY));
}

export function initPingSettings() {
  const intervalInput = document.getElementById("hero-interval");
  const packetsInput = document.getElementById("hero-packets");
  if (!intervalInput || !packetsInput) return;

  const defaults = { interval: 1, packets: 1 };
  intervalInput.value = defaults.interval;
  packetsInput.value = defaults.packets;
  localStorage.setItem(INTERVAL_KEY, defaults.interval);
  localStorage.setItem(PACKETS_KEY, defaults.packets);
  fitHeroInput(intervalInput);
  fitHeroInput(packetsInput);

  intervalInput.addEventListener("input", () => {
    localStorage.setItem(INTERVAL_KEY, intervalInput.value);
    fitHeroInput(intervalInput);
  });
  intervalInput.addEventListener("change", () => applyIntervalToHosts(intervalInput));
  intervalInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      intervalInput.blur();
    }
  });
  packetsInput.addEventListener("input", () => {
    if (packetsInput.value.trim() === "") {
      packetsInput.value = PACKET_INFINITY;
      packetsInput.select();
    }
    localStorage.setItem(PACKETS_KEY, packetsInput.value);
    fitHeroInput(packetsInput);
  });
  packetsInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      packetsInput.blur();
    }
  });
  intervalInput.addEventListener("blur", () => {
    intervalInput.value = clampNumber(intervalInput.value, 1, 0.2, 60);
    localStorage.setItem(INTERVAL_KEY, intervalInput.value);
    fitHeroInput(intervalInput);
    applyIntervalToHosts(intervalInput);
  });
  packetsInput.addEventListener("blur", () => {
    packetsInput.value = formatPacketLimit(packetsInput.value);
    localStorage.setItem(PACKETS_KEY, packetsInput.value);
    fitHeroInput(packetsInput);
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
  fitHeroInput(input);
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

function fitHeroInput(input) {
  const value = String(input.value || input.placeholder || "1");
  input.style.setProperty("--input-ch", String(Math.max(1, value.length)));
}

function parsePacketLimit(value) {
  const formatted = formatPacketLimit(value);
  return formatted === PACKET_INFINITY ? null : Number(formatted);
}

function formatPacketLimit(value) {
  const raw = String(value ?? "").trim();
  if (
    raw === ""
    || raw === PACKET_INFINITY
    || raw.toLowerCase() === "inf"
    || raw.toLowerCase() === "infinity"
  ) {
    return PACKET_INFINITY;
  }
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return PACKET_INFINITY;
  return String(Math.round(Math.min(PACKET_MAX, Math.max(1, n))));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
