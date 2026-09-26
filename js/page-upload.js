/* Excel upload wizard: 3 simple steps for the proctor.
   Step 1 choose file · Step 2 check · Step 3 done (requirements 2-4, 18-19). */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome("upload");

  const panels = { 1: document.getElementById("panel-1"), 2: document.getElementById("panel-2"), 3: document.getElementById("panel-3") };
  const steps = { 1: document.getElementById("step-1"), 2: document.getElementById("step-2"), 3: document.getElementById("step-3") };
  const LABELS = { 1: "Choose file", 2: "Check", 3: "Done" };
  const dzIcon = document.getElementById("dz-icon");
  if (dzIcon) dzIcon.innerHTML = UI.icon("sheet");

  function show(n) {
    [1, 2, 3].forEach((i) => {
      panels[i].hidden = i !== n;
      steps[i].classList.toggle("active", i === n);
      steps[i].classList.toggle("done", i < n);
      steps[i].innerHTML = (i < n ? "✓" : '<span class="st-num">' + i + "</span>") + " " + LABELS[i];
    });
  }
  show(1);

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const fileError = document.getElementById("file-error");

  let state = { headers: [], rows: [], mapping: null, built: null, added: [], existing: null, mode: "new", snapshots: [] };

  const tplBtn = document.getElementById("template-btn");
  if (tplBtn) {
    tplBtn.addEventListener("click", () => {
      try {
        Excel.downloadTemplate();
        UI.toast("Template downloaded — fill it in and upload it here.", { type: "success" });
      } catch (err) {
        UI.toast("Could not create the template. Please try again.", { type: "error" });
      }
    });
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  ["dragover", "dragenter"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); }));
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  function fileErrorShow(msg) {
    fileError.textContent = msg;
    fileError.classList.add("show");
  }

  async function handleFile(file) {
    fileError.classList.remove("show");
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      return fileErrorShow("That doesn't look like an Excel or CSV file. Please choose a .xlsx or .csv file.");
    }
    UI.toast("Reading your file…", { duration: 1500 });
    try {
      const parsed = await Excel.readFile(file);
      if (!parsed.headers.length || !parsed.rows.length) {
        return fileErrorShow("The file appears to be empty. Please check it and try again.");
      }
      state.headers = parsed.headers;
      state.rows = parsed.rows;
      state.built = null;
      state.added = [];
      state.snapshots = [];
      state.mode = "new";
      const saved = await DB.getSetting("excel_mapping", {});
      state.mapping = Excel.detectColumns(parsed.headers, saved);
      buildMappingPanel();
      buildPreview();
      show(2);
    } catch (err) {
      fileErrorShow("Sorry, this file could not be read. " +
        "Please make sure it is a normal Excel or CSV file and try again.");
    }
  }

  /* ---------- step 2: column check ---------- */

  function buildMappingPanel() {
    const auto = Object.keys(state.mapping);
    const missing = Excel.REQUIRED.filter((f) => !state.mapping[f]);
    const zone = document.getElementById("map-zone");
    if (missing.length === 0) {
      zone.innerHTML = '<div class="summary-box">✅ All columns recognized — ' +
        auto.length + " of " + Object.keys(Excel.LABELS).length + " details will be copied. " +
        "Just check the preview below.</div>";
      return;
    }
    /* Ask only about what could not be recognized */
    const options = ['<option value="">— choose a column —</option>']
      .concat(state.headers.map((h) => '<option value="' + UI.escapeHtml(h) + '">' + UI.escapeHtml(h) + "</option>"))
      .join("");
    zone.innerHTML =
      '<div class="card" style="margin-bottom:16px">' +
      "<h3>Which column is which?</h3>" +
      '<p style="color:var(--muted);margin-bottom:12px">A few columns could not be recognized. ' +
      "Please match them below.</p>" +
      '<table class="mapping-table">' +
      Object.keys(Excel.LABELS).map((f) => {
        const req = Excel.REQUIRED.includes(f) ? " required" : "";
        const val = state.mapping[f] || "";
        return "<tr><td" + req + ">" + Excel.LABELS[f] + "</td>" +
          '<td><select data-field="' + f + '">' +
          options.replace('value="' + UI.escapeHtml(val) + '"', 'value="' + UI.escapeHtml(val) + '" selected') +
          "</select></td></tr>";
      }).join("") +
      "</table></div>";
    zone.querySelectorAll("select").forEach((sel) =>
      sel.addEventListener("change", () => {
        state.mapping[sel.dataset.field] = sel.value || undefined;
        if (!sel.value) delete state.mapping[sel.dataset.field];
        buildPreview();
      }));
  }
  /* ---------- preview (requirement 19) ---------- */

  async function buildPreview() {
    /* duplicate-check list is fetched once per file and reused
       whenever the column mapping is adjusted — not per keystroke */
    if (!state.existing) {
      state.existing = await DB.getStudents({ includeRemoved: true });
    }
    const built = Excel.buildImport(state.rows, state.mapping, state.existing, { mode: state.mode });
    state.built = built;

    /* how to handle rows already in the register — only worth asking
       when the file actually overlaps the existing list */
    const modeZone = document.getElementById("mode-zone");
    if (built.alreadyCount > 0) {
      modeZone.innerHTML =
        '<div class="import-mode">' +
        '<label class="im-option' + (state.mode === "new" ? " selected" : "") + '">' +
        '<input type="radio" name="import-mode" value="new"' + (state.mode === "new" ? " checked" : "") + ">" +
        "<span><strong>Add new students only</strong> — the " + built.alreadyCount +
        " already in the register are left untouched.</span></label>" +
        '<label class="im-option' + (state.mode === "update" ? " selected" : "") + '">' +
        '<input type="radio" name="import-mode" value="update"' + (state.mode === "update" ? " checked" : "") + ">" +
        "<span><strong>Add new + update existing</strong> — blank cells are kept, " +
        "filled cells replace what is stored (Student ID never changes).</span></label>" +
        "</div>";
      modeZone.querySelectorAll('input[name="import-mode"]').forEach((r) =>
        r.addEventListener("change", () => {
          state.mode = r.value;
          buildPreview();
        }));
    } else {
      modeZone.innerHTML = "";
      state.mode = "new";
    }

    const summary = document.getElementById("preview-summary");
    const missing = Excel.REQUIRED.filter((f) => !state.mapping[f]);
    if (missing.length) {
      summary.innerHTML = "⚠️ Please choose the <strong>" +
        missing.map((f) => Excel.LABELS[f]).join("</strong> and <strong>") +
        "</strong> column" + (missing.length > 1 ? "s" : "") + " above before importing.";
    } else {
      const parts = [];
      parts.push('<span class="sb-num">' + built.newStudents.length + "</span> new student" +
        (built.newStudents.length === 1 ? "" : "s") + " will be added");
      if (state.mode === "update" && built.updates.length) {
        parts.push("<strong>" + built.updates.length + "</strong> existing student" +
          (built.updates.length === 1 ? "" : "s") + " will be updated");
        const untouched = built.alreadyCount - built.updates.length;
        if (untouched > 0) parts.push(untouched + " with nothing to change");
      } else if (built.alreadyCount) {
        parts.push(built.alreadyCount + " already in the register (will be skipped)");
      }
      if (built.issues.length) {
        parts.push(built.issues.length + " row" + (built.issues.length === 1 ? "" : "s") +
          " with problems (see below)");
      }
      summary.innerHTML = parts.join(" · ");
    }

    const updNote = (state.mode === "update" && built.updates.length)
      ? '<div class="search-note">Will be updated: ' +
        UI.escapeHtml(built.updates.slice(0, 12).map((u) => u.name + " (" + u.student_id + ")").join(", ")) +
        (built.updates.length > 12 ? " …" : "") + "</div>"
      : "";

    const list = document.getElementById("preview-list");
    list.innerHTML = built.newStudents.length
      ? built.newStudents.slice(0, 25).map((s) =>
          '<div class="preview-item"><div class="pv-name">' + UI.escapeHtml(s.name) + "</div>" +
          '<div class="pv-meta">' + UI.escapeHtml([s.student_id, s.class_name, s.section]
            .filter(Boolean).join(" · ")) + "</div></div>"
        ).join("") +
        (built.newStudents.length > 25
          ? '<div class="search-note">…and ' + (built.newStudents.length - 25) + " more</div>"
          : "") + updNote
      : (updNote || '<div class="search-note">No new students to add from this file.</div>');

    const iz = document.getElementById("issue-zone");
    iz.innerHTML = built.issues.length
      ? '<div class="card"><h3 style="margin-bottom:8px">Rows that will be skipped</h3>' +
        '<div class="info-card" style="margin-top:0">' +
        built.issues.map(UI.escapeHtml).join("<br>") + "</div></div>"
      : "";

    document.getElementById("import-btn").textContent = importBtnLabel();
  }

  function importBtnLabel() {
    return (state.built && state.mode === "update" && state.built.updates.length)
      ? "Import These Changes"
      : "Add These Students";
  }

  /* ---------- import (requirement 2, 22) ---------- */

  document.getElementById("import-btn").addEventListener("click", async () => {
    if (!state.built) return;
    const missing = Excel.REQUIRED.filter((f) => !state.mapping[f]);
    if (missing.length) {
      UI.toast("Please choose the " + missing.map((f) => Excel.LABELS[f]).join(" and ") +
        " column first.", { type: "error" });
      return;
    }
    /* rebuild with the mode chosen on this screen, in case the radio
       was flipped after the last preview paint */
    const built = Excel.buildImport(state.rows, state.mapping, state.existing || [], { mode: state.mode });
    state.built = built;
    if (!built.newStudents.length && !built.updates.length) {
      UI.toast(state.mode === "update" && built.alreadyCount
        ? "Nothing to change — this sheet matches the register."
        : "There are no new students to add from this file.", { type: "error" });
      return;
    }
    const btn = document.getElementById("import-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const res = built.newStudents.length
        ? await DB.bulkAddStudents(built.newStudents, { record: false })
        : { added: [], skipped: [] };
      const upd = built.updates.length
        ? await DB.bulkUpdateStudents(built.updates)
        : null;
      await DB.addImportRecord({
        added: res.added.length,
        updated: upd ? upd.updated : 0,
        skipped: 0,
        names: res.added.slice(0, 40).map((s) => s.name)
          .concat(upd ? upd.rows.slice(0, 10).map((s) => s.name) : []),
      });
      /* remember the mapping for next time (requirement 4) */
      const remembered = {};
      Object.keys(state.mapping).forEach((f) => { remembered[f] = state.mapping[f]; });
      await DB.setSetting("excel_mapping", remembered);
      state.added = res.added;
      state.snapshots = upd ? upd.snapshots : [];
      showDone({ added: res.added, updated: upd ? upd.updated : 0, skipped: [] });
    } catch (err) {
      UI.toast(err.message || "Could not import. Please try again.", { type: "error" });
    } finally {
      btn.disabled = false;
      btn.textContent = importBtnLabel();
    }
  });

  function showDone(res) {
    const skippedMsg = res.skipped.length
      ? " · " + res.skipped.length + " skipped"
      : "";
    const updatedMsg = res.updated
      ? " · " + res.updated + " updated"
      : "";
    const canUndo = res.added.length || state.snapshots.length;
    document.getElementById("done-state").innerHTML =
      '<div class="empty-icon">' + UI.icon("userplus") + "</div>" +
      '<div class="empty-title">' +
      (res.added.length
        ? res.added.length + " student" + (res.added.length === 1 ? "" : "s") + " added to the register"
        : (res.updated ? "Existing students updated" : "Nothing was changed")) +
      updatedMsg + skippedMsg + "</div>" +
      '<div class="empty-desc">Your student list has been saved.</div>' +
      (canUndo
        ? '<button class="btn btn-danger" id="undo-import">Undo This Import</button>'
        : "") +
      '<div style="margin-top:12px">' +
      '<a class="btn btn-primary" href="students.html">View Student List</a></div>';
    show(3);

    const undoBtn = document.getElementById("undo-import");
    if (undoBtn) {
      undoBtn.addEventListener("click", async () => {
        undoBtn.disabled = true;
        try {
          const parts = [];
          const n = state.added.length ? await DB.undoBulkAdd(state.added) : 0;
          if (n) parts.push(n + " student" + (n === 1 ? "" : "s") + " removed");
          const r = state.snapshots.length ? await DB.restoreStudentRows(state.snapshots) : 0;
          if (r) parts.push(r + " update" + (r === 1 ? "" : "s") + " undone");
          UI.toast("Import undone — " + (parts.join(", ") || "nothing to change") + ".", { type: "success" });
          undoBtn.textContent = "Undone ✓";
          document.getElementById("done-state").querySelector(".empty-title").textContent =
            "Import undone";
        } catch (err) {
          undoBtn.disabled = false;
          UI.toast(err.message || "Could not undo.", { type: "error" });
        }
      });
    }
  }

  document.getElementById("restart-btn").addEventListener("click", () => {
    state = { headers: [], rows: [], mapping: null, built: null, added: [], existing: null, mode: "new", snapshots: [] };
    fileInput.value = "";
    show(1);
  });
})();
