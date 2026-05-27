const root = document.documentElement;
let revealObserver = null;
let raf = 0;
let pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

export function initMotion() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add("is-visible");
      });
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.08 }
  );

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", () => document.body.classList.remove("has-pointer"));
  window.addEventListener("scroll", onScroll, { passive: true });

  document.addEventListener("pointermove", onCardPointerMove, { passive: true });
  document.addEventListener("pointerleave", resetCard, true);

  enhanceMotion();
  onScroll();
}

export function enhanceMotion() {
  colorPingDot();
  splitText(".magnetic-text, .group__name, .host-card__name");
  observeReveal(".hero, .kpi, .view-toggle-bar, .suggestions, .group, .host-card, .app-footer");
}

function colorPingDot() {
  document.querySelectorAll(".hero__sentence > span").forEach((el) => {
    el.dataset.pingDot = "true";
    if (el.querySelector(".hero__dot")) return;
    for (const node of [...el.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.includes("ping.me")) continue;
      const [before, after] = node.textContent.split("ping.me", 2);
      const fragment = document.createDocumentFragment();
      fragment.append(before, "ping");
      const dot = document.createElement("span");
      dot.className = "hero__dot";
      dot.textContent = ".";
      fragment.append(dot, `me${after}`);
      node.replaceWith(fragment);
      break;
    }
  });
}

function onPointerMove(event) {
  pointer = { x: event.clientX, y: event.clientY };
  document.body.classList.add("has-pointer");
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    root.style.setProperty("--cursor-x", `${pointer.x}px`);
    root.style.setProperty("--cursor-y", `${pointer.y}px`);
    applyMagneticTilt(pointer.x, pointer.y);
  });
}

function onScroll() {
  root.style.setProperty("--scroll-shift", `${window.scrollY}px`);
}

function splitText(selector) {
  document.querySelectorAll(selector).forEach((el) => {
    const text = el.textContent;
    if (!text || el.dataset.motionText === text) return;
    el.dataset.motionText = text;
    el.textContent = "";
    Array.from(text).forEach((char, index) => {
      const span = document.createElement("span");
      span.className = "motion-char";
      span.style.setProperty("--char-index", index);
      span.textContent = char === " " ? "\u00a0" : char;
      el.appendChild(span);
    });
  });
}

function observeReveal(selector) {
  if (!revealObserver) return;
  document.querySelectorAll(selector).forEach((el, index) => {
    if (el.dataset.motionReveal === "true") return;
    el.dataset.motionReveal = "true";
    el.style.setProperty("--reveal-index", index % 8);
    el.classList.add("motion-reveal");
    revealObserver.observe(el);
  });
}

function applyMagneticTilt(x, y) {
  document.querySelectorAll(".magnetic-text").forEach((el) => {
    const rect = el.getBoundingClientRect();
    const dx = (x - (rect.left + rect.width / 2)) / Math.max(rect.width, 1);
    const dy = (y - (rect.top + rect.height / 2)) / Math.max(rect.height, 1);
    el.style.setProperty("--tilt-x", `${clamp(dx * 7, -7, 7)}deg`);
    el.style.setProperty("--tilt-y", `${clamp(dy * -5, -5, 5)}deg`);
  });
}

function onCardPointerMove(event) {
  const card = event.target.closest?.(".host-card");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 100;
  const y = ((event.clientY - rect.top) / rect.height) * 100;
  const tiltX = clamp((x - 50) / 12, -4, 4);
  const tiltY = clamp((50 - y) / 12, -4, 4);
  card.style.setProperty("--card-x", `${x}%`);
  card.style.setProperty("--card-y", `${y}%`);
  card.style.setProperty("--card-tilt-x", `${tiltX}deg`);
  card.style.setProperty("--card-tilt-y", `${tiltY}deg`);
}

function resetCard(event) {
  const card = event.target.closest?.(".host-card");
  if (!card) return;
  card.style.setProperty("--card-tilt-x", "0deg");
  card.style.setProperty("--card-tilt-y", "0deg");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
