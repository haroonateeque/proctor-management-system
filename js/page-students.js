/* Students screen: forgiving search, list, bulk actions (requirement 7-9, 15-16). */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome("students");

  const listEl = document.getElementById("list");
  const countEl = document.getElementById("count-line");
  const searchEl = document.getElementById("search");
  const resultsEl = document.getElementById("search-results");
  const bulkBar = document.getElementById("bulk-bar");
  const bulkCount = document.getElementById("bulk-count");
  const searchIcon = document.getElementById("ic-search");
  if (searchIcon) searchIcon.innerHTML = UI.icon("search");

  const selected = new Map(); // id -> student

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase()).join("");
  }

  /* ---------- list rendering (shown in pages so a big register
     never floods the screen with thousands of rows at once) ---------- */

  const PAGE_SIZE = 50;
  let lastResults = [];
  let shown = PAGE_SIZE;
  let paintedTerm = null;

  function rowHtml(s) {
    const cls = [s.class_name, s.department].filter(Boolean).join(" · ");
    const meta = [s.student_id, cls || null, s.section].filter(Boolean).join(" · ");
    return '<div class="student-row" data-id="' + s.id + '">' +
      '<input type="checkbox" data-check="' + s.id + '" ' +
      'aria-label="Select ' + UI.escapeHtml(s.name) + '">' +
      '<div class="avatar">' + UI.escapeHtml(initials(s.name)) + "</div>" +
      '<div class="sr-main">' +
      '<div class="sr-name">' + UI.escapeHtml(s.name) + "</div>" +
      '<div class="sr-meta">' + UI.escapeHtml(meta) + "</div>" +
      '<div class="sr-col sr-col-id">' + UI.escapeHtml(s.student_id) + "</div>" +
      '<div class="sr-col">' + UI.escapeHtml(cls) + "</div>" +
      '<div class="sr-col">' + UI.escapeHtml(s.section) + "</div>" +
      "</div>" +
      '<span class="sr-status">' + UI.statusBadge(s.status) + "</span>" +
      '<span class="row-arrow">›</span>' +
      "</div>";
  }

  function paint() {
    const term = searchEl.value;
    if (!lastResults.length) {
      listEl.innerHTML = term
        ? UI.emptyState({
            icon: UI.icon("search"),
            title: 'No students found for "' + term + '"',
            description: "Try a shorter part of the name or just part of the student ID.",
          })
        : UI.emptyState({
            icon: UI.icon("users"),
            title: "Your register is empty",
            description: "Add your first student to get started.",
            action: { href: "add-student.html", label: "Add a Student" },
          });
      countEl.textContent = "";
      updateBulkBar();
      return;
    }
    const visible = lastResults.slice(0, shown);
    const hidden = lastResults.length - visible.length;
    listEl.innerHTML = visible.map(rowHtml).join("") +
      (hidden > 0
        ? '<button class="btn btn-secondary btn-block" id="show-more">' +
          "Show " + Math.min(hidden, PAGE_SIZE) + " more of " + hidden + "</button>"
        : "");
    countEl.textContent = lastResults.length + " student" + (lastResults.length === 1 ? "" : "s") +
      (term ? ' found for "' + term + '"' : " in the register") +
      (visible.length < lastResults.length ? " · showing first " + visible.length : "");
    listEl.querySelectorAll("[data-check]").forEach((cb) => {
      cb.checked = selected.has(cb.dataset.check);
    });
    const more = document.getElementById("show-more");
    if (more) more.addEventListener("click", () => { shown += PAGE_SIZE; paint(); });
    updateBulkBar();
  }

  async function renderList() {
    const term = searchEl.value;
    if (term !== paintedTerm) { shown = PAGE_SIZE; paintedTerm = term; }
    listEl.innerHTML = UI.spinner();
    try {
      lastResults = await DB.searchStudents(term);
      paint();
    } catch (err) {
      listEl.innerHTML = UI.emptyState({
        icon: UI.icon("warn"),
        title: "Something went wrong",
        description: err.message || "Please try again.",
      });
    }
  }

  /* ---------- search box + live suggestions (requirement 8) ---------- */

  const liveSearch = UI.debounce(renderList, 250);

  searchEl.addEventListener("input", () => { liveSearch(); showSuggestions(); });

  async function showSuggestions() {
    const term = searchEl.value.trim();
    if (term.length < 2) { resultsEl.classList.remove("show"); return; }
    try {
      const hits = (await DB.searchStudents(term)).slice(0, 6);
      resultsEl.innerHTML = hits.length
        ? hits.map((s) =>
            '<a class="search-result" href="student.html?id=' + encodeURIComponent(s.id) + '">' +
            '<div class="sr-name">' + UI.escapeHtml(s.name) + "</div>" +
            '<div class="sr-meta">' + UI.escapeHtml(s.student_id +
              (s.class_name ? " · " + s.class_name : "")) + "</div></a>"
          ).join("")
        : '<div class="search-note">No matching students.</div>';
      resultsEl.classList.add("show");
    } catch (e) { /* suggestions are best-effort */ }
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) resultsEl.classList.remove("show");
  });
  /* ---------- selection + bulk bar (requirement 16) ---------- */

  listEl.addEventListener("click", (e) => {
    if (e.target.matches("[data-check]") || e.target.closest("[data-check]")) return;
    const row = e.target.closest(".student-row");
    if (row) window.location.href = "student.html?id=" + encodeURIComponent(row.dataset.id);
  });

  listEl.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-check]");
    if (!cb) return;
    const id = cb.dataset.check;
    const name = cb.closest(".student-row").querySelector(".sr-name").textContent;
    if (cb.checked) selected.set(id, { id, name });
    else selected.delete(id);
    updateBulkBar();
  });

  function updateBulkBar() {
    if (selected.size === 0) { bulkBar.classList.remove("show"); return; }
    bulkBar.classList.add("show");
    bulkCount.textContent = selected.size + " selected";
  }

  bulkBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-bulk]");
    if (btn) handleBulk(btn.dataset.bulk);
  });

  async function handleBulk(action) {
    if (action === "clear") {
      selected.clear();
      updateBulkBar();
      renderList();
      return;
    }
    const ids = [...selected.keys()];
    const names = [...selected.values()].map((s) => s.name);

    if (action === "remove") {
      const ok = await UI.confirmDialog({
        title: "Remove " + ids.length + " student" + (ids.length === 1 ? "" : "s") + "?",
        message: "These students will be removed from your register: <strong>" +
          UI.escapeHtml(names.join(", ")) + "</strong>. " +
          "You will be able to undo this for a few seconds after removing.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        /* one batched request set, whatever the size of the selection */
        const res = await DB.removeStudents(ids, "Removed from student list");
        if (!res.ok) { UI.toast(res.message, { type: "error" }); return; }
        selected.clear();
        updateBulkBar();
        renderList();
        UI.toast(res.count + " student" + (res.count === 1 ? "" : "s") + " removed.", {
          type: "success",
          actionLabel: "Undo",
          onAction: async () => {
            await res.undo();
            renderList();
          },
        });
      } catch (err) {
        UI.toast(err.message || "Could not remove those students.", { type: "error" });
      }
      return;
    }

    /* discipline: fine / warning / suspension */
    const kind = action;
    const label = kind === "fine" ? "fine" : kind === "warning" ? "warning" : "suspension";
    const fields = [
      { name: "description", label: "What happened?", type: "text",
        placeholder: "Short description", required: true },
    ];
    if (kind === "fine") {
      fields.push({ name: "amount", label: "Fine amount (Rs.)", type: "number",
        placeholder: "e.g. 500", required: true });
    }
    fields.push({ name: "date", label: "Date of incident", type: "date",
      value: new Date().toISOString().slice(0, 10), required: true });

    const vals = await UI.formDialog({
      title: "Record a " + label.charAt(0).toUpperCase() + label.slice(1) +
        " for " + ids.length + " student" + (ids.length === 1 ? "" : "s"),
      description: "Applies to: " + names.join(", "),
      fields,
      confirmLabel: "Save " + label.charAt(0).toUpperCase() + label.slice(1),
    });
    if (!vals) return;

    const desc = vals.description + (vals.date ? " (on " + vals.date + ")" : "");
    const extra = kind === "fine" ? { amount: Number(vals.amount) } : {};
    try {
      /* history + status for everyone in one batched call */
      const res = await DB.bulkRecord(ids, kind, desc, extra);
      selected.clear();
      updateBulkBar();
      renderList();
      UI.toast(label.charAt(0).toUpperCase() + label.slice(1) + " recorded for " +
        (res.count || ids.length) + " student" + ((res.count || ids.length) === 1 ? "" : "s") + ".",
        { type: "success" });
    } catch (err) {
      UI.toast(err.message || "Could not save. Please try again.", { type: "error" });
    }
  }

  renderList();
})();
