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
  listeners: new Set(),

  setHosts(list) {
    this.hosts.clear();
    for (const h of list) this.hosts.set(h.id, h);
    for (const id of this.samples.keys()) {
      if (!this.hosts.has(id)) this.samples.delete(id);
    }
    this.notify();
  },

  setGroups(list) {
    this.groups.clear();
    for (const g of list) this.groups.set(g.name, g);
    this.notify();
  },

  upsertGroup(g) {
    this.groups.set(g.name, g);
    this.notify();
  },

  groupState(name) {
    return this.groups.get(name) ?? { name, enabled: true, collapsed: false };
  },

  upsertHost(h) {
    this.hosts.set(h.id, h);
    this.notify();
  },

  deleteHost(id) {
    this.hosts.delete(id);
    this.samples.delete(id);
    this.notify();
  },

  addSample(s) {
    let entry = this.samples.get(s.host_id);
    if (!entry) {
      entry = { samples: [], stats: emptyStats(), status: "idle", failStreak: 0 };
      this.samples.set(s.host_id, entry);
    }
    entry.samples.push(s);
    if (entry.samples.length > MAX_SAMPLES_PER_HOST) entry.samples.shift();
    entry.failStreak = s.success ? 0 : entry.failStreak + 1;
    entry.stats = recomputeStats(entry.samples);
    entry.status = deriveStatus(entry);
    this.notify();
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

  notify() {
    for (const fn of this.listeners) fn();
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

function deriveStatus(entry) {
  if (entry.samples.length === 0) return "idle";
  if (entry.failStreak >= OFFLINE_FAIL_STREAK) return "offline";
  const last = entry.samples[entry.samples.length - 1];
  if (!last.success) return entry.failStreak > 0 ? "offline" : "online";
  return last.rtt_ms != null && last.rtt_ms > SLOW_THRESHOLD_MS ? "slow" : "online";
}

export { MAX_SAMPLES_PER_HOST, SLOW_THRESHOLD_MS };
