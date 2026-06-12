/**
 * Client-side reactive store. Hosts + per-host rolling sample buffers.
 * Subscribers (dashboard, drill, kpi) re-render via `subscribe(fn)`.
 */
const MAX_SAMPLES_PER_HOST = 120;
const SLOW_THRESHOLD_MS = 100;
const OFFLINE_FAIL_STREAK = 3;

export const Store = {
  hosts: new Map(), // host_id -> host (full record)
  samples: new Map(), // host_id -> { samples: [], stats: {...}, status: "online"|"slow"|"offline"|"idle" }
  groups: new Map(), // name -> { name, enabled, collapsed }
  serverInfo: null,
  networkInterface: null,
  listeners: new Set(),

  setHosts(list) {
    this.hosts.clear();
    for (const h of list) this.hosts.set(h.id, h);
    for (const id of this.samples.keys()) {
      if (!this.hosts.has(id)) this.samples.delete(id);
    }
    this.notify("structure");
  },

  setGroups(list) {
    this.groups.clear();
    for (const g of list) this.groups.set(g.name, g);
    this.notify("structure");
  },

  upsertGroup(g, reason = "group") {
    // Structure-affecting fields (e.g. collapsed) add/remove DOM that only a
    // structure render rebuilds — a plain "group" (live) notify is a no-op.
    // Escalate mechanically on ANY field change so the next structural group
    // field cannot silently miss a re-render; identical payloads (WS echo of
    // a no-op PATCH) stay on the cheap path.
    const prev = this.groups.get(g.name);
    if (!prev || groupChanged(prev, g)) reason = "structure";
    this.groups.set(g.name, g);
    this.notify(reason);
  },

  deleteGroup(name) {
    this.groups.delete(name);
    for (const [id, host] of this.hosts) {
      if (host.group_name === name) {
        this.hosts.delete(id);
        this.samples.delete(id);
      }
    }
    this.notify("structure");
  },

  groupState(name) {
    return this.groups.get(name) ?? { name, enabled: true, collapsed: false };
  },

  upsertHost(h) {
    this.hosts.set(h.id, h);
    this.notify("structure");
  },

  deleteHost(id) {
    this.hosts.delete(id);
    this.samples.delete(id);
    this.notify("structure");
  },

  addSample(s) {
    let entry = this.samples.get(s.host_id);
    if (!entry) {
      entry = { samples: [], stats: emptyStats(), status: "idle" };
      this.samples.set(s.host_id, entry);
    }
    entry.samples.push(s);
    if (entry.samples.length > MAX_SAMPLES_PER_HOST) entry.samples.shift();
    entry.stats = recomputeStats(entry.samples);
    entry.status = deriveStatus(entry.samples);
    this.notify("sample");
  },

  groupedHosts() {
    const groups = new Map();
    for (const host of this.hosts.values()) {
      const g = host.group_name || "default";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(host);
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  },

  overallCounts() {
    let online = 0, offline = 0, total = 0;
    let lossNumer = 0, lossDenom = 0;
    for (const id of this.hosts.keys()) {
      total += 1;
      const e = this.samples.get(id);
      if (!e) { offline += 0; continue; }
      if (e.status === "online" || e.status === "slow") online += 1;
      if (e.status === "offline") offline += 1;
      lossNumer += e.stats.failed;
      lossDenom += e.stats.sent;
    }
    return {
      total,
      online,
      offline,
      loss: lossDenom > 0 ? (lossNumer / lossDenom) * 100 : 0,
    };
  },

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  notify(reason = "change") {
    for (const fn of this.listeners) fn(reason);
  },
};

function emptyStats() {
  return { last: null, avg: null, min: null, max: null, sent: 0, failed: 0, lossPct: 0 };
}

function recomputeStats(samples) {
  const rtts = samples.filter((s) => s.success && s.rtt_ms != null).map((s) => s.rtt_ms);
  const sent = samples.length;
  const failed = samples.filter((s) => !s.success).length;
  return {
    last: samples.length ? samples[samples.length - 1].rtt_ms : null,
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    min: rtts.length ? Math.min(...rtts) : null,
    max: rtts.length ? Math.max(...rtts) : null,
    sent,
    failed,
    lossPct: sent > 0 ? (failed / sent) * 100 : 0,
  };
}

// Pure derivation from the sample buffer — no dependence on previously
// derived state, so the status for a given buffer is always the same.
function deriveStatus(samples) {
  if (samples.length === 0) return "idle";
  let streak = 0;
  for (let i = samples.length - 1; i >= 0 && !samples[i].success; i--) streak += 1;
  if (streak >= OFFLINE_FAIL_STREAK) return "offline";
  // Below the offline threshold a lost packet keeps the status implied by the
  // most recent successful sample instead of flipping the host immediately.
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.success) {
      return s.rtt_ms != null && s.rtt_ms > SLOW_THRESHOLD_MS ? "slow" : "online";
    }
  }
  // No success in the buffer and streak below threshold: host is warming up
  // (or down since creation with < OFFLINE_FAIL_STREAK samples).
  return "idle";
}

// Shallow compare of two group records over the union of their own keys.
function groupChanged(prev, next) {
  for (const k of Object.keys(prev)) {
    if (prev[k] !== next[k]) return true;
  }
  for (const k of Object.keys(next)) {
    if (!(k in prev)) return true;
  }
  return false;
}

export { MAX_SAMPLES_PER_HOST, SLOW_THRESHOLD_MS };
