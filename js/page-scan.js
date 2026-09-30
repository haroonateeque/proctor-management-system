/* Live auto-scan of a student ID card.
   One screen: the camera runs a loop that crops the card inside the
   guide, reads it (persistent OCR worker + QR) and flips front → back
   by itself, then hands the extracted fields to the Add Student form.
   The review screen only appears when the card could not be read. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome(null);
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  const $ = (id) => document.getElementById(id);
  const CARD_ASPECT = 1.586;          /* width / height of a CR80 card */
  const FRONT_BUDGET_MS = 45000;
  const BACK_BUDGET_MS = 25000;

  const video = $("cam");
  const shotImg = $("shot");
  const guide = $("guide");

  let phase = "front";                /* front | back | done | review */
  let loopToken = 0;
  let worker = null;
  let workerPromise = null;
  let workerFailed = false;
  let camStream = null;
  let uploadBusy = false;
  let forceOnce = false;
  const results = { frontText: "", backText: "", qrFront: "", qrBack: "" };

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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        if (worker) return; /* after init, the loop owns the status line */
        if (m.status === "recognizing text") return;
        const pct = typeof m.progress === "number" ? Math.round(m.progress * 100) + "%" : "";
        setStatus(m.status ? m.status.replace(/^./, (c) => c.toUpperCase()) + " " + pct : "Loading…",
          "First visit only — it is cached after this.");
      },
    }).then((w) => {
      worker = w;
      setStatus("Ready.", "");
      return w;
    }).catch((err) => {
      workerFailed = true;
      throw err;
    });
    return workerPromise;
  }

  /* All OCR goes through one lock: the live loop and a user upload may
     overlap, and interleaved setParameters would garble the other read. */
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
  function currentSource() {
    if (!shotImg.hidden && shotImg.naturalWidth) {
      return { el: shotImg, w: shotImg.naturalWidth, h: shotImg.naturalHeight };
    }
    return { el: video, w: video.videoWidth || 0, h: video.videoHeight || 0 };
  }

  /* the part of the source that fills the frame (object-fit: cover) */
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

  /* ---------- one read attempt on the current side ---------- */
  async function attempt(side, src, opts) {
    const card = cardRect(src.w, src.h);
    if (!opts.upload && !forceOnce && !cardPresent(src, card)) return { present: false };
    forceOnce = false;

    const qr = decodeQr(src, card);
    if (side === "front") {
      /* left 66% of the card: header + name + ID + class, no photo */
      const strip = drawStrip(src, subRect(card, 0, 0, 0.66, 1), 1200);
      let text = await ocr(strip, "6", "");
      let r = ScanParse.parseCard(text, "", qr);
      if (!r.found.student_id && !ScanParse.digitsOnly(qr)) {
        /* second pass: middle band, digits only */
        const band = drawStrip(src, subRect(card, 0.02, 0.28, 0.62, 0.44), 1200);
        const digits = await ocr(band, "7", "0123456789");
        const m = digits.match(/\d{7,12}/);
        if (m) r = ScanParse.parseCard(text + "\n" + m[0], "", qr);
      }
      return { present: true, text: text, r: r, qr: qr };
    }
    /* back: top band carries the address block */
    const strip = drawStrip(src, subRect(card, 0, 0, 1, 0.58), 1200);
    const text = await ocr(strip, "6", "");
    const r = ScanParse.parseCard("", text, qr);
    return { present: true, text: text, r: r, qr: qr };
  }

  /* ---------- the auto-scan loop ---------- */
  function hint(side) {
    return side === "front"
      ? ["Show the FRONT of the card", "Lay the card flat and keep it inside the box."]
      : ["Show the BACK of the card", "The address and QR code are on the back."];
  }

  function foundBits(r) {
    const bits = [];
    if (r.found.name) bits.push("name");
    if (r.found.student_id) bits.push("ID");
    if (r.found.class_name) bits.push("class");
    if (r.found.address) bits.push("address");
    return bits.length ? "read the " + bits.join(", ") : "nothing readable yet";
  }

  async function runLoop() {
    const token = ++loopToken;
    const side = phase;
    const deadline = performance.now() + (side === "front" ? FRONT_BUDGET_MS : BACK_BUDGET_MS);
    const base = hint(side);
    setStatus(base[0], base[1]);
    ensureWorker().catch(() => { /* handled inside ocr / fatal below */ });

    let attempts = 0;
    while (token === loopToken && phase === side) {
      if (performance.now() > deadline) break;
      if (uploadBusy) { await sleep(300); continue; }
      const src = currentSource();
      if (!src.w) { await sleep(250); continue; }

      let res;
      try {
        res = await attempt(side, src, {});
      } catch (err) {
        if (workerFailed) { fatal("The card reader could not load — check your internet connection and try again."); return; }
        await sleep(400);
        continue;
      }
      if (token !== loopToken || phase !== side) return;

      if (!res.present) {
        setStatus(base[0], "Center the card and hold it steady.");
        await sleep(350);
        continue;
      }

      if (side === "front") {
        results.frontText = res.text;
        if (res.qr) results.qrFront = res.qr;
      } else {
        results.backText = res.text;
        if (res.qr) results.qrBack = res.qr;
      }

      const ok = side === "front"
        ? ScanParse.validateFront(res.r)
        : ScanParse.validateBack(res.r);
      if (ok) { accept(side); return; }

      attempts++;
      setStatus("Reading… attempt " + attempts,
        side === "front"
          ? "Still " + foundBits(res.r) + " — hold steady in good light."
          : "Found the QR code, still looking for the address — keep the back inside the box.");
      await sleep(250);
    }
    if (token !== loopToken || phase !== side) return;
    if (side === "front") failToReview("We could not read the front of the card clearly.");
    else finish();
  }

  function recordAttempt(side, res) {
    if (side === "front") {
      results.frontText = res.text;
      if (res.qr) results.qrFront = res.qr;
    } else {
      results.backText = res.text;
      if (res.qr) results.qrBack = res.qr;
    }
  }

  function accept(side) {
    guide.classList.add("accept");
    if (side === "front") {
      phase = "back";
      setSteps(2);
      $("guide-label").textContent = "BACK";
      setStatus("Front read — now flip to the BACK", "Show the back of the card in the box.");
      setTimeout(() => guide.classList.remove("accept"), 700);
      runLoop();
    } else {
      setStatus("Back read — adding the student…", "");
      setTimeout(() => { guide.classList.remove("accept"); finish(); }, 450);
    }
  }

  function finish() {
    phase = "done";
    loopToken++;
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
    loopToken++;
    stopCam();
    const r = ScanParse.parseCard(results.frontText, results.backText, results.qrBack || results.qrFront);
    showReview(r, msg);
  }

  function fatal(msg) {
    phase = "review";
    loopToken++;
    stopCam();
    setStatus("Could not start the card reader.", msg);
    setScanError(msg);
    $("snap-btn").disabled = true;
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
      $(id).value = r[key] || "";
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
    phase = "front";
    setSteps(1);
    $("guide-label").textContent = "FRONT";
    startCam();
    runLoop();
  });

  /* ---------- controls ---------- */
  $("snap-btn").addEventListener("click", () => {
    forceOnce = true;
    setStatus("Checking the card…", "");
  });

  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.type && file.type.indexOf("image/") !== 0) {
      setScanError("Please choose an image file (jpg or png).");
      return;
    }
    setScanError("");
    await handleUpload(file);
  });

  async function handleUpload(file) {
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) { setScanError("Could not read that file. Try another photo."); return; }

    loopToken++;                 /* pause the live loop */
    uploadBusy = true;
    shotImg.src = dataUrl;
    shotImg.hidden = false;
    video.hidden = true;
    try { await shotImg.decode(); } catch (e) { /* decode() unsupported: onload fallback */ }
    if (!shotImg.naturalWidth) {
      await new Promise((resolve) => { shotImg.onload = resolve; shotImg.onerror = resolve; });
    }
    setStatus("Checking your photo…", "");

    const side = phase;
    let res = null;
    try {
      res = await attempt(side, { el: shotImg, w: shotImg.naturalWidth, h: shotImg.naturalHeight }, { upload: true });
    } catch (err) {
      res = null;
      if (workerFailed) {
        uploadBusy = false;
        fatal("The card reader could not load — check your internet connection.");
        return;
      }
    }

    shotImg.hidden = true;
    shotImg.src = "";
    if (camStream) video.hidden = false;
    uploadBusy = false;

    if (res && res.present) {
      recordAttempt(side, res);
      const ok = side === "front" ? ScanParse.validateFront(res.r) : ScanParse.validateBack(res.r);
      if (ok) { accept(side); return; }
      setStatus(side === "front"
        ? "That photo did not give a clear name + ID yet."
        : "No address found in that photo.",
        "Try a sharper, closer photo with the whole card in frame.");
      runLoop();
      return;
    }
    setStatus("Could not find the card in that photo.", "Try a closer photo with the whole card visible.");
    runLoop();
  }

  /* ---------- start ---------- */
  startCam();
  runLoop();
})();
