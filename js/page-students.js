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

  /* ---------- list rendering ---------- */

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

  async function renderList() {
    listEl.innerHTML = UI.spinner();
    try {
      const term = searchEl.value;
      const students = await DB.searchStudents(term);
      if (!students.length) {
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
      } else {
        listEl.innerHTML = students.map(rowHtml).join("");
        countEl.textContent = students.length + " student" + (students.length === 1 ? "" : "s") +
          (term ? ' found for "' + term + '"' : " in the register");
      }
      /* keep checkboxes in sync with current selection */
      listEl.querySelectorAll("[data-check]").forEach((cb) => {
        cb.checked = selected.has(cb.dataset.check);
      });
      updateBulkBar();
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
      const undos = [];
      for (const id of ids) {
        const res = await DB.removeStudent(id, "Removed from student list");
        if (res.ok && res.undo) undos.push(res.undo);
      }
      selected.clear();
      updateBulkBar();
      renderList();
      if (undos.length) {
        UI.toast(undos.length + " student" + (undos.length === 1 ? "" : "s") + " removed.", {
          type: "success",
          actionLabel: "Undo",
          onAction: async () => {
            for (const u of undos) await u();
            renderList();
          },
        });
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
    let count = 0;
    for (const id of ids) {
      await DB.addHistory(id, kind, desc, extra);
      if (kind === "fine") await DB.setStatus(id, "FINED", { allowDowngrade: false });
      else await DB.setStatus(id, kind === "warning" ? "WARNING" : "SUSPENDED", { allowDowngrade: false });
      count++;
    }
    selected.clear();
    updateBulkBar();
    renderList();
    UI.toast(label.charAt(0).toUpperCase() + label.slice(1) + " recorded for " + count +
      " student" + (count === 1 ? "" : "s") + ".", { type: "success" });
  }

  renderList();
})();
