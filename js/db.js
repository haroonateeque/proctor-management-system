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

  /* Safe localStorage helpers: a corrupted or full store must never
     break the app — worst case we fall back to the default value. */
  function lsGet(key, fallback) {
    try {
      const raw = LS.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try { LS.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  /* Status seriousness — kept here so this module never depends on
     the UI module (script order can then never break the app). */
  const SEVERITY = { ACTIVE: 0, WARNING: 1, FINED: 2, SUSPENDED: 3, EXPELLED: 4 };
  function isMoreSerious(newStatus, currentStatus) {
    return (SEVERITY[newStatus] || 0) > (SEVERITY[currentStatus] || 0);
  }
  /* History record type → the status it stands for. */
  const TYPE_TO_STATUS = {
    fine: "FINED", warning: "WARNING", suspension: "SUSPENDED", expulsion: "EXPELLED",
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
    return lsGet(K.session, null);
  }

  /* The signed-in proctor's Supabase user id. Every saved row is
     tagged with it and every read is filtered by it, so each
     proctor only ever sees their own register — never anyone
     else's students, history, or settings. The e-mail is kept
     alongside so history rows can record who made each entry. */
  let cachedUid = null;
  let cachedEmail = "";
  let uidFetched = false;
  async function currentUser() {
    if (!CONNECTED) return null;
    if (uidFetched) return { id: cachedUid, email: cachedEmail };
    const { data } = await sb.auth.getSession();
    cachedUid = data && data.session ? data.session.user.id : null;
    cachedEmail = data && data.session ? (data.session.user.email || "") : "";
    uidFetched = true;
    return { id: cachedUid, email: cachedEmail };
  }
  async function currentUid() {
    const u = await currentUser();
    return u ? u.id : null;
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
    cachedUid = null;
    cachedEmail = "";
    uidFetched = false;
    invalidateStudents();
    /* belt-and-braces: wipe Supabase's own cached session keys so a
       slow/blocked sign-out request can never leave a live token behind */
    try {
      Object.keys(LS)
        .filter((k) => k.indexOf("sb-") === 0)
        .forEach((k) => LS.removeItem(k));
    } catch (e) { /* ignore */ }
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

  /* One shared read of the whole student table, kept in memory for a
     short time. Search, duplicate checks and counts all reuse it, so
     typing in the search box no longer downloads the register again
     on every keystroke. Every write throws the cache away, and a
     30-second life keeps other devices from appearing stale for long. */
  const CACHE_TTL_MS = 30000;
  let sCache = { rows: null, at: 0 };
  function invalidateStudents() { sCache = { rows: null, at: 0 }; }

  async function allStudentRows() {
    if (sCache.rows && Date.now() - sCache.at < CACHE_TTL_MS) return sCache.rows;
    let rows;
    if (CONNECTED) {
      const uid = await currentUid();
      const { data, error } = await sb.from("students").select("*")
        .eq("owner_id", uid).order("name");
      if (error) throw new Error(friendlyMessage(error));
      rows = data || [];
    } else {
      rows = lsGet(K.students, []);
    }
    sCache = { rows, at: Date.now() };
    return rows;
  }

  async function getStudents(opts) {
    opts = opts || {};
    const includeRemoved = !!opts.includeRemoved;
    const cleaned = (await allStudentRows()).map(cleanStudent);
    const list = includeRemoved ? cleaned : cleaned.filter((s) => !s.removed);
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return list;
  }

  async function getStudentById(id) {
    if (!id) return null;
    const rows = await allStudentRows();
    const found = rows.find((s) => s.id === id);
    return found ? cleanStudent(found) : null;
  }

  /* Forgiving duplicate check (requirement 6): case and spacing
     are ignored, so "A12- 345" and "a12345" count as the same. */
  function idKey(v) {
    return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /* Digits only — so phone numbers match regardless of spaces,
     dashes or a missing country code. */
  function digitsOnly(v) {
    return String(v || "").replace(/\D/g, "");
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
    /* Numbers are compared on digits only: "0300 1234567",
       "0300-1234567" and "03001234567" all hit the same student. */
    const qDigits = digitsOnly(norm);
    return all.filter((s) => {
      const name = s.name.toLowerCase();
      const sid = s.student_id.toLowerCase();
      /* Partial matches on both name and ID (requirement 8) */
      if (name.includes(norm) || sid.includes(norm) || idKey(s.student_id).includes(idKey(norm))) return true;
      /* phone / guardian phone / CNIC / e-mail — parents often call
         with just a number, so those must be searchable too */
      if (norm.length >= 3 && (
        String(s.cnic).toLowerCase().includes(norm) ||
        String(s.email).toLowerCase().includes(norm))) return true;
      if (qDigits.length >= 3 && (
        digitsOnly(s.phone).includes(qDigits) ||
        digitsOnly(s.guardian_phone).includes(qDigits) ||
        digitsOnly(s.cnic).includes(qDigits))) return true;
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
      invalidateStudents();
      return;
    }
    const all = lsGet(K.students, []);
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s; else all.push(s);
    lsSet(K.students, all);
    invalidateStudents();
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
    const downgrade = !isMoreSerious(newStatus, s.status);
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

  /* Remove one or many students in a couple of batch requests
     instead of two round-trips per student. Returns a single undo
     that restores every record exactly as it was. */
  async function removeStudents(ids, reason) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return { ok: false, message: "No students were selected." };

    const rows = await allStudentRows();
    const snapshots = list
      .map((id) => rows.find((r) => r.id === id))
      .filter(Boolean)
      .map(cleanStudent);
    if (!snapshots.length) return { ok: false, message: "These students could not be found." };

    const noteText = "Removed from register" + (reason ? " — " + reason : "") +
      " on " + new Date().toLocaleDateString("en-US");
    const histText = "Removed from the register" + (reason ? " — " + reason : "") + ".";
    const stamp = new Date().toISOString();
    const updated = snapshots.map((s) => ({
      ...s,
      removed: true,
      notes: (s.notes ? s.notes + " | " : "") + noteText,
      updated_at: stamp,
    }));

    if (CONNECTED) {
      const u = await currentUser();
      for (const part of chunk(updated, 200)) {
        const { error } = await sb.from("students")
          .upsert(part.map((s) => ({ ...s, owner_id: u.id })));
        if (error) throw new Error(friendlyMessage(error));
      }
      for (const part of chunk(snapshots, 500)) {
        const { error } = await sb.from("history").insert(part.map((s) => ({
          student_id: s.id, type: "note", description: histText,
          owner_id: u.id, created_by: u.email || "",
        })));
        if (error) throw new Error(friendlyMessage(error));
      }
    } else {
      const all = lsGet(K.students, []);
      const byId = new Map(updated.map((s) => [s.id, s]));
      all.forEach((s, i) => { if (byId.has(s.id)) all[i] = byId.get(s.id); });
      lsSet(K.students, all);
      const hist = lsGet(K.history, []);
      snapshots.forEach((s) => hist.push({
        id: newId(), student_id: s.id, type: "note",
        description: histText, created_at: stamp,
      }));
      lsSet(K.history, hist);
    }
    invalidateStudents();

    /* Undo restores the exact previous records. */
    const undo = async () => {
      if (CONNECTED) {
        const u = await currentUser();
        for (const part of chunk(snapshots, 200)) {
          const { error } = await sb.from("students")
            .upsert(part.map((s) => ({ ...s, owner_id: u.id })));
          if (error) throw new Error(friendlyMessage(error));
        }
        for (const part of chunk(snapshots, 500)) {
          const { error } = await sb.from("history").insert(part.map((s) => ({
            student_id: s.id, type: "note",
            description: "Returned to the register (removal undone).",
            owner_id: u.id, created_by: u.email || "",
          })));
          if (error) throw new Error(friendlyMessage(error));
        }
      } else {
        const all = lsGet(K.students, []);
        const byId = new Map(snapshots.map((s) => [s.id, s]));
        all.forEach((s, i) => { if (byId.has(s.id)) all[i] = byId.get(s.id); });
        lsSet(K.students, all);
        const hist = lsGet(K.history, []);
        snapshots.forEach((s) => hist.push({
          id: newId(), student_id: s.id, type: "note",
          description: "Returned to the register (removal undone).",
          created_at: new Date().toISOString(),
        }));
        lsSet(K.history, hist);
      }
      invalidateStudents();
    };

    return {
      ok: true,
      count: snapshots.length,
      student: snapshots.length === 1 ? cleanStudent(updated[0]) : null,
      undo,
    };
  }

  async function removeStudent(studentId, reason) {
    return removeStudents([studentId], reason);
  }

  /* Record a fine / warning / suspension for many students at once:
     history rows go in as batched inserts and statuses are only ever
     raised (never lowered) in one batched update. */
  async function bulkRecord(ids, type, description, extra) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return { ok: false, count: 0 };

    const amount = extra && extra.amount != null ? Number(extra.amount) : null;
    const paid = !!(extra && extra.paid);
    const stamp = new Date().toISOString();

    if (CONNECTED) {
      const u = await currentUser();
      for (const part of chunk(list, 500)) {
        const rows = part.map((id) => {
          const row = {
            student_id: id, type, description,
            owner_id: u.id, created_by: u.email || "",
          };
          if (amount != null) row.amount = amount;
          if (paid) row.paid = true;
          return row;
        });
        const { error } = await sb.from("history").insert(rows);
        if (error) throw new Error(friendlyMessage(error));
      }
    } else {
      const hist = lsGet(K.history, []);
      list.forEach((id) => hist.push({
        id: newId(), student_id: id, type, description,
        amount, paid, created_by: "", created_at: stamp,
      }));
      lsSet(K.history, hist);
    }

    /* Raise the status of anyone still below this record's seriousness. */
    const target = TYPE_TO_STATUS[type];
    if (target) {
      const rows = await allStudentRows();
      const raise = list.filter((id) => {
        const s = rows.find((r) => r.id === id);
        return s && isMoreSerious(target, String(s.status || "ACTIVE").toUpperCase());
      });
      if (raise.length) await setStatuses(raise, target);
    }
    invalidateStudents();
    return { ok: true, count: list.length };
  }

  /* One batched status change for a list of students. */
  async function setStatuses(ids, status) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return;
    const stamp = new Date().toISOString();
    if (CONNECTED) {
      const uid = await currentUid();
      for (const part of chunk(list, 200)) {
        const { error } = await sb.from("students")
          .update({ status, updated_at: stamp })
          .eq("owner_id", uid).in("id", part);
        if (error) throw new Error(friendlyMessage(error));
      }
    } else {
      const all = lsGet(K.students, []);
      const set = new Set(list);
      all.forEach((s) => {
        if (set.has(s.id)) { s.status = status; s.updated_at = stamp; }
      });
      lsSet(K.students, all);
    }
    invalidateStudents();
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
      const u = await currentUser();
      const row = { student_id: entry.student_id, type: entry.type, description: entry.description };
      if (entry.amount != null) row.amount = entry.amount;
      if (entry.paid) row.paid = true;
      row.owner_id = u ? u.id : null;
      row.created_by = entry.created_by || (u && u.email) || "";
      const { error } = await sb.from("history").insert(row);
      if (error) throw new Error(friendlyMessage(error));
    } else {
      const all = lsGet(K.history, []);
      all.push(entry);
      lsSet(K.history, all);
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
    const all = lsGet(K.history, []);
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
    const all = lsGet(K.history, []);
    return all.find((h) => h.id === historyId) || null;
  }

  /* Mark a fine as paid — never deleted, so the record stays honest.
     The status is recalculated afterwards, the same way it is when a
     fine is removed, so a student is no longer flagged FINED once
     everything outstanding has been settled. */
  async function markFinePaid(historyId) {
    const entry = await getHistoryEntry(historyId);
    if (!entry || entry.type !== "fine") return { ok: false, message: "This fine could not be found." };
    if (entry.paid) return { ok: true };
    if (CONNECTED) {
      const uid = await currentUid();
      const { error } = await sb.from("history").update({ paid: true })
        .eq("id", historyId).eq("owner_id", uid);
      if (error) throw new Error(friendlyMessage(error));
    } else {
      const all = lsGet(K.history, []);
      const i = all.findIndex((h) => h.id === historyId);
      if (i >= 0) { all[i].paid = true; lsSet(K.history, all); }
    }
    await recalcStatusFromHistory(entry.student_id);
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
      const all = lsGet(K.history, []);
      lsSet(K.history, all.filter((h) => h.id !== historyId));
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
      /* history types are lowercase (fine), statuses are uppercase
         (FINED) — map through TYPE_TO_STATUS so fines count too */
      const st = TYPE_TO_STATUS[h.type] || String(h.type || "").toUpperCase();
      if (isMoreSerious(st, status)) status = st;
    }
    const s = await getStudentById(studentId);
    if (s && s.status !== status) {
      await updateStudent(studentId, { status });
    }
  }

  /* =============================================================
     BULK IMPORT (Excel) + import history (requirement 22)
     ============================================================= */

  /* Bulk import: saves everyone in a few large batches instead of
     one request per student, so even 1,000+ rows take seconds.
     Excel.buildImport has already filtered duplicates and existing
     students, so rows can go straight in. */
  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  async function bulkAddStudents(list, opts) {
    const stamp = new Date().toISOString();
    const added = list.map((s) => {
      const row = cleanStudent(s);
      row.id = row.id || newId();
      row.status = "ACTIVE";
      row.removed = false;
      row.created_at = stamp;
      row.updated_at = stamp;
      return row;
    });

    if (CONNECTED) {
      const u = await currentUser();
      let done = 0;
      try {
        for (const part of chunk(added, 200)) {
          const { error } = await sb.from("students").upsert(part.map((s) => ({ ...s, owner_id: u.id })));
          if (error) throw new Error(friendlyMessage(error));
          done += part.length;
        }
        for (const part of chunk(added, 500)) {
          const { error } = await sb.from("history").insert(part.map((s) => ({
            student_id: s.id,
            type: "note",
            description: "Added to the register.",
            owner_id: u.id,
            created_by: u.email || "",
          })));
          if (error) throw new Error(friendlyMessage(error));
        }
      } catch (err) {
        invalidateStudents();
        if (done > 0) throw new Error(done + " students were added, but then it stopped: " + err.message);
        throw err;
      }
      invalidateStudents();
    } else {
      const all = lsGet(K.students, []);
      all.push(...added);
      lsSet(K.students, all);
      const hist = lsGet(K.history, []);
      hist.push(...added.map((s) => ({
        id: "h_" + newId().slice(3),
        student_id: s.id,
        type: "note",
        description: "Added to the register.",
        created_at: stamp,
      })));
      lsSet(K.history, hist);
      invalidateStudents();
    }

    /* the caller may want to write one combined record itself when an
       import both adds and updates (pass { record: false }) */
    if (!(opts && opts.record === false)) {
      await addImportRecord({
        when: stamp,
        added: added.length,
        updated: 0,
        skipped: 0,
        names: added.slice(0, 50).map((s) => s.name),
      });
    }
    return { added, skipped: [] };
  }

  /* One row in the "Past Imports" list on the More screen. */
  async function addImportRecord(summary) {
    const past = await getSetting("import_history", []);
    past.unshift({
      when: (summary && summary.when) || new Date().toISOString(),
      added: (summary && summary.added) || 0,
      updated: (summary && summary.updated) || 0,
      skipped: (summary && summary.skipped) || 0,
      names: ((summary && summary.names) || []).slice(0, 50),
    });
    await setSetting("import_history", past.slice(0, 20));
  }

  /* Undo a whole import: removes exactly the students it added, in a
     few batch requests regardless of how many there were. Deletes are
     chunked too — 1,000+ ids in a single URL would be rejected. */
  async function undoBulkAdd(addedStudents) {
    const ids = (addedStudents || []).map((s) => s.id).filter(Boolean);
    if (!ids.length) return 0;
    if (CONNECTED) {
      for (const part of chunk(ids, 200)) {
        const hist = await sb.from("history").delete().in("student_id", part);
        if (hist.error) throw new Error(friendlyMessage(hist.error));
        const del = await sb.from("students").delete().in("id", part);
        if (del.error) throw new Error(friendlyMessage(del.error));
      }
      invalidateStudents();
      return ids.length;
    }
    const idSet = new Set(ids);
    const all = lsGet(K.students, []);
    lsSet(K.students, all.filter((x) => !idSet.has(x.id)));
    const histL = lsGet(K.history, []);
    lsSet(K.history, histL.filter((h) => !idSet.has(h.student_id)));
    invalidateStudents();
    return ids.length;
  }

  /* Excel import, "update existing" mode: applies {changes} to each
     student. Returns snapshots of the rows exactly as they were, so
     the whole import can be undone in one go. No history entries are
     written per student — the import is recorded as one line instead. */
  async function bulkUpdateStudents(updates) {
    const list = (updates || []).filter((u) => u && u.id && u.changes && Object.keys(u.changes).length);
    if (!list.length) return { updated: 0, snapshots: [], rows: [] };
    const stamp = new Date().toISOString();
    const snapshots = [];
    let rows = [];

    if (CONNECTED) {
      const u = await currentUid();
      const wanted = list.map((x) => x.id);
      const have = new Map();
      for (const part of chunk(wanted, 200)) {
        const { data, error } = await sb.from("students").select("*")
          .eq("owner_id", u.id).in("id", part);
        if (error) throw new Error(friendlyMessage(error));
        (data || []).forEach((s) => have.set(s.id, s));
      }
      list.forEach((x) => {
        const cur = have.get(x.id);
        if (!cur) return;
        snapshots.push({ ...cur });
        rows.push({ ...cur, ...x.changes, updated_at: stamp });
      });
      for (const part of chunk(rows, 200)) {
        const { error } = await sb.from("students")
          .upsert(part.map((s) => ({ ...s, owner_id: u.id })));
        if (error) throw new Error(friendlyMessage(error));
      }
      invalidateStudents();
    } else {
      const all = lsGet(K.students, []);
      const byId = new Map(all.map((s) => [s.id, s]));
      const mergedMap = new Map();
      list.forEach((x) => {
        const cur = byId.get(x.id);
        if (!cur) return;
        snapshots.push({ ...cur });
        const merged = { ...cur, ...x.changes, updated_at: stamp };
        mergedMap.set(cur.id, merged);
      });
      rows = Array.from(mergedMap.values());
      lsSet(K.students, all.map((s) => mergedMap.get(s.id) || s));
      invalidateStudents();
    }

    return { updated: rows.length, snapshots, rows };
  }

  /* Put back the exact rows a bulk update replaced (import undo). */
  async function restoreStudentRows(snapshots) {
    const list = (snapshots || []).filter((s) => s && s.id);
    if (!list.length) return 0;
    if (CONNECTED) {
      const u = await currentUid();
      for (const part of chunk(list, 200)) {
        const { error } = await sb.from("students")
          .upsert(part.map((s) => ({ ...s, owner_id: u.id })));
        if (error) throw new Error(friendlyMessage(error));
      }
      invalidateStudents();
      return list.length;
    }
    const all = lsGet(K.students, []);
    const back = new Map(list.map((s) => [s.id, s]));
    lsSet(K.students, all.map((s) => back.get(s.id) || s));
    invalidateStudents();
    return list.length;
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
    const all = lsGet(K.settings, {});
    return all[key] !== undefined ? all[key] : fallback;
  }

  async function setSetting(key, value) {
    if (CONNECTED) {
      const payload = { key, value: JSON.stringify(value), owner_id: await currentUid() };
      const { error } = await sb.from("settings").upsert(payload, { onConflict: "owner_id,key" });
      if (error) throw new Error(friendlyMessage(error));
      return;
    }
    const all = lsGet(K.settings, {});
    all[key] = value;
    lsSet(K.settings, all);
  }

  /* =============================================================
     WHATSAPP GUARDIAN NOTIFICATIONS
     Country code and wording are proctor settings
     (More → WhatsApp messages).
     ============================================================= */

  const DEFAULT_WA_TEMPLATE =
    "Respected Guardian, a fine of Rs. {amount} has been recorded for {name} (ID: {id}). " +
    "Reason: {reason}. Kindly arrange the payment. Thank you.";

  /* Turns whatever the proctor typed (0301…, 301…, +92 301…, 92301…)
     into a full international number with no + and no spaces. */
  function waNumber(raw, countryCode) {
    const code = String(countryCode || "92").replace(/\D/g, "") || "92";
    let d = String(raw || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.charAt(0) === "0") d = code + d.slice(1);
    else if (d.length <= 10 && d.indexOf(code) !== 0) d = code + d;
    return d;
  }

  function waMessage(template, vars) {
    const v = vars || {};
    return String(template || DEFAULT_WA_TEMPLATE)
      .replace(/\{name\}/g, v.name || "")
      .replace(/\{id\}/g, v.id || "")
      .replace(/\{amount\}/g, v.amount || "")
      .replace(/\{reason\}/g, v.reason || "");
  }

  /* Opens WhatsApp with the message ready to send.
     student: {name, student_id, guardian_phone}
     fine:    {amount, description} */
  async function notifyGuardianOnWhatsApp(student, fine) {
    const phone = student && student.guardian_phone;
    if (!phone) {
      return { ok: false, message: "No guardian phone number saved for this student — add one via Edit first." };
    }
    const code = await getSetting("wa_country_code", "92");
    const template = await getSetting("wa_template", DEFAULT_WA_TEMPLATE);
    const number = waNumber(phone, code);
    if (!number) return { ok: false, message: "That guardian phone number doesn't look right." };
    const msg = waMessage(template, {
      name: (student && student.name) || "",
      id: (student && student.student_id) || "",
      amount: Number((fine && fine.amount) || 0).toLocaleString("en-US"),
      reason: (fine && fine.description) || "",
    });
    window.open("https://wa.me/" + number + "?text=" + encodeURIComponent(msg), "_blank");
    return { ok: true, number, message: msg };
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
    const hist = lsGet(K.history, []);
    const studs = lsGet(K.students, []);
    return hist.slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, max)
      .map((h) => {
        const s = studs.find((x) => x.id === h.student_id);
        return { ...h, studentId: h.student_id, studentName: s ? s.name : "Unknown student" };
      });
  }

  /* Unpaid fines across the register (home screen money card). */
  async function getUnpaidFines() {
    if (CONNECTED) {
      const uid = await currentUid();
      const { data, error } = await sb.from("history")
        .select("id, student_id, type, description, amount, paid, created_at, students(name, guardian_phone)")
        .eq("owner_id", uid).eq("type", "fine").eq("paid", false)
        .order("created_at", { ascending: false });
      if (error) throw new Error(friendlyMessage(error));
      return (data || []).map((h) => ({
        id: h.id,
        studentId: h.student_id,
        studentName: (h.students && h.students.name) || "Unknown student",
        guardianPhone: (h.students && h.students.guardian_phone) || "",
        description: h.description,
        amount: h.amount,
        created_at: h.created_at,
      }));
    }
    const hist = lsGet(K.history, []);
    const studs = lsGet(K.students, []);
    return hist
      .filter((h) => h.type === "fine" && !h.paid)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((h) => {
        const s = studs.find((x) => x.id === h.student_id) || {};
        return {
          id: h.id, studentId: h.student_id,
          studentName: s.name || "Unknown student",
          guardianPhone: s.guardian_phone || "",
          description: h.description, amount: h.amount, created_at: h.created_at,
        };
      });
  }

  /* =============================================================
     COUNTS + EXPORT (home screen numbers, backups)
     ============================================================= */

  async function getStats() {
    if (CONNECTED) {
      /* Counts come from the database, not from downloading every
         student row — much quicker on large registers. */
      const uid = await currentUid();
      const [act, rem] = await Promise.all([
        sb.from("students").select("status", { count: "exact" })
          .eq("owner_id", uid).eq("removed", false),
        sb.from("students").select("id", { count: "exact", head: true })
          .eq("owner_id", uid).eq("removed", true),
      ]);
      if (act.error) throw new Error(friendlyMessage(act.error));
      if (rem.error) throw new Error(friendlyMessage(rem.error));
      const byStatus = { ACTIVE: 0, WARNING: 0, FINED: 0, SUSPENDED: 0, EXPELLED: 0 };
      (act.data || []).forEach((r) => {
        const st = String(r.status || "ACTIVE").toUpperCase();
        byStatus[st] = (byStatus[st] || 0) + 1;
      });
      const total = act.count || 0;
      return {
        total,
        removed: rem.count || 0,
        byStatus,
        attention: total - (byStatus.ACTIVE || 0),
      };
    }
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
      history = lsGet(K.history, []);
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
    addStudent, updateStudent, removeStudent, removeStudents,
    setStatus, addHistory, getHistory, markFinePaid, removeFine,
    bulkAddStudents, undoBulkAdd, bulkRecord,
    bulkUpdateStudents, restoreStudentRows, addImportRecord,
    getSetting, setSetting, getRecentActivity, getUnpaidFines, getHistoryEntry,
    notifyGuardianOnWhatsApp, waNumber, waMessage, DEFAULT_WA_TEMPLATE,
    getStats, exportBackup, studentsToCsv, downloadFile,
  };
})();



