/* More screen: backups, removed students, import history, help. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome("more");

  const $ = (id) => document.getElementById(id);

  document.getElementById("mode-note").innerHTML = DB.isTrialMode
    ? "Local mode — data is saved in this browser only. Connect Supabase (see README) to save online."
    : "Connected mode — data is saved safely online. Sign-in is by Google account.";

  /* stroke icons in the menu */
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  /* ---------- backups (requirement 10 / 23) ---------- */

  $("btn-backup").addEventListener("click", async () => {
    try {
      const data = JSON.stringify(await DB.exportBackup(), null, 2);
      const stamp = new Date().toISOString().slice(0, 10);
      DB.downloadFile("proctor-register-backup-" + stamp + ".json", data, "application/json");
      UI.toast("Backup downloaded. Keep this file somewhere safe.", { type: "success" });
    } catch (err) {
      UI.toast(err.message || "Could not create the backup.", { type: "error" });
    }
  });

  $("btn-export-list").addEventListener("click", async () => {
    try {
      const students = await DB.getStudents();
      const csv = DB.studentsToCsv(students);
      const stamp = new Date().toISOString().slice(0, 10);
      DB.downloadFile("student-list-" + stamp + ".csv", csv, "text/csv;charset=utf-8");
      UI.toast("Student list downloaded.", { type: "success" });
    } catch (err) {
      UI.toast(err.message || "Could not create the list.", { type: "error" });
    }
  });

  /* ---------- removed students (requirement 11) ---------- */

  $("btn-removed").addEventListener("click", async () => {
    const removed = (await DB.getStudents({ includeRemoved: true })).filter((s) => s.removed);
    if (!removed.length) {
      return UI.confirmDialog({
        title: "No removed students",
        message: "Students you remove will appear here so you can put them back.",
        confirmLabel: "Close", cancelLabel: "",
      });
    }
    const rows = removed.map((s) =>
      '<div class="student-row" style="cursor:default">' +
      '<span></span><div class="sr-main">' +
      '<div class="sr-name">' + UI.escapeHtml(s.name) + "</div>" +
      '<div class="sr-meta">' + UI.escapeHtml(s.student_id) + "</div>" +
      "</div>" +
      '<button class="btn btn-small btn-secondary" data-restore="' + s.id + '">Put Back</button>' +
      "<span></span></div>"
    ).join("");
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog"><h3>Removed Students</h3>' +
      '<div class="preview-list" style="max-height:340px">' + rows + "</div>" +
      '<div class="dialog-actions"><button class="btn btn-secondary" data-act="cancel">Close</button></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", async (e) => {
      if (e.target === overlay || e.target.closest('[data-act="cancel"]')) overlay.remove();
      const btn = e.target.closest("[data-restore]");
      if (!btn) return;
      const res = await DB.updateStudent(btn.dataset.restore, { removed: false });
      if (res.ok) {
        await DB.addHistory(btn.dataset.restore, "note", "Returned to the register.", null);
        btn.textContent = "Put Back ✓";
        btn.disabled = true;
        UI.toast("Student is back in the register.", { type: "success" });
      } else UI.toast(res.message, { type: "error" });
    });
  });

  /* ---------- past imports (requirement 22) ---------- */

  $("btn-imports").addEventListener("click", async () => {
    const past = await DB.getSetting("import_history", []);
    if (!past.length) {
      return UI.confirmDialog({
        title: "No imports yet",
        message: "When you add students from Excel, a record of each import will appear here.",
        confirmLabel: "Close", cancelLabel: "",
      });
    }
    const rows = past.map((p) =>
      '<div class="preview-item"><div class="pv-name">' + UI.formatDate(p.when) + "</div>" +
      '<div class="pv-meta">' + p.added + " added" +
      (p.skipped ? " · " + p.skipped + " skipped" : "") +
      (p.names && p.names.length ? " — " + UI.escapeHtml(p.names.slice(0, 8).join(", ")) +
        (p.names.length > 8 ? " …" : "") : "") +
      "</div></div>"
    ).join("");
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog"><h3>Past Imports</h3>' +
      '<div class="preview-list" style="max-height:340px">' + rows + "</div>" +
      '<div class="dialog-actions"><button class="btn btn-secondary" data-act="cancel">Close</button></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest('[data-act="cancel"]')) overlay.remove();
    });
  });
  /* ---------- error dictionary (requirement 17) ---------- */

  const ERRORS = [
    ["“That email or password doesn't look right.”",
      "The email or password was typed incorrectly. Check both and try again."],
    ["“Can't reach the internet right now.”",
      "The device is offline or the connection is weak. Reconnect and try again."],
    ["“Your session has expired. Please sign in again.”",
      "You were signed out for safety. Sign in again to continue."],
    ["“A student with this ID is already in the register.”",
      "The same student was added before. Search for them instead of adding again."],
    ["“The file appears to be empty.”",
      "The Excel file has no data rows. Open it and make sure names and IDs are filled in."],
    ["“Sorry, this file could not be read.”",
      "The file may be damaged or in an unusual format. Re-save it as .xlsx or .csv and try again."],
    ["“You don't have permission to do that.”",
      "The app's database rules need adjusting. Ask whoever set up Supabase to check the README."],
  ];
  document.getElementById("error-dict").innerHTML = ERRORS.map(([q, a]) =>
    "<details><summary>" + UI.escapeHtml(q) + "</summary><p>" + UI.escapeHtml(a) + "</p></details>"
  ).join("");

  /* ---------- sign out ---------- */

  $("btn-signout").addEventListener("click", async () => {
    const ok = await UI.confirmDialog({
      title: "Sign out?",
      message: "Your records stay saved. You can sign back in any time.",
      confirmLabel: "Sign Out",
    });
    if (!ok) return;
    await DB.signOut();
    window.location.href = "index.html";
  });
})();
