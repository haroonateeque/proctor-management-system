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
     - alreadyCount: students that are already in the system
     - issues: rows with problems, explained in plain language */
  function buildImport(rows, mapping, existingIds) {
    const existing = new Set((existingIds || []).map(idKey));
    const newStudents = [];
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
      if (existing.has(key)) { alreadyCount++; return; }

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

    return { newStudents, alreadyCount, issues };
  }

  return { LABELS, REQUIRED, ALIASES, detectColumns, readFile, buildImport };
})();
