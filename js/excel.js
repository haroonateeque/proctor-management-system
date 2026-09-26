/* =============================================================
   Excel reader
   -------------------------------------------------------------
   Reads the Excel file and figures out what the columns mean,
   so the proctor never has to think about column names.
   ============================================================= */

const Excel = (() => {

  const LABELS = {
    name: "Student Name",
    student_id: "Student ID",
    class_name: "Class",
    section: "Section",
    department: "Department",
    semester: "Semester",
    phone: "Phone",
    email: "Email",
    father_name: "Father / Guardian Name",
    guardian_phone: "Guardian Phone",
    blood_group: "Blood Group",
    hostel: "Hostel Status",
    dob: "Date of Birth",
    cnic: "CNIC / National ID",
    address: "Address",
    notes: "Notes",
  };

  /* Different universities use different column names.
     These are the words we look for. */
  const ALIASES = {
    name: ["name", "studentname", "studentsname", "fullname", "student", "candidatename", "candidate"],
    student_id: ["studentid", "id", "rollno", "rollnumber", "roll", "regno", "regnumber",
                 "registrationno", "registrationnumber", "studentno", "studentnumber", "stdid"],
    class_name: ["class", "classname", "program", "degree", "course", "batch", "level"],
    section: ["section", "sec", "group"],
    department: ["department", "dept", "faculty"],
    semester: ["semester", "sem", "term", "year", "session"],
    phone: ["phone", "phoneno", "phonenumber", "mobile", "mobileno", "mobilenumber",
            "contact", "contactno", "contactnumber", "cell", "cellno"],
    email: ["email", "emailaddress", "mail", "emailid"],
    father_name: ["fathername", "fathersname", "guardianname", "guardian", "father",
                  "parentname", "parent", "fathersguardianname", "fgname"],
    guardian_phone: ["guardianphone", "guardianphoneno", "guardiancontact", "guardianmobile",
                     "fatherphone", "fathermobile", "parentphone", "parentcontact",
                     "fathersguardianphonenumber", "fgphone"],
    blood_group: ["bloodgroup", "blood", "bgroup"],
    hostel: ["hostel", "hostelstatus", "residency", "residencystatus",
             "boarding", "hostelordayscholar", "dayscholarorhostel"],
    dob: ["dob", "dateofbirth", "birthdate", "birthday", "dateofbirth"],
    cnic: ["cnic", "cnicno", "cnicnumber", "nationalid", "nationalidentitycard",
           "idcardno", "idcard", "nic", "nicno", "bform"],
    address: ["address", "homeaddress", "permanentaddress", "residentialaddress", "city"],
    notes: ["notes", "note", "remarks", "remark", "comment", "comments"],
  };

  const REQUIRED = ["name", "student_id"];

  function norm(h) {
    return String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /* Pick the best column for each field. Choices remembered from
     previous uploads are reused whenever the column names match. */
  function detectColumns(headers, savedMapping) {
    const used = new Set();
    const mapping = {};
    const saved = savedMapping || {};

    for (const field of Object.keys(LABELS)) {
      const wanted = norm(saved[field]);
      if (!wanted) continue;
      const hit = headers.find((h) => !used.has(h) && norm(h) === wanted);
      if (hit) { mapping[field] = hit; used.add(hit); }
    }

    for (const field of Object.keys(ALIASES)) {
      if (mapping[field]) continue;
      const hit = headers.find((h) => !used.has(h) && ALIASES[field].includes(norm(h)));
      if (hit) { mapping[field] = hit; used.add(hit); }
    }

    return mapping;
  }

  /* Read the first sheet of the file. */
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });

    let headerIdx = grid.findIndex(
      (r) => r.filter((c) => String(c).trim() !== "").length >= 2
    );
    if (headerIdx === -1) headerIdx = 0;

    const headers = grid[headerIdx].map((h) => String(h).trim());
    const rows = [];
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const arr = grid[i];
      if (arr.every((c) => String(c).trim() === "")) continue;
      const obj = {};
      headers.forEach((h, idx) => {
        if (h) obj[h] = arr[idx] == null ? "" : String(arr[idx]).trim().replace(/\s+/g, " ");
      });
      rows.push(obj);
    }
    return { headers: headers.filter(Boolean), rows };
  }

  /* Ignore case, spaces and dashes when comparing student IDs. */
  function idKey(v) {
    return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /* Turn spreadsheet rows into clean student entries.
     - newStudents: ready to be added
     - updates:     rows that change students already in the register
                    (only when opts.mode is "update")
     - alreadyCount: students that are already in the system
     - issues:      rows with problems, explained in plain language
     existing can be a list of student objects (preferred) or plain
     student_id strings — anything with a match counts as existing. */
  function buildImport(rows, mapping, existing, opts) {
    const mode = opts && opts.mode === "update" ? "update" : "new";
    const byKey = new Map();
    (existing || []).forEach((e) => {
      if (e && typeof e === "object") byKey.set(idKey(e.student_id), e);
      else byKey.set(idKey(e), null);
    });
    const newStudents = [];
    const updates = [];
    const issues = [];
    const seen = new Set();
    let alreadyCount = 0;

    rows.forEach((row, i) => {
      const rowNo = i + 2; // +2: spreadsheet rows start at 1, and row 1 is the header
      const get = (f) => {
        const h = mapping[f];
        return h ? String(row[h] == null ? "" : row[h]).trim().replace(/\s+/g, " ") : "";
      };
      const name = get("name");
      const sid = get("student_id");

      if (!name) {
        issues.push(`Row ${rowNo}: the student's name is empty, so this row was skipped.`);
        return;
      }
      if (!sid) {
        issues.push(`Row ${rowNo}: the student ID is empty, so this row was skipped.`);
        return;
      }
      const key = idKey(sid);
      if (seen.has(key)) {
        issues.push(`Row ${rowNo}: Student ID ${sid} appears more than once in the file. Only the first one was kept.`);
        return;
      }
      seen.add(key);
      if (byKey.has(key)) {
        alreadyCount++;
        const hit = byKey.get(key);
        if (mode === "update" && hit && !hit.removed && idKey(hit.student_id) === key) {
          /* only cells the sheet actually filled in, and only when
             the value really differs — student_id itself is never changed */
          const changes = {};
          Object.keys(LABELS).forEach((f) => {
            if (f === "student_id") return;
            const v = get(f);
            if (!v) return;
            const cur = String(hit[f] == null ? "" : hit[f]).trim().replace(/\s+/g, " ");
            if (v !== cur) changes[f] = v;
          });
          if (Object.keys(changes).length) {
            updates.push({ id: hit.id, changes, name: hit.name, student_id: hit.student_id });
          }
        }
        return;
      }

      newStudents.push({
        name,
        student_id: sid,
        class_name: get("class_name"),
        section: get("section"),
        department: get("department"),
        semester: get("semester"),
        phone: get("phone"),
        email: get("email"),
        father_name: get("father_name"),
        guardian_phone: get("guardian_phone"),
        blood_group: get("blood_group"),
        hostel: get("hostel"),
        dob: get("dob"),
        cnic: get("cnic"),
        address: get("address"),
        notes: get("notes"),
      });
    });

    return { newStudents, updates, alreadyCount, issues };
  }

  /* A blank spreadsheet with every column the app understands —
     so a class rep can fill it in without guessing headers. */
  function downloadTemplate() {
    const EXAMPLES = {
      name: "Ahmed Ali",
      student_id: "FA21-BCS-001",
      class_name: "BS Computer Science",
      section: "A",
      department: "Computing",
      semester: "4",
      phone: "03001234567",
      email: "ahmed@example.com",
      father_name: "Muhammad Ali",
      guardian_phone: "03007654321",
      blood_group: "B+",
      hostel: "Hostel",
      dob: "2003-05-14",
      cnic: "35202-1234567-1",
      address: "12 Main Street, Lahore",
      notes: "",
    };
    const fields = Object.keys(LABELS);
    const aoa = [
      fields.map((f) => LABELS[f]),
      fields.map((f) => EXAMPLES[f] || ""),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = fields.map((f) => ({
      wch: Math.max(14, String(EXAMPLES[f] || LABELS[f]).length + 3),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    XLSX.writeFile(wb, "student-list-template.xlsx");
  }

  return { LABELS, REQUIRED, ALIASES, detectColumns, readFile, buildImport, downloadTemplate };
})();
