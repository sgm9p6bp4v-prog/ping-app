export function initDesignExamples() {
  const main = document.getElementById("deck-main");
  const next = document.getElementById("page-next");
  const back = document.getElementById("page-back");
  const dashboardNext = document.getElementById("dashboard-next");
  const dashboardBack = document.getElementById("dashboard-back");
  if (!main) return;

  function setPage(page) {
    main.dataset.page = String(page);
  }

  next?.addEventListener("click", () => setPage(1));
  back?.addEventListener("click", () => setPage(0));
  dashboardNext?.addEventListener("click", () => setPage(2));
  dashboardBack?.addEventListener("click", () => setPage(1));

  window.addEventListener("keydown", (event) => {
    const page = Number(main.dataset.page || "0");
    if (event.key === "ArrowRight") setPage(Math.min(2, page + 1));
    if (event.key === "ArrowLeft") setPage(Math.max(0, page - 1));
  });

  main.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) < 18 && Math.abs(event.deltaX) < 18) return;
    event.preventDefault();
    const page = Number(main.dataset.page || "0");
    const direction = event.deltaY > 0 || event.deltaX > 0 ? 1 : -1;
    setPage(Math.max(0, Math.min(2, page + direction)));
  }, { passive: false });
}
