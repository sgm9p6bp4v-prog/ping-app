/**
 * Bubble physics engine for the group dashboard: RAF integration loop,
 * pairwise collisions, wall constraints, hover nudges and the focus-scroll
 * state machine. Extracted from dashboard.js — pure code move.
 */
import { clamp } from "./util.js";

const groupsEl = document.getElementById("groups");
const deckMainEl = document.getElementById("deck-main");

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

export const HOST_DOT_SIZE = 30;
export const HOST_DETAIL_SIZE = 68;
export const HOST_GRID_GAP = 14;

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

if (deckMainEl) {
  new MutationObserver(() => {
    if (deckMainEl.dataset.page === "1" && groupsEl.dataset.layout === "bubbles") {
      scheduleBubblePhysics({ run: true, fromTop: true });
    }
  }).observe(deckMainEl, { attributes: true, attributeFilter: ["data-page"] });
}

document.getElementById("results-page")?.addEventListener("wheel", cancelBubbleFocusScroll, { passive: true });

window.addEventListener("resize", () => {
  if (groupsEl.dataset.layout === "bubbles") {
    scheduleBubblePhysics({ run: false, fromTop: false });
  }
});

export function scheduleBubblePhysics({ run = true, fromTop = true } = {}) {
  if (bubbleLayoutRaf) cancelAnimationFrame(bubbleLayoutRaf);
  bubbleLayoutRaf = requestAnimationFrame(() => {
    bubbleLayoutRaf = 0;
    layoutBubblePhysics({ run, fromTop });
  });
}

export function isResultsPageVisible() {
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

export function hostGridShape(hostCount) {
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
    item.el.style.setProperty("--host-grid-top", "34%");
    item.el.style.setProperty("--host-grid-hover-top", "36%");
  } else if (hostCount >= 4) {
    item.el.style.setProperty("--host-grid-top", "40%");
    item.el.style.setProperty("--host-grid-hover-top", "42%");
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

export function cancelBubbleFocusScroll() {
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
