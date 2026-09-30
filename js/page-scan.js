/* Guided two-shot card scan.
   The camera shows a live guide; the user frames the card and presses
   Capture (or uploads a photo) for each side. Every photo gets ONE
   instant verdict — accepted (flip side) or a specific reason to retake.
   A persistent OCR worker + QR read the card on-device, then the fields
   are handed to the Add Student form. The review screen holds whatever
   was read when the user gives up and goes by hand. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome(null);
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  const $ = (id) => document.getElementById(id);
  const CARD_ASPECT = 1.586;          /* width / height of a CR80 card */

  const video = $("cam");
  const shotImg = $("shot");
  const guide = $("guide");

  let phase = "front";                /* front | back | done | review */
  let worker = null;
  let workerPromise = null;
  let workerFailed = false;
  let camStream = null;
  let busy = false;
  const results = { frontText: "", backText: "", qrFront: "", qrBack: "" };
  /* dev aid: lets the test harness see what each OCR pass produced */
  window.__scanDebug = { results: results, texts: [] };

  const steps = { 1: $("step-1"), 2: $("step-2"), 3: $("step-3") };
  function setSteps(n) {
    for (const i of [1, 2, 3]) {
      steps[i].classList.toggle("active", i === n);
      steps[i].classList.toggle("done", i < n);
    }
  }
  setSteps(1);

  function setStatus(main, sub) {
    $("scan-status").textContent = main;
    if (sub !== undefined) $("scan-sub").textContent = sub;
  }
  function setScanError(msg) {
    const box = $("scan-error");
    box.textContent = msg || "";
    box.classList.toggle("show", !!msg);
  }
  function setBusy(b) {
    busy = b;
    $("snap-btn").disabled = b;
    $("file-input").disabled = b;
  }
  function sideHint(side) {
    return side === "back"
      ? ["Point at the BACK of the card", "The address and QR code are on the back — fill the box."]
      : ["Point at the FRONT of the card", "Fill the box with the card — flat, steady, good light."];
  }
  function syncCaptureLabel() {
    $("snap-btn").textContent = "Capture " + (phase === "back" ? "Back" : "Front");
  }
  syncCaptureLabel();

  /* ---------- persistent OCR worker (created once, reused forever) ---------- */
  function ensureWorker() {
    if (workerPromise) return workerPromise;
    if (typeof Tesseract === "undefined") {
      workerFailed = true;
      return Promise.reject(new Error("tesseract-not-loaded"));
    }
    setStatus("Downloading the reader (about 7 MB)…",
      "First visit only — it is cached after this.");
    workerPromise = Tesseract.createWorker("eng", 1, {
      logger: (m) => {
        if (worker) return; /* after init, the capture flow owns the status line */
        if (m.status === "recognizing text") return;
        const pct = typeof m.progress === "number" ? Math.round(m.progress * 100) + "%" : "";
        setStatus(m.status ? m.status.replace(/^./, (c) => c.toUpperCase()) + " " + pct : "Loading…",
          "First visit only — it is cached after this.");
      },
    }).then((w) => {
      worker = w;
      if (!busy && (phase === "front" || phase === "back")) {
        const h = sideHint(phase);
        setStatus(h[0], h[1]);
      }
      return w;
    }).catch((err) => {
      workerFailed = true;
      throw err;
    });
    return workerPromise;
  }

  /* All OCR goes through one lock so overlapping reads can't interleave
     setParameters and garble each other. */
  let ocrChain = Promise.resolve();
  function ocr(canvas, psm, whitelist) {
    const job = ocrChain.then(async () => {
      await ensureWorker();
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: whitelist || "",
        preserve_interword_spaces: "1",
      });
      const { data } = await worker.recognize(canvas, {}, { text: true });
      return (data && data.text) || "";
    });
    ocrChain = job.catch(() => {});
    return job;
  }

  /* ---------- camera ---------- */
  function startCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camOff();
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
      audio: false,
    }).then((stream) => {
      camStream = stream;
      video.srcObject = stream;
      video.hidden = false;
      $("camoff").hidden = true;
      $("snap-btn").hidden = false;
    }).catch(camOff);
  }
  function camOff() {
    video.hidden = true;
    $("camoff").hidden = false;
    $("snap-btn").hidden = true;
    setStatus(phase === "back" ? "Upload a photo of the BACK." : "Upload a photo of the FRONT.",
      "Use the Upload a Photo button below.");
  }
  function stopCam() {
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    video.srcObject = null;
  }

  /* ---------- geometry + image prep ---------- */
  function cardRect(w, h) {
    const sa = w / h;
    if (sa > CARD_ASPECT) {
      const cw = Math.round(h * CARD_ASPECT);
      return { x: Math.round((w - cw) / 2), y: 0, w: cw, h: h };
    }
    const ch = Math.round(w / CARD_ASPECT);
    return { x: 0, y: Math.round((h - ch) / 2), w: w, h: ch };
  }
  function subRect(r, fx, fy, fw, fh) {
    return {
      x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy),
      w: Math.round(r.w * fw), h: Math.round(r.h * fh),
    };
  }

  /* grayscale + contrast stretch + upscale, with a small white margin */
  function drawStrip(src, rect, targetW) {
    const scale = Math.min(4, Math.max(1, targetW / rect.w));
    const pad = 14;
    const c = document.createElement("canvas");
    c.width = Math.round(rect.w * scale) + pad * 2;
    c.height = Math.round(rect.h * scale) + pad * 2;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src.el, rect.x, rect.y, rect.w, rect.h, pad, pad, c.width - pad * 2, c.height - pad * 2);
    stretchContrast(ctx, c);
    return c;
  }

  function stretchContrast(ctx, c) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      hist[g]++;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    const total = c.width * c.height;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
    if (hi - lo >= 30) {
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        lut[v] = Math.max(0, Math.min(255, Math.round((v - lo) * 255 / (hi - lo))));
      }
      for (let i = 0; i < d.length; i += 4) {
        d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* is there actually a card filling the guide? (rejects empty table) */
  function cardPresent(src, rect) {
    try {
      const c = document.createElement("canvas");
      c.width = 80;
      c.height = Math.max(20, Math.round(80 * rect.h / rect.w));
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(src.el, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0, sum = 0, sum2 = 0;
      for (let i = 0; i < d.length; i += 4) {
        const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        sum += g; sum2 += g * g; n++;
      }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      return mean > 35 && mean < 235 && sd > 13;
    } catch (e) { return true; /* if we cannot tell, try reading anyway */ }
  }

  function decodeQr(src, rect) {
    if (typeof jsQR === "undefined") return "";
    try {
      const scale = Math.min(1, 1000 / rect.w);
      const c = document.createElement("canvas");
      c.width = Math.round(rect.w * scale);
      c.height = Math.round(rect.h * scale);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(src.el, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const found = jsQR(d.data, d.width, d.height);
      return found && found.data ? found.data : "";
    } catch (e) { return ""; }
  }

  /* ---------- one read of a photo ---------- */
  /* A real photo can be tilted, partly outside the box, or have the
     text somewhere my fixed crops don't expect — so try several
     regions/PSMs against the validators and stop at the first that
     reads. Everything else is a cheap fallback. */
  function scoreFound(r) {
    const f = r && r.found;
    if (!f) return -1;
    return (f.name ? 1 : 0) + (f.student_id ? 2 : 0) +
      (f.class_name ? 1 : 0) + (f.address ? 2 : 0);
  }

  function rotateSrc(src, deg) {
    const c = document.createElement("canvas");
    c.width = src.w; c.height = src.h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(src.el, -src.w / 2, -src.h / 2, src.w, src.h);
    return { el: c, w: c.width, h: c.height };
  }

  /* Projection-profile skew estimate: rotate a small copy of the card
     region over a few angles; the angle that makes the rows of text
     line up sharpest is the correction. */
  function estimateSkew(src, rect) {
    try {
      const w = 360;
      const h = Math.max(40, Math.round(w * rect.h / Math.max(1, rect.w)));
      const base = document.createElement("canvas");
      base.width = w; base.height = h;
      const bx = base.getContext("2d", { willReadFrequently: true });
      bx.fillStyle = "#fff"; bx.fillRect(0, 0, w, h);
      bx.drawImage(src.el, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
      const angles = [-12, -9, -6, -3, 0, 3, 6, 9, 12];
      let best = 0, bestScore = -1;
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i];
        const cc = document.createElement("canvas");
        cc.width = w; cc.height = h;
        const cx = cc.getContext("2d", { willReadFrequently: true });
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
        cx.translate(w / 2, h / 2);
        cx.rotate(a * Math.PI / 180);
        cx.drawImage(base, -w / 2, -h / 2);
        const d = cx.getImageData(0, 0, w, h).data;
        const rows = new Float64Array(h);
        let sum = 0;
        for (let y = 0; y < h; y++) {
          let ink = 0;
          const row = y * w;
          for (let x = 0; x < w; x++) {
            const p = (row + x) * 4;
            if ((d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < 150) ink++;
          }
          rows[y] = ink;
          sum += ink;
        }
        const mean = sum / h;
        let v = 0;
        for (let y = 0; y < h; y++) { const t = rows[y] - mean; v += t * t; }
        if (v > bestScore) { bestScore = v; best = a; }
      }
      return best;
    } catch (e) { return 0; }
  }

  async function attempt(side, src, opts) {
    const card = cardRect(src.w, src.h);
    if (!opts.upload && !cardPresent(src, card)) return { present: false };

    const full = { x: 0, y: 0, w: src.w, h: src.h };
    const qr = decodeQr(src, card) || decodeQr(src, full);
    let step = 0;
    const tick = () => {
      step++;
      setStatus("Reading the photo…", "Trying view " + step + " — one moment.");
    };

    const cands = side === "front"
      ? [[card, "6", 1200], [card, "4", 1200], [full, "11", 1500]]
      : [[subRect(card, 0, 0, 1, 0.58), "6", 1200], [card, "4", 1300], [full, "11", 1500]];
    const valid = side === "front" ? ScanParse.validateFront : ScanParse.validateBack;

    let best = null, bestText = "";
    for (let i = 0; i < cands.length; i++) {
      tick();
      const text = await ocr(drawStrip(src, cands[i][0], cands[i][2]), cands[i][1], "");
      const r = ScanParse.parseCard(side === "front" ? text : "", side === "front" ? "" : text, qr);
      window.__scanDebug.texts.push({ side: side, cand: i, psm: cands[i][1], valid: valid(r),
        found: r.found, text: text.slice(0, 500) });
      if (!best || scoreFound(r) > scoreFound(best)) { best = r; bestText = text; }
      if (valid(r)) return { present: true, text: text, r: r, qr: qr };
    }

    if (side === "front" && !best.found.student_id) {
      /* digits-only pass over the whole card: the ID can be anywhere */
      tick();
      const t = await ocr(drawStrip(src, card, 1400), "7", "0123456789");
      const m = t.match(/\d{7,12}/);
      if (m) {
        const merged = bestText + "\n" + m[0];
        const r = ScanParse.parseCard(merged, "", qr);
        if (valid(r)) return { present: true, text: merged, r: r, qr: qr };
        if (scoreFound(r) > scoreFound(best)) { best = r; bestText = merged; }
      }
    }

    /* tilted card: deskew once and try again */
    const ang = estimateSkew(src, card);
    if (Math.abs(ang) >= 3) {
      const rot = rotateSrc(src, ang);
      tick();
      const text = await ocr(drawStrip(rot, card, 1300), "4", "");
      const r = ScanParse.parseCard(side === "front" ? text : "", side === "front" ? "" : text, qr);
      if (valid(r)) return { present: true, text: text, r: r, qr: qr };
      if (scoreFound(r) > scoreFound(best)) { best = r; bestText = text; }
    }

    return { present: true, text: bestText, r: best, qr: qr };
  }

  function foundBits(r) {
    const bits = [];
    if (r.found.name) bits.push("name");
    if (r.found.student_id) bits.push("ID");
    if (r.found.class_name) bits.push("class");
    if (r.found.address) bits.push("address");
    return bits.length ? bits.join(", ") : "nothing readable yet";
  }

  function record(side, res) {
    if (side === "front") {
      results.frontText = res.text;
      if (res.qr) results.qrFront = res.qr;
    } else {
      results.backText = res.text;
      if (res.qr) results.qrBack = res.qr;
    }
  }

  /* ---------- verdict for one photo ---------- */
  function judge(side, res) {
    if (!res || !res.present) {
      setStatus("No card found in that photo.",
        "Fill the box with the card — flat, steady, good light.");
      return;
    }
    record(side, res);
    const ok = side === "front"
      ? ScanParse.validateFront(res.r)
      : ScanParse.validateBack(res.r);
    if (ok) { accept(side); return; }
    setStatus(
      side === "front"
        ? "Couldn't read the name + ID from that photo."
        : "Couldn't read the address from that photo.",
      "Read so far: " + foundBits(res.r) +
        (side === "front"
          ? " — try again closer, straighter, no glare."
          : " — keep the whole back inside the box.")
    );
  }

  /* Read one frozen photo: dataUrl already visible in #shot. */
  async function readPhoto(dataUrl, opts) {
    if (busy) return;
    setBusy(true);
    setScanError("");
    shotImg.src = dataUrl;
    shotImg.hidden = false;
    video.hidden = true;
    try { await shotImg.decode(); } catch (e) { /* decode() unsupported: onload fallback */ }
    if (!shotImg.naturalWidth) {
      await new Promise((resolve) => { shotImg.onload = resolve; shotImg.onerror = resolve; });
    }

    const side = phase;
    let res = null;
    try {
      await ensureWorker();
    } catch (err) {
      finishShot();
      fatal("The card reader could not load — check your internet connection.");
      return;
    }
    setStatus("Reading the photo…", "");
    try {
      res = await attempt(side, { el: shotImg, w: shotImg.naturalWidth, h: shotImg.naturalHeight }, opts);
    } catch (err) {
      res = null;
      if (workerFailed) {
        finishShot();
        fatal("The card reader could not load — check your internet connection.");
        return;
      }
    }
    finishShot();
    judge(side, res);
  }

  function finishShot() {
    shotImg.hidden = true;
    shotImg.src = "";
    if (camStream) video.hidden = false;
    setBusy(false);
  }

  /* ---------- controls ---------- */
  $("snap-btn").addEventListener("click", () => {
    if (busy || (phase !== "front" && phase !== "back")) return;
    if (!video.videoWidth) {
      setStatus("The camera isn't ready yet.", "Wait a moment, or use Upload a Photo.");
      return;
    }
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    readPhoto(c.toDataURL("image/jpeg", 0.92), { upload: false });
  });

  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.type && file.type.indexOf("image/") !== 0) {
      setScanError("Please choose an image file (jpg or png).");
      return;
    }
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) { setScanError("Could not read that file. Try another photo."); return; }
    readPhoto(dataUrl, { upload: true });
  });

  /* With anything read so far, "Enter Details by Hand" opens the review
     screen pre-filled instead of an empty form. */
  $("manual-link").addEventListener("click", (e) => {
    if (results.frontText || results.backText) {
      e.preventDefault();
      failToReview("We stopped before the card was fully read.");
    }
  });

  /* ---------- accept / finish / review ---------- */
  function accept(side) {
    guide.classList.add("accept");
    if (side === "front") {
      phase = "back";
      setSteps(2);
      $("guide-label").textContent = "BACK";
      syncCaptureLabel();
      setStatus("Front read — flip to the BACK.",
        "Capture the back: the address and QR code.");
      setTimeout(() => guide.classList.remove("accept"), 700);
    } else {
      setStatus("Back read — adding the student…", "");
      setTimeout(() => { guide.classList.remove("accept"); finish(); }, 450);
    }
  }

  function finish() {
    phase = "done";
    stopCam();
    const r = ScanParse.parseCard(results.frontText, results.backText, results.qrBack || results.qrFront);
    if (ScanParse.validateFront(r)) {
      try {
        sessionStorage.setItem("pr_scan_prefill", JSON.stringify({
          name: r.name,
          student_id: r.student_id,
          class_name: r.class_name,
          address: r.address,
          notes: r.notes,
        }));
      } catch (e) { /* the form still works without prefill */ }
      setSteps(3);
      window.location.href = "add-student.html?from=scan";
    } else {
      failToReview("Only part of the card could be read — please check the details.");
    }
  }

  function failToReview(msg) {
    phase = "review";
    stopCam();
    const r = ScanParse.parseCard(results.frontText, results.backText, results.qrBack || results.qrFront);
    showReview(r, msg);
  }

  function fatal(msg) {
    phase = "review";
    stopCam();
    setStatus("Could not start the card reader.", msg);
    setScanError(msg);
    $("snap-btn").disabled = true;
    $("file-input").disabled = true;
  }

  /* ---------- review (fallback only) ---------- */
  const REVIEW_FIELDS = [
    ["name", "rv-name"],
    ["student_id", "rv-student_id"],
    ["class_name", "rv-class_name"],
    ["address", "rv-address"],
    ["notes", "rv-notes"],
  ];

  function showReview(r, msg) {
    $("scan-view").hidden = true;
    $("review-view").hidden = false;
    window.scrollTo({ top: 0 });

    let found = 0;
    REVIEW_FIELDS.forEach(([key, id]) => {
      /* only trust fields that actually parsed */
      $(id).value = r.found[key] ? r[key] : "";
      const wrap = $("fw-" + key);
      const missing = !r.found[key];
      wrap.classList.toggle("missing", missing);
      let hintEl = wrap.querySelector(".miss-hint");
      if (missing) {
        if (!hintEl) {
          hintEl = document.createElement("span");
          hintEl.className = "miss-hint";
          wrap.appendChild(hintEl);
        }
        hintEl.textContent = "Not clearly readable — please check or type it.";
      } else if (hintEl) {
        hintEl.remove();
      }
      if (r.found[key]) found++;
    });
    $("review-summary").innerHTML = (msg ? escapeHtml(msg) + " " : "") +
      '<span class="sb-num">' + found + " of " + REVIEW_FIELDS.length + "</span> fields read.";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function reviewError(msg) {
    const box = $("review-error");
    box.textContent = msg || "";
    box.classList.toggle("show", !!msg);
    if (msg) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("continue-btn").addEventListener("click", () => {
    const data = {};
    REVIEW_FIELDS.forEach(([key, id]) => {
      data[key] = $(id).value.trim().replace(/\s+/g, " ");
    });
    $("rv-name").classList.remove("invalid");
    $("rv-student_id").classList.remove("invalid");
    if (!data.name) {
      $("rv-name").classList.add("invalid");
      return reviewError("Please enter the student's name.");
    }
    if (!data.student_id) {
      $("rv-student_id").classList.add("invalid");
      return reviewError("Please enter the student ID.");
    }
    reviewError("");
    try {
      sessionStorage.setItem("pr_scan_prefill", JSON.stringify(data));
    } catch (e) { /* prefill is best-effort */ }
    window.location.href = "add-student.html?from=scan";
  });

  $("restart-btn").addEventListener("click", () => {
    results.frontText = ""; results.backText = "";
    results.qrFront = ""; results.qrBack = "";
    $("review-view").hidden = true;
    $("scan-view").hidden = false;
    setScanError("");
    reviewError("");
    $("snap-btn").disabled = false;
    $("file-input").disabled = false;
    phase = "front";
    setSteps(1);
    $("guide-label").textContent = "FRONT";
    syncCaptureLabel();
    const h = sideHint("front");
    setStatus(h[0], h[1]);
    startCam();
  });

  /* ---------- start: reader download and camera kick off together ---------- */
  ensureWorker().catch(() => { /* surfaced by fatal() on first use */ });
  startCam();
})();
