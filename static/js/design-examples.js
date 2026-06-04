export function initDesignExamples() {
  const main = document.getElementById("deck-main");
  const next = document.getElementById("page-next");
  const back = document.getElementById("page-back");
  const dashboardNext = document.getElementById("dashboard-next");
  const dashboardBack = document.getElementById("dashboard-back");
  if (!main) return;

  let wheelBoundaryDirection = 0;
  let wheelBoundaryReadyAt = 0;
  let wheelBoundaryTimer = 0;
  const wheelBoundaryDelayMs = 520;
  const wheelBoundaryWindowMs = 4200;

  function clearWheelBoundaryTimer() {
    if (!wheelBoundaryTimer) return;
    window.clearTimeout(wheelBoundaryTimer);
    wheelBoundaryTimer = 0;
  }

  function resetWheelBoundary() {
    clearWheelBoundaryTimer();
    wheelBoundaryDirection = 0;
    wheelBoundaryReadyAt = 0;
  }

  function setPage(page) {
    resetWheelBoundary();
    main.dataset.page = String(page);
  }

  function isTextEditingTarget(target) {
    if (!(target instanceof Element)) return false;
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable
      || Boolean(target.closest("[contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox']"))
      || tagName === "input"
      || tagName === "textarea"
      || tagName === "select";
  }

  function canTurnFromResultsBoundary(direction, results) {
    if (!results || results.scrollHeight <= results.clientHeight + 4) return true;
    const maxScroll = results.scrollHeight - results.clientHeight;
    return direction < 0 ? results.scrollTop <= 2 : results.scrollTop >= maxScroll - 2;
  }

  function setPageFromWheel(direction) {
    const page = Number(main.dataset.page || "0");
    setPage(Math.max(0, Math.min(2, page + direction)));
  }

  function armWheelBoundary(direction) {
    const now = performance.now();
    const stillArmed = wheelBoundaryDirection === direction
      && now <= wheelBoundaryReadyAt + wheelBoundaryWindowMs;
    if (!stillArmed) {
      clearWheelBoundaryTimer();
      wheelBoundaryDirection = direction;
      wheelBoundaryReadyAt = now + wheelBoundaryDelayMs;
      wheelBoundaryTimer = window.setTimeout(() => {
        wheelBoundaryTimer = 0;
        if (wheelBoundaryDirection !== direction) return;
        const page = Number(main.dataset.page || "0");
        const results = document.getElementById("results-page");
        if (page === 1 && canTurnFromResultsBoundary(direction, results)) {
          setPageFromWheel(direction);
        }
      }, wheelBoundaryDelayMs);
      return false;
    }
    return now >= wheelBoundaryReadyAt;
  }

  next?.addEventListener("click", () => setPage(1));
  back?.addEventListener("click", () => setPage(0));
  dashboardNext?.addEventListener("click", () => setPage(2));
  dashboardBack?.addEventListener("click", () => setPage(1));

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || isTextEditingTarget(event.target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const page = Number(main.dataset.page || "0");
    if (event.key === "ArrowRight") setPage(Math.min(2, page + 1));
    if (event.key === "ArrowLeft") setPage(Math.max(0, page - 1));
  });

  main.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) < 18 && Math.abs(event.deltaX) < 18) return;
    const page = Number(main.dataset.page || "0");
    const results = document.getElementById("results-page");
    const mostlyVertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    const direction = event.deltaY > 0 || event.deltaX > 0 ? 1 : -1;
    if (page === 1 && results && mostlyVertical && results.scrollHeight > results.clientHeight + 4) {
      const maxScroll = results.scrollHeight - results.clientHeight;
      const goingDown = event.deltaY > 0;
      const canScrollDown = results.scrollTop < maxScroll - 2;
      const canScrollUp = results.scrollTop > 2;
      if ((goingDown && canScrollDown) || (!goingDown && canScrollUp)) {
        event.preventDefault();
        resetWheelBoundary();
        const easedDelta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY) * 0.42, 180);
        results.scrollTop = Math.max(0, Math.min(maxScroll, results.scrollTop + easedDelta));
        return;
      }
    }
    event.preventDefault();

    if (page === 1 && mostlyVertical) {
      if (!armWheelBoundary(direction)) return;
      clearWheelBoundaryTimer();
    }

    setPageFromWheel(direction);
  }, { passive: false });
}
