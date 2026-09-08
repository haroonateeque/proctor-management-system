/* =============================================================
   db.js — the part of the app that saves and loads information.
   -------------------------------------------------------------
   All the technical work (online database, browser storage,
   error messages) happens here. The rest of the app only sees
   simple, friendly functions like DB.getStudents().

   Two storage modes:
   • LOCAL MODE  — data is saved in this browser (localStorage).
                   Sign-in is disabled until Supabase is connected.
   • CONNECTED   — data is saved in a Supabase project online
                   (set js/config.js to switch on).
   ============================================================= */

const DB = (() => {

  const LS = window.localStorage;
  const K = {
    students: "proctor_students",
    history: "proctor_history",
    settings: "proctor_settings",
    session: "proctor_session",
  };

  const CONNECTED = !!(typeof SUPABASE_URL === "string" && SUPABASE_URL &&
    typeof SUPABASE_ANON_KEY === "string" && SUPABASE_ANON_KEY);

  /* ---------- setup ---------- */
  const sb = CONNECTED ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  /* ---------- friendly error text (requirement 17) ---------- */
  const ERROR_WORDS = {
    "invalid login credentials": "That email or password doesn't look right. Please check and try again.",
    "email not confirmed": "This email hasn't been confirmed yet. Check your inbox for a confirmation link.",
    "user not found": "No account found with that email.",
    "failed to fetch": "Can't reach the internet right now. Check your connection and try again.",
    "network": "Can't reach the internet right now. Check your connection and try again.",
    "row-level security": "You don't have permission to do that. Ask the person who set up the app.",
    "duplicate key": "That record already exists.",
    "jwt": "Your session has expired. Please sign in again.",
  };

  function friendlyMessage(err) {
    const raw = String((err && (err.message || err.error_description || err.msg)) || err || "Something went wrong.");
    const low = raw.toLowerCase();
    for (const key of Object.keys(ERROR_WORDS)) {
      if (low.includes(key)) return ERROR_WORDS[key];
    }
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  /* =============================================================
     AUTH
     ============================================================= */

  async function getSession() {
    if (CONNECTED) {
      const { data } = await sb.auth.getSession();
      return data && data.session
        ? { email: data.session.user.email, id: data.session.user.id }
        : null;
    }
    return JSON.parse(LS.getItem(K.session) || "null");
  }

  /* The signed-in proctor's Supabase user id. Every saved row is
     tagged with it and every read is filtered by it, so each
     proctor only ever sees their own register — never anyone
     else's students, history, or settings. */
  let cachedUid = null;
  let uidFetched = false;
  async function currentUid() {
    if (!CONNECTED) return null;
    if (uidFetched) return cachedUid;
    const { data } = await sb.auth.getSession();
    cachedUid = data && data.session ? data.session.user.id : null;
    uidFetched = true;
    return cachedUid;
  }

  async function signIn(email, password) {
    if (!email) return { ok: false, message: "Please enter your email." };
    if (!password) return { ok: false, message: "Please enter your password." };
    try {
      if (CONNECTED) {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return { ok: true };
      }
      return { ok: false, message: "The app isn't connected to Supabase yet. See js/config.js and README.md." };
    } catch (err) {
      return { ok: false, message: friendlyMessage(err) };
    }
  }

  /* Google sign-in: the proctor clicks one button, picks their
     Google account, and lands back on the home screen. */
  async function signInWithGoogle() {
    if (!CONNECTED) {
      return { ok: false, message: "The app isn't connected to Supabase yet. See js/config.js and README.md." };
    }
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      /* come back to this exact page after Google — supabase-js
         then reads the session from the URL automatically */
      options: { redirectTo: window.location.href },
    });
    if (error) return { ok: false, message: friendlyMessage(error) };
    return { ok: true };
  }

  async function signOut() {
    if (CONNECTED) { try { await sb.auth.signOut(); } catch (e) { /* ignore */ } }
    LS.removeItem(K.session);
  }
  /* =============================================================
     STUDENTS
     A "removed" student keeps their record (soft delete) so the
     action can be undone, but disappears from normal lists.
     ============================================================= */

  function blankStudent() {
    return {
      id: "", name: "", student_id: "", class_name: "", section: "",
      department: "", semester: "", phone: "", email: "",
      father_name: "", guardian_phone: "", blood_group: "",
      hostel: "", dob: "", cnic: "", address: "", notes: "",
      status: "ACTIVE", removed: false, created_at: "", updated_at: "",
    };
  }

  function cleanStudent(s) {
    const base = blankStudent();
    for (const key of Object.keys(base)) {
      if (s[key] !== undefined && s[key] !== null) base[key] = s[key];
    }
    base.name = String(base.name).trim().replace(/\s+/g, " ");
    base.student_id = String(base.student_id).trim();
    for (const k of ["class_name", "section", "department", "semester", "phone", "email",
      "father_name", "guardian_phone", "blood_group", "hostel", "dob", "cnic", "address", "notes"]) {
      base[k] = String(base[k] || "").trim();
    }
    base.status = String(base.status || "ACTIVE").toUpperCase();
    return base;
  }

  async function getStudents(opts) {
    opts = opts || {};
    const includeRemoved = !!opts.includeRemoved;
    if (CONNECTED) {
      const uid = await currentUid();
      let q = sb.from("students").select("*").eq("owner_id", uid).order("name");
      if (!includeRemoved) q = q.eq("removed", false);
      const { data, error } = await q;
      if (error) throw new Error(friendlyMessage(error));
      return (data || []).map(cleanStudent);
    }
    const all = JSON.parse(LS.getItem(K.students) || "[]").map(cleanStudent);
    return includeRemoved ? all : all.filter((s) => !s.removed);
  }

  async function getStudentById(id) {
    if (!id) return null;
    if (CONNECTED) {
      const uid = await currentUid();
      const { data, error } = await sb.from("students").select("*")
        .eq("owner_id", uid).eq("id", id).maybeSingle();
      if (error) throw new Error(friendlyMessage(error));
      return data ? cleanStudent(data) : null;
    }
    const all = JSON.parse(LS.getItem(K.students) || "[]");
    return cleanStudent(all.find((s) => s.id === id) || {});
  }

  /* Forgiving duplicate check (requirement 6): case and spacing
     are ignored, so "A12- 345" and "a12345" count as the same. */
  function idKey(v) {
    return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  async function findStudentByStudentId(studentId) {
    const wanted = idKey(studentId);
    const all = await getStudents({ includeRemoved: true });
    return all.find((s) => idKey(s.student_id) === wanted) || null;
  }

  async function searchStudents(term) {
    const norm = String(term || "").toLowerCase().replace(/\s+/g, " ").trim();
    const all = await getStudents();
    if (!norm) return all;
    return all.filter((s) => {
      const name = s.name.toLowerCase();
      const sid = s.student_id.toLowerCase();
      /* Partial matches on both name and ID (requirement 8) */
      if (name.includes(norm) || sid.includes(norm) || idKey(s.student_id).includes(idKey(norm))) return true;
      const words = norm.split(" ").filter(Boolean);
      if (words.length > 1) {
        return words.every((w) => name.includes(w) || sid.includes(w));
      }
      return false;
    });
  }

  async function addStudent(student) {
    const s = cleanStudent(student);
    if (!s.name) return { ok: false, message: "Please enter the student's name." };
    if (!s.student_id) return { ok: false, message: "Please enter the student ID." };

    const dupe = await findStudentByStudentId(s.student_id);
    if (dupe && !dupe.removed) {
      return {
        ok: false,
        message: 'A student with ID "' + dupe.student_id + '" is already in the register: ' + dupe.name + ".",
      };
    }
    /* If the same ID was removed earlier, adding again restores it. */
    if (dupe && dupe.removed) {
      const restored = cleanStudent({ ...dupe, ...s, id: dupe.id, removed: false });
      restored.status = "ACTIVE";
      await saveStudentRow(restored);
      await addHistory(dupe.id, "note",
        'Restored to the register (previously removed).',
        null);
      return { ok: true, student: restored, restored: true };
    }

    s.id = s.id || newId();
    s.created_at = s.created_at || new Date().toISOString();
    s.updated_at = new Date().toISOString();
    await saveStudentRow(s);
    await addHistory(s.id, "note", "Added to the register.", null);
    return { ok: true, student: s };
  }

  async function updateStudent(id, changes) {
    const current = await getStudentById(id);
    if (!current) return { ok: false, message: "This student could not be found." };
    const merged = cleanStudent({ ...current, ...changes, id, student_id: current.student_id });
    merged.updated_at = new Date().toISOString();
    await saveStudentRow(merged);
    return { ok: true, student: merged };
  }

  async function saveStudentRow(s) {
    if (CONNECTED) {
      s.owner_id = await currentUid();
      const { error } = await sb.from("students").upsert(s);
      if (error) throw new Error(friendlyMessage(error));
      return;
    }
    const all = JSON.parse(LS.getItem(K.students) || "[]");
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s; else all.push(s);
    LS.setItem(K.students, JSON.stringify(all));
  }
  /* =============================================================
     STATUS + DISCIPLINE ACTIONS (fine / warning / suspension …)
     ============================================================= */

  /* The status only ever gets more serious (requirement 13);
     recording a warning on a suspended student changes nothing. */
  async function setStatus(studentId, newStatus, opts) {
    opts = opts || {};
    const s = await getStudentById(studentId);
    if (!s) return { ok: false, message: "This student could not be found." };
    const downgrade = !UI.isMoreSerious(newStatus, s.status);
    if (downgrade && !opts.allowDowngrade) {
      return { ok: true, student: s, unchanged: true };
    }
    const res = await updateStudent(studentId, { status: newStatus });
    if (!res.ok) return res;
    return { ok: true, student: res.student, changed: s.status !== newStatus };
  }

  /* =============================================================
     REMOVAL (soft delete) + UNDO (requirement 11)
     ============================================================= */

  async function removeStudent(studentId, reason) {
    const s = await getStudentById(studentId);
    if (!s) return { ok: false, message: "This student could not be found." };
    const snapshot = cleanStudent(s);
    const res = await updateStudent(studentId, {
      removed: true,
      notes: (s.notes ? s.notes + " | " : "") +
        "Removed from register" + (reason ? " — " + reason : "") +
        " on " + new Date().toLocaleDateString("en-US"),
    });
    if (!res.ok) return res;
    await addHistory(studentId, "note",
      "Removed from the register" + (reason ? " — " + reason : "") + ".", null);
    /* Undo restores the exact previous record. */
    const undo = async () => {
      const restored = cleanStudent({ ...snapshot, removed: false });
      await saveStudentRow(restored);
      await addHistory(studentId, "note", "Returned to the register (removal undone).", null);
    };
    return { ok: true, student: res.student, undo };
  }

  /* =============================================================
     HISTORY (requirement 12)
     types: fine | warning | suspension | note
     ============================================================= */

  async function addHistory(studentId, type, description, extra) {
    const entry = {
      id: newId(),
      student_id: studentId,
      type,
      description,
      amount: extra && extra.amount != null ? Number(extra.amount) : null,
      paid: !!(extra && extra.paid),
      created_by: extra && extra.created_by ? extra.created_by : "",
      created_at: new Date().toISOString(),
    };
    if (CONNECTED) {
      const row = { student_id: entry.student_id, type: entry.type, description: entry.description };
      if (entry.amount != null) row.amount = entry.amount;
      if (entry.paid) row.paid = true;
      row.owner_id = await currentUid();
      const { error } = await sb.from("history").insert(row);
      if (error) throw new Error(friendlyMessage(error));
    } else {
      const all = JSON.parse(LS.getItem(K.history) || "[]");
      all.push(entry);
      LS.setItem(K.history, JSON.stringify(all));
    }
    return entry;
  }

  async function getHistory(studentId) {
    if (CONNECTED) {
      const uid = await currentUid();
      const { data, error } = await sb.from("history").select("*")
        .eq("owner_id", uid).eq("student_id", studentId)
        .order("created_at", { ascending: false });
      if (error) throw new Error(friendlyMessage(error));
      return data || [];
    }
    const all = JSON.parse(LS.getItem(K.history) || "[]");
    return all.filter((h) => h.student_id === studentId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  async function getHistoryEntry(historyId) {
    if (CONNECTED) {
      const uid = await currentUid();
      const { data } = await sb.from("history").select("*")
        .eq("owner_id", uid).eq("id", historyId).maybeSingle();
      return data || null;
    }
    const all = JSON.parse(LS.getItem(K.history) || "[]");
    return all.find((h) => h.id === historyId) || null;
  }

  /* Mark a fine as paid — never deleted, so the record stays honest. */
  async function markFinePaid(historyId) {
    const entry = await getHistoryEntry(historyId);
    if (!entry || entry.type !== "fine") return { ok: false, message: "This fine could not be found." };
    if (entry.paid) return { ok: true };
    if (CONNECTED) {
      const { error } = await sb.from("history").update({ paid: true }).eq("id", historyId);
      if (error) throw new Error(friendlyMessage(error));
    } else {
      const all = JSON.parse(LS.getItem(K.history) || "[]");
      const i = all.findIndex((h) => h.id === historyId);
      if (i >= 0) { all[i].paid = true; LS.setItem(K.history, JSON.stringify(all)); }
    }
    return { ok: true };
  }

  /* Remove a fine completely (wrong entry). The student's status is
     recalculated from whatever records remain. */
  async function removeFine(historyId) {
    const entry = await getHistoryEntry(historyId);
    if (!entry || entry.type !== "fine") return { ok: false, message: "This fine could not be found." };
    if (CONNECTED) {
      const { error } = await sb.from("history").delete().eq("id", historyId);
      if (error) throw new Error(friendlyMessage(error));
    } else {
      const all = JSON.parse(LS.getItem(K.history) || "[]");
      LS.setItem(K.history, JSON.stringify(all.filter((h) => h.id !== historyId)));
    }
    await recalcStatusFromHistory(entry.student_id);
    await addHistory(entry.student_id, "note", "Fine of " + (entry.amount ? "Rs. " + entry.amount : "") + " removed by mistake correction.", null);
    return { ok: true };
  }

  /* Work out the fairest status from the records that remain. */
  async function recalcStatusFromHistory(studentId) {
    const hist = await getHistory(studentId);
    const active = hist.filter((h) => !h.paid && h.type !== "note");
    let status = "ACTIVE";
    for (const h of active) {
      if (UI.isMoreSerious(h.type.toUpperCase(), status)) status = h.type.toUpperCase();
    }
    const s = await getStudentById(studentId);
    if (s && s.status !== status) {
      await updateStudent(studentId, { status });
    }
  }

  /* =============================================================
     BULK IMPORT (Excel) + import history (requirement 22)
     ============================================================= */

  async function bulkAddStudents(list) {
    const added = [];
    const skipped = [];
    for (const s of list) {
      const res = await addStudent(s);
      if (res.ok) added.push(res.student);
      else skipped.push({ student: s, message: res.message });
    }
    const summary = {
      when: new Date().toISOString(),
      added: added.length,
      skipped: skipped.length,
      names: added.slice(0, 50).map((s) => s.name),
    };
    const past = await getSetting("import_history", []);
    past.unshift(summary);
    await setSetting("import_history", past.slice(0, 20));
    return { added, skipped };
  }

  /* Undo a whole import: removes exactly the students it added. */
  async function undoBulkAdd(addedStudents) {
    let undone = 0;
    for (const s of addedStudents) {
      const full = await getStudentById(s.id);
      if (full) {
        const all = JSON.parse(LS.getItem(K.students) || "[]");
        /* trial mode: remove completely, import was the only source */
        LS.setItem(K.students, JSON.stringify(all.filter((x) => x.id !== s.id)));
        undone++;
      }
    }
    if (CONNECTED) {
      const ids = addedStudents.map((s) => s.id).filter(Boolean);
      if (ids.length) {
        await sb.from("history").delete().in("student_id", ids);
        await sb.from("students").delete().in("id", ids);
        undone = ids.length;
      }
    }
    return undone;
  }

  /* =============================================================
     SETTINGS (proctor preferences, remembered between visits)
     ============================================================= */

  async function getSetting(key, fallback) {
    if (CONNECTED) {
      const uid = await currentUid();
      const { data } = await sb.from("settings").select("value")
        .eq("owner_id", uid).eq("key", key).maybeSingle();
      if (data && data.value != null) {
        try { return typeof data.value === "string" ? JSON.parse(data.value) : data.value; }
        catch (e) { return data.value; }
      }
      return fallback;
    }
    const all = JSON.parse(LS.getItem(K.settings) || "{}");
    return all[key] !== undefined ? all[key] : fallback;
  }

  async function setSetting(key, value) {
    if (CONNECTED) {
      const payload = { key, value: JSON.stringify(value), owner_id: await currentUid() };
      const { error } = await sb.from("settings").upsert(payload, { onConflict: "owner_id,key" });
      if (error) throw new Error(friendlyMessage(error));
      return;
    }
    const all = JSON.parse(LS.getItem(K.settings) || "{}");
    all[key] = value;
    LS.setItem(K.settings, JSON.stringify(all));
  }
  /* Recent events across the whole register (home screen feed).
     Joins the student's name so entries can link to the profile. */
  async function getRecentActivity(limit) {
    const max = limit || 6;
    if (CONNECTED) {
      const uid = await currentUid();
      const { data, error } = await sb.from("history")
        .select("id, student_id, type, description, amount, paid, created_at, students(name)")
        .eq("owner_id", uid)
        .order("created_at", { ascending: false })
        .limit(max);
      if (error) throw new Error(friendlyMessage(error));
      return (data || []).map((h) => ({
        id: h.id,
        type: h.type,
        description: h.description,
        amount: h.amount,
        paid: h.paid,
        created_at: h.created_at,
        studentId: h.student_id,
        studentName: (h.students && h.students.name) || "Unknown student",
      }));
    }
    const hist = JSON.parse(LS.getItem(K.history) || "[]");
    const studs = JSON.parse(LS.getItem(K.students) || "[]");
    return hist.slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, max)
      .map((h) => {
        const s = studs.find((x) => x.id === h.student_id);
        return { ...h, studentId: h.student_id, studentName: s ? s.name : "Unknown student" };
      });
  }

  /* =============================================================
     COUNTS + EXPORT (home screen numbers, backups)
     ============================================================= */

  async function getStats() {
    const all = await getStudents({ includeRemoved: true });
    const active = all.filter((s) => !s.removed);
    const byStatus = { ACTIVE: 0, WARNING: 0, FINED: 0, SUSPENDED: 0, EXPELLED: 0 };
    active.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
    const attention = active.filter((s) => s.status !== "ACTIVE").length;
    return { total: active.length, removed: all.length - active.length, byStatus, attention };
  }

  /* A complete backup file the proctor can keep safe. */
  async function exportBackup() {
    const students = await getStudents({ includeRemoved: true });
    let history = [];
    if (CONNECTED) {
      const uid = await currentUid();
      const { data, error } = await sb.from("history").select("*").eq("owner_id", uid)
        .order("created_at", { ascending: false });
      if (error) throw new Error(friendlyMessage(error));
      history = data || [];
    } else {
      history = JSON.parse(LS.getItem(K.history) || "[]");
    }
    return {
      app: "Proctor Register",
      when: new Date().toISOString(),
      students,
      history,
    };
  }

  /* CSV of the student list for sharing (Rs. amounts included). */
  function studentsToCsv(students) {
    const head = ["Name", "Student ID", "Class", "Section", "Department", "Semester",
      "Phone", "Email", "Father/Guardian", "Guardian Phone", "Blood Group",
      "Hostel Status", "Date of Birth", "CNIC", "Address", "Status", "Notes"];
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(",")];
    students.forEach((s) => {
      lines.push([s.name, s.student_id, s.class_name, s.section, s.department, s.semester,
        s.phone, s.email, s.father_name, s.guardian_phone, s.blood_group,
        s.hostel, s.dob, s.cnic, s.address, s.status, s.notes].map(esc).join(","));
    });
    return lines.join("\r\n");
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- small helpers ---------- */

  function newId() {
    return "id_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* Guard for every page except the sign-in screen. */
  async function requireSession() {
    const session = await getSession();
    if (!session) {
      window.location.replace("index.html");
      return null;
    }
    return session;
  }

  const isTrialMode = !CONNECTED;

  /* ---------- everything the rest of the app may use ---------- */
  return {
    isTrialMode, isConnected: CONNECTED,
    getSession, signIn, signInWithGoogle, signOut, requireSession,
    getStudents, getStudentById, findStudentByStudentId, searchStudents,
    addStudent, updateStudent, removeStudent,
    setStatus, addHistory, getHistory, markFinePaid, removeFine,
    bulkAddStudents, undoBulkAdd,
    getSetting, setSetting, getRecentActivity,
    getStats, exportBackup, studentsToCsv, downloadFile,
  };
})();



