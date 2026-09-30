/* Pure text extraction for the ID-card scanner.
   Takes OCR text from the card's front/back plus an optional QR payload
   and pulls out the fields the Add Student form needs. Deliberately
   browser-free so it can be unit-tested outside a browser. */
const ScanParse = (() => {
  const ID_RE = /\b\d{7,12}\b/g;

  const BOILERPLATE = [
    /forman/i, /christian/i, /chartered/i, /university/i, /^college$/i,
    /baccalaureate/i, /must be displayed/i, /college\/university premises/i,
    /in case of loss/i, /chief proctor/i, /ferozepur/i, /\b54600\b/i,
    /fccu/i, /^\d+\.\s/, /valid\s*upto/i, /^\w{3,9},?\s+\d{4}$/,
    /love.{0,15}serve/i, /one another/i, /^a charter/i, /by love/i,
  ];

  const KNOWN_CLASS_RE = new RegExp(
    "^(bs|ba|bsc|bca|bba|bbs|msc|ma|mba|mca|mphil|phd|llb|bed|med" +
    "|dit|adp|fsc|fa|ics|dpt|mbbs|pharm)[\\s.+-].*$|^(bs|ba|bsc|bca|bba" +
    "|bbs|msc|ma|mba|mca|mphil|phd|llb|bed|med|dit|adp|fsc|fa|ics|dpt" +
    "|mbbs|pharm)[a-z]{0,4}$",
    "i"
  );
  const SHORT_CLASS_RE = /^[A-Z]{2,5}$/;
  const CLASS_STOP = /^(THE|AND|FOR|NEW|ALL|CARD|ID|NO|TYPE|PCR|CIA)$/;

  function toLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function isBoilerplate(line) {
    return BOILERPLATE.some((re) => re.test(line));
  }

  function digitsOnly(s) {
    return String(s || "").replace(/\D/g, "");
  }

  function digitRuns(line) {
    return (String(line).match(ID_RE) || []).slice();
  }

  /* Student ID: prefer a QR payload that also appears printed on the card,
     then a pure digit line on the front, then any 7-12 digit run. */
  function extractId(frontLines, backLines, qrData) {
    const qrDigits = digitsOnly(qrData);
    const qrId = qrDigits.length >= 6 && qrDigits.length <= 12 ? qrDigits : "";
    const all = frontLines.concat(backLines);

    const pureDigit = frontLines.find(
      (l) => /^\d{7,12}$/.test(digitsOnly(l)) && digitsOnly(l).length >= 7
    );
    const runs = [];
    all.forEach((l) => digitRuns(l).forEach((d) => runs.push(d)));

    if (qrId && (pureDigit === qrId || runs.includes(qrId))) {
      return { id: qrId, crossChecked: true };
    }
    if (pureDigit) return { id: digitsOnly(pureDigit), crossChecked: false };
    if (runs.length) return { id: runs[0], crossChecked: false };
    if (qrId) return { id: qrId, crossChecked: false };
    return { id: "", crossChecked: false };
  }

  /* Class/program line, e.g. "BCS" or "BS Computer Science". */
  function extractClass(frontLines) {
    const lines = frontLines.filter((l) => !isBoilerplate(l));
    for (const l of lines) {
      if (KNOWN_CLASS_RE.test(l)) return l.replace(/[.,;]+$/, "");
    }
    for (const l of lines) {
      if (SHORT_CLASS_RE.test(l) && !CLASS_STOP.test(l)) {
        return l.replace(/[.,;]+$/, "");
      }
    }
    return "";
  }

  /* Student name: whatever is left on the front after removing the
     header, the ID digits, the class line and other boilerplate. */
  function extractName(frontLines, id, classLine) {
    const out = [];
    for (const l of frontLines) {
      if (isBoilerplate(l)) continue;
      if (classLine && l === classLine) continue;
      if (!/[A-Z]/.test(l)) continue;
      const d = digitsOnly(l);
      if (id && d.includes(id)) continue;
      if (/^\d[\d\s#-]*$/.test(l)) continue;
      if (/^address/i.test(l)) continue;
      out.push(l);
      if (out.length >= 5) break;
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  }

  /* Address: the block after "Address:" on the back, stopping at the
     numbered rules. Falls back to the lines before the first rule. */
  function extractAddress(backLines) {
    const start = backLines.findIndex((l) => /^address\b/i.test(l));
    const out = [];
    if (start >= 0) {
      for (let i = start + 1; i < backLines.length; i++) {
        const l = backLines[i];
        if (isBoilerplate(l) || /^\d+\.\s/.test(l)) break;
        out.push(l);
      }
    } else {
      for (const l of backLines) {
        if (isBoilerplate(l) || /^\d+\.\s/.test(l)) break;
        out.push(l);
      }
    }
    return out.join(" ").replace(/\s+/g, " ").replace(/\s+([.,])/g, "$1").trim();
  }

  /* "Valid Upto: July, 2029" (either side) → a note for the form. */
  function extractNotes(frontLines, backLines) {
    const all = frontLines.concat(backLines);
    for (let i = 0; i < all.length; i++) {
      if (!/valid\s*upto/i.test(all[i])) continue;
      let v = all[i].replace(/.*valid\s*upto/i, "").replace(/^\s*[:.-]?\s*/, "").trim();
      if (!v && all[i + 1] && !/valid\s*upto/i.test(all[i + 1])) v = all[i + 1].trim();
      if (v) {
        v = v.replace(/,/g, " ").replace(/\s+/g, " ").trim();
        return "Card valid until " + v;
      }
    }
    return "";
  }

  function parseCard(frontText, backText, qrData) {
    const front = toLines(frontText);
    const back = toLines(backText);
    const idInfo = extractId(front, back, qrData);
    const classLine = extractClass(front);
    const name = extractName(front, idInfo.id, classLine);
    const address = extractAddress(back);
    const notes = extractNotes(front, back);

    return {
      name: name,
      student_id: idInfo.id,
      class_name: classLine,
      address: address,
      notes: notes,
      qr: String(qrData || ""),
      idCrossChecked: idInfo.crossChecked,
      found: {
        name: !!name,
        student_id: !!idInfo.id,
        class_name: !!classLine,
        address: !!address,
        notes: !!notes,
      },
    };
  }

  return {
    parseCard, toLines, isBoilerplate, digitsOnly,
    extractId, extractClass, extractName, extractAddress, extractNotes,
  };
})();
