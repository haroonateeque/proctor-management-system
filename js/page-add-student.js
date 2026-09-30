/* Add / edit a student by hand, with duplicate-ID checking (requirements 5-6). */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome(null);

  const params = new URLSearchParams(window.location.search);
  const editId = params.get("edit");

  const form = document.getElementById("add-form");
  const errBox = document.getElementById("form-error");
  const dupeWarn = document.getElementById("dupe-warning");
  const saveBtn = document.getElementById("save-btn");
  const title = document.getElementById("page-title");
  document.title = (editId ? "Edit Student" : "Add Student") + " — Proctor Register";
  title.textContent = editId ? "Edit Student" : "Add a Student";
  if (editId) saveBtn.textContent = "Save Changes";

  const F = (id) => document.getElementById(id);
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  if (editId) {
    try {
      const s = await DB.getStudentById(editId);
      if (!s) {
        errBox.textContent = "This student could not be found.";
        errBox.classList.add("show");
        saveBtn.disabled = true;
      } else {
        ["name", "student_id", "class_name", "section", "department", "semester",
          "phone", "email", "father_name", "guardian_phone", "blood_group",
          "hostel", "dob", "cnic", "address", "notes"]
          .forEach((f) => { F(f).value = s[f] || ""; });
        F("student_id").readOnly = true;
        F("student_id").title = "The student ID cannot be changed.";
        dupeWarn.style.display = "block";
        dupeWarn.style.color = "var(--muted)";
        dupeWarn.textContent = "The student ID cannot be changed.";
      }
    } catch (err) {
      errBox.textContent = err.message || "Could not load this student.";
      errBox.classList.add("show");
    }
  }

  /* Live duplicate warning while typing a new student ID. */
  let lastChecked = "";
  const checkDupe = UI.debounce(async () => {
    if (editId) return;
    const sid = F("student_id").value.trim();
    if (!sid || sid === lastChecked) return;
    lastChecked = sid;
    try {
      const found = await DB.findStudentByStudentId(sid);
      if (found && !found.removed) {
        dupeWarn.style.display = "block";
        dupeWarn.style.color = "var(--danger)";
        dupeWarn.textContent = "Already in the register: " + found.name +
          " (" + found.student_id + ")";
      } else {
        dupeWarn.style.display = "none";
      }
    } catch (e) { /* warning is best-effort */ }
  }, 350);
  F("student_id").addEventListener("input", checkDupe);

  /* Prefill from the ID-card scanner (scan.html hands data over). */
  if (!editId && params.get("from") === "scan") {
    try {
      const pre = JSON.parse(sessionStorage.getItem("pr_scan_prefill") || "null");
      if (pre) {
        Object.keys(pre).forEach((k) => {
          const el = F(k);
          if (el && pre[k]) el.value = pre[k];
        });
        sessionStorage.removeItem("pr_scan_prefill");
        UI.toast("Details read from the ID card — check them, then save.", { type: "success" });
        dupeWarn.style.display = "block";
        dupeWarn.style.color = "var(--muted)";
        dupeWarn.textContent = "Prefilled from a scanned card — please review.";
        lastChecked = "";
        checkDupe();
      }
    } catch (e) { /* a broken prefill should never block the form */ }
  }

  function setError(msg) {
    if (!msg) { errBox.classList.remove("show"); return; }
    errBox.textContent = msg;
    errBox.classList.add("show");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");

    const data = {
      name: F("name").value.trim().replace(/\s+/g, " "),
      student_id: F("student_id").value.trim(),
      class_name: F("class_name").value.trim(),
      section: F("section").value.trim(),
      department: F("department").value.trim(),
      semester: F("semester").value.trim(),
      phone: F("phone").value.trim(),
      email: F("email").value.trim(),
      father_name: F("father_name").value.trim(),
      guardian_phone: F("guardian_phone").value.trim(),
      blood_group: F("blood_group").value.trim(),
      hostel: F("hostel").value,
      dob: F("dob").value,
      cnic: F("cnic").value.trim(),
      address: F("address").value.trim(),
      notes: F("notes").value.trim(),
    };

    let bad = null;
    if (!data.name) bad = F("name");
    else if (!data.student_id) bad = F("student_id");
    [F("name"), F("student_id")].forEach((el) => el.classList.remove("invalid"));
    if (bad) {
      bad.classList.add("invalid");
      return setError(bad === F("name")
        ? "Please enter the student's name."
        : "Please enter the student ID.");
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      if (editId) {
        const res = await DB.updateStudent(editId, data);
        if (!res.ok) { setError(res.message); return; }
        UI.toast("Changes saved.", { type: "success" });
        window.location.href = "student.html?id=" + encodeURIComponent(editId);
      } else {
        const res = await DB.addStudent(data);
        if (!res.ok) { setError(res.message); return; }
        if (res.restored) {
          UI.toast(data.name + " is back in the register.", { type: "success" });
          window.location.href = "student.html?id=" + encodeURIComponent(res.student.id);
        } else {
          UI.toast(data.name + " added to the register.", { type: "success" });
          window.location.href = "student.html?id=" + encodeURIComponent(res.student.id);
        }
      }
    } catch (err) {
      setError(err.message || "Could not save. Please try again.");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = editId ? "Save Changes" : "Save Student";
    }
  });
})();
