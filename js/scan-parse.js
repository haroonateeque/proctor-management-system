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
     then digit-only lines/runs on the front. A candidate must start with a
     non-zero digit (real IDs never do) and a "digit line" must contain no
     letters — otherwise OCR noise like "QV 14.000 29/7 a" becomes an ID. */
  function extractId(frontLines, backLines, qrData) {
    const qrDigits = digitsOnly(qrData);
    const qrId = qrDigits.length >= 6 && qrDigits.length <= 12 ? qrDigits : "";
    const all = frontLines.concat(backLines);

    const pureLines = frontLines
      .filter((l) => !/[a-z]/i.test(l))
      .map(digitsOnly)
      .filter((d) => d.length >= 7 && d.length <= 12);
    const runs = [];
    all.forEach((l) => digitRuns(l).forEach((d) => runs.push(d)));

    const printed = pureLines.concat(runs);
    const usable = (d) => !!d && /^[1-9]/.test(d);

    if (qrId && printed.indexOf(qrId) >= 0) {
      return { id: qrId, crossChecked: true };
    }
    const id = printed.find(usable) || (usable(qrId) ? qrId : "");
    return { id: id, crossChecked: false };
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
      if (/\d{7}/.test(l)) break; /* reached the ID territory — the name
         sits above it; stop so junk below (class tokens, barcodes)
         never joins the name */
      if (!/[A-Z]/.test(l)) continue;
      const d = digitsOnly(l);
      if (id && d.includes(id)) continue;
      if (/^\d[\d\s#-]*$/.test(l)) continue;
      if (/^address/i.test(l)) continue;
      if (/identity|identification/i.test(l)) continue;
      if (/\d/.test(l)) continue; /* names never carry digits — also kills
         OCR-typo'd "Valid Upto: July, 2029" lines that would poison the
         name and fail plausibility */
      if (/upto/i.test(l)) continue;
      if (/^[a-z]{2,5}$/i.test(l)) continue; /* class token like "BCS" */
      out.push(l);
      if (out.length >= 5) break;
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  }

  /* An address must read like one: enough characters and at least two
     real words. Rejects OCR noise such as "00:06:450 129". */
  function looksLikeAddress(a) {
    if (!a || a.trim().length < 10) return false;
    const words = a.split(/\s+/).filter((w) => /[a-z]{3}/i.test(w));
    return words.length >= 2;
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
    const joined = out.join(" ").replace(/\s+/g, " ").replace(/\s+([.,])/g, "$1").trim();
    return looksLikeAddress(joined) ? joined : "";
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

  /* Confidence checks used by the auto-scan loop: a side is only
     "read" when the fields it is supposed to carry actually parsed.
     Names never contain digits; IDs are 7-12 digits and never start
     with 0. Together with extractId's rules this rejects camera noise
     such as a clock pattern OCR'd as "000:01:300". */
  function plausibleName(name) {
    return !!name && !/\d/.test(name) && (name.match(/[a-z]/gi) || []).length >= 5;
  }

  function validateFront(result) {
    return !!(result && result.found && result.found.name && result.found.student_id
      && plausibleName(result.name) && /^[1-9]\d{6,11}$/.test(result.student_id));
  }

  function validateBack(result) {
    return !!(result && result.found && result.found.address
      && looksLikeAddress(result.address));
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
    validateFront, validateBack, looksLikeAddress,
  };
})();
