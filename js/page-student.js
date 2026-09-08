/* Student profile: details, history timeline, discipline quick actions. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome(null);

  const params = new URLSearchParams(window.location.search);
  const studentId = params.get("id");
  const profileZone = document.getElementById("profile-zone");
  const historyZone = document.getElementById("history-zone");

  if (!studentId) {
    profileZone.innerHTML = UI.emptyState({
      icon: UI.icon("question"), title: "No student selected",
      description: "Go back and pick a student from the list.",
      action: { href: "students.html", label: "Student List" },
    });
    document.getElementById("actions").style.display = "none";
    return;
  }

  /* keep the Edit button pointing at this student */
  const editLink = document.querySelector('a[href="add-student.html"]');
  if (editLink) editLink.href = "add-student.html?edit=" + encodeURIComponent(studentId);

  /* inject the stroke icons into the quick-action buttons */
  const btnIcons = {
    "ic-money": "money", "ic-warn": "warn", "ic-stop": "stop",
    "ic-note": "note", "ic-edit": "edit", "ic-print": "print", "ic-trash": "trash",
  };
  Object.entries(btnIcons).forEach(([id, name]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = UI.icon(name);
  });

  let student = null;

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase()).join("");
  }

  function profileHtml(s) {
    const dob = s.dob ? UI.formatDate(s.dob) : "";
    const rows = [
      ["Student ID", s.student_id],
      ["Class", s.class_name],
      ["Section", s.section],
      ["Department", s.department],
      ["Semester", s.semester],
      ["Blood Group", s.blood_group],
      ["Hostel", s.hostel],
      ["Date of Birth", dob],
      ["CNIC / B-Form", s.cnic],
      ["Phone", s.phone],
      ["Email", s.email],
      ["Father / Guardian", s.father_name],
      ["Guardian Phone", s.guardian_phone],
      ["Address", s.address],
    ].filter(([, v]) => v);
    return '<div class="card">' +
      '<div class="profile-head">' +
      '<div class="avatar">' + UI.escapeHtml(initials(s.name)) + "</div>" +
      "<h1>" + UI.escapeHtml(s.name) + "</h1>" +
      UI.statusBadge(s.status) + "</div>" +
      '<div class="profile-grid">' +
      rows.map(([label, v]) =>
        '<div><div class="pg-label">' + UI.escapeHtml(label) + "</div>" +
        '<div class="pg-value">' + UI.escapeHtml(v) + "</div></div>"
      ).join("") +
      (s.notes ? '<div><div class="pg-label">Notes</div><div class="pg-value pg-wide">' +
        UI.escapeHtml(s.notes) + "</div></div>" : "") +
      "</div></div>";
  }

  function historyItem(h) {
    const cls = h.type === "note" ? "tl-note" : "tl-" + h.type;
    let text = UI.escapeHtml(h.description);
    let extra = "";
    if (h.type === "fine") {
      if (h.amount) text += " — " + UI.formatMoney(h.amount);
      if (h.paid) extra = '<span class="paid-chip">PAID</span>';
    }
    let actions = "";
    if (h.type === "fine" && !h.paid) {
      actions =
        '<button class="btn btn-small btn-secondary" data-paid="' + h.id + '">Mark as Paid</button>' +
        '<button class="btn btn-small btn-secondary" data-remove-fine="' + h.id + '">Remove Fine</button>';
    }
    return '<li class="' + cls + '">' +
      '<div class="tl-date">' + UI.formatDate(h.created_at) + "</div>" +
      '<div class="tl-text">' + text + extra + "</div>" +
      (actions ? '<div class="tl-actions">' + actions + "</div>" : "") +
      "</li>";
  }

  async function renderAll() {
    try {
      student = await DB.getStudentById(studentId);
      if (!student) {
        profileZone.innerHTML = UI.emptyState({
          icon: UI.icon("question"), title: "Student not found",
          description: "This student may have been permanently removed.",
          action: { href: "students.html", label: "Student List" },
        });
        document.getElementById("actions").style.display = "none";
        historyZone.innerHTML = "";
        return;
      }
      profileZone.innerHTML = profileHtml(student);
      const hist = await DB.getHistory(studentId);
      historyZone.innerHTML = hist.length
        ? '<div class="card"><ul class="timeline">' + hist.map(historyItem).join("") + "</ul></div>"
        : '<div class="card">' + UI.emptyState({
            icon: UI.icon("clock"),
            title: "No history yet",
            description: "Fines, warnings and notes you record will appear here.",
          }) + "</div>";
    } catch (err) {
      UI.toast(err.message || "Could not load this student.", { type: "error" });
    }
  }
  /* ---------- quick actions ---------- */

  document.getElementById("actions").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) doAction(btn.dataset.act);
    const link = e.target.closest("#edit-link");
    if (link) link.href = "add-student.html?edit=" + encodeURIComponent(studentId);
  });

  async function doAction(act) {
    if (act === "print") { window.print(); return; }

    if (act === "remove") {
      const ok = await UI.confirmDialog({
        title: "Remove " + student.name + " from the register?",
        message: "They will no longer appear in your student list. " +
          "Their history is kept, and you can undo this for a few seconds after removing.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      const res = await DB.removeStudent(studentId, "Removed from student page");
      if (!res.ok) { UI.toast(res.message, { type: "error" }); return; }
      let redirect = setTimeout(() => { window.location.href = "students.html"; }, 100);
      if (res.undo) {
        redirect = setTimeout(() => { window.location.href = "students.html"; }, 7500);
        UI.toast(student.name + " removed from the register.", {
          type: "success",
          actionLabel: "Undo",
          onAction: async () => {
            clearTimeout(redirect);
            await res.undo();
            window.location.reload();
          },
        });
      }
      return;
    }

    /* discipline + note dialogs */
    const kinds = {
      fine: { title: "Record a Fine", status: "FINED", needsAmount: true },
      warning: { title: "Give a Warning", status: "WARNING" },
      suspension: { title: "Suspend Student", status: "SUSPENDED" },
      note: { title: "Add a Note", status: null },
    };
    const k = kinds[act];
    if (!k) return;

    const fields = [
      { name: "description", label: "What happened?", type: "textarea",
        placeholder: "Short description of the incident", required: true },
    ];
    if (k.needsAmount) {
      fields.push({ name: "amount", label: "Fine amount (Rs.)", type: "number",
        placeholder: "e.g. 500", required: true });
    }
    fields.push({ name: "date", label: "Date of incident", type: "date",
      value: new Date().toISOString().slice(0, 10), required: true });

    const vals = await UI.formDialog({
      title: k.title + " — " + student.name,
      fields,
      confirmLabel: "Save",
    });
    if (!vals) return;

    const when = vals.date ? " (on " + UI.formatDate(vals.date) + ")" : "";
    const extra = k.needsAmount ? { amount: Number(vals.amount) } : {};
    try {
      await DB.addHistory(studentId, act, vals.description + when, extra);
      if (k.status) await DB.setStatus(studentId, k.status);
      UI.toast("Saved to " + student.name + "'s history.", { type: "success" });
      renderAll();
    } catch (err) {
      UI.toast(err.message || "Could not save. Please try again.", { type: "error" });
    }
  }

  /* ---------- mark fine paid / remove fine ---------- */

  historyZone.addEventListener("click", async (e) => {
    const paidBtn = e.target.closest("[data-paid]");
    const remBtn = e.target.closest("[data-remove-fine]");
    if (!paidBtn && !remBtn) return;

    if (paidBtn) {
      const res = await DB.markFinePaid(paidBtn.dataset.paid);
      if (res.ok) {
        UI.toast("Fine marked as paid.", { type: "success" });
        renderAll();
      } else UI.toast(res.message, { type: "error" });
      return;
    }

    const ok = await UI.confirmDialog({
      title: "Remove this fine?",
      message: "The fine will be deleted completely and the student's status will be updated. " +
        "This cannot be undone.",
      confirmLabel: "Remove Fine",
      danger: true,
    });
    if (!ok) return;
    const res = await DB.removeFine(remBtn.dataset.removeFine);
    if (res.ok) {
      UI.toast("Fine removed.", { type: "success" });
      renderAll();
    } else UI.toast(res.message, { type: "error" });
  });

  renderAll();
})();
