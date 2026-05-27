const DESIGN_KEY = "pingme.design";

export function initDesignExamples() {
  const main = document.getElementById("deck-main");
  const next = document.getElementById("page-next");
  const back = document.getElementById("page-back");
  const buttons = [...document.querySelectorAll("[data-design-choice]")];
  if (!main) return;

  function setPage(page) {
    main.dataset.page = String(page);
  }

  function setDesign(design) {
    document.documentElement.dataset.design = design;
    localStorage.setItem(DESIGN_KEY, design);
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.designChoice === design));
    });
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => setDesign(button.dataset.designChoice));
  });

  next?.addEventListener("click", () => setPage(1));
  back?.addEventListener("click", () => setPage(0));

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") setPage(1);
    if (event.key === "ArrowLeft") setPage(0);
  });

  main.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) < 18 && Math.abs(event.deltaX) < 18) return;
    event.preventDefault();
    setPage(event.deltaY > 0 || event.deltaX > 0 ? 1 : 0);
  }, { passive: false });

  setDesign(localStorage.getItem(DESIGN_KEY) || "pitch");
}
