/* Home screen: greeting, simple counts, big action buttons. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome("home");

  const name = (session.email || "").split("@")[0];
  const nice = name.charAt(0).toUpperCase() + name.slice(1);
  document.getElementById("greeting").textContent = "Welcome, " + nice;

  /* stroke icons in the quick-start cards */
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  try {
    const stats = await DB.getStats();
    if (stats.total > 0 || stats.removed > 0) {
      const grid = document.getElementById("stats-grid");
      document.getElementById("stats-zone").hidden = false;
      const items = [
        ["In register", stats.total, ""],
        ["Need attention", stats.attention, "tone-warn"],
      ];
      if (stats.removed > 0) items.push(["Removed", stats.removed, "tone-danger"]);
      grid.innerHTML = items.map(([label, n, tone]) =>
        '<div class="stat-tile ' + tone + '">' +
        '<div class="st-num">' + n + "</div>" +
        '<div class="st-label">' + UI.escapeHtml(label) + "</div></div>"
      ).join("");
    }
  } catch (err) {
    UI.toast(err.message || "Could not load your counts.", { type: "error" });
  }
})();
