/* One-shot card scan: frame the card, press Capture (or upload a photo).
   We read the QR code first — exact and instant, no download. If none
   reads, we OCR just the printed student-ID digits (short whitelist
   pass; the reader downloads once, on demand). Either way the ID is
   handed to the Add Student form; name and address are typed by hand.
   Photos never leave the device. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome(null);
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  const $ = (id) => document.getElementById(id);

  /* Card scanning is a mobile job: on a desktop we skip the camera and
     recommend the phone instead (touch-first UA + coarse-pointer check
     also catches iPadOS, which hides its iPad identity). */
  function isHandheld() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPod|iPad|Android|Mobile/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
    try { return matchMedia("(pointer: coarse)").matches; } catch (e) { return false; }
  }
  if (!isHandheld()) {
    $("scan-view").hidden = true;
    $("desktop-view").hidden = false;
    document.title = "Scan ID Card — use your phone";
    return;
  }

  const CARD_ASPECT = 1.586;          /* width / height of a CR80 card */

  const video = $("cam");
  const shotImg = $("shot");
  const guide = $("guide");

  let worker = null;
  let workerPromise = null;
  let workerFailed = false;
  let camStream = null;
  let busy = false;
  let scanning = true;
  /* dev aid: lets the test harness see what the digit passes produced */
  window.__scanDebug = { texts: [] };

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
  function hint() {
    setStatus("Point at the QR code",
      "Fit the whole card in the box — steady, good light, no glare.");
  }

  /* CDN libraries load on demand so the page itself opens instantly and
     a stalled download surfaces as a clear message, never a hang. */
  const JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
  const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  function loadScript(url, ms) {
    return new Promise((resolve, reject) => {
      if (typeof window.__tessLoaded === "undefined") window.__tessLoaded = {};
      const done = url.indexOf("jsQR") >= 0 ? "jsqr" : "tesseract";
      if (window.__tessLoaded[done]) return resolve();
      const el = document.createElement("script");
      const timer = setTimeout(() => { el.remove(); reject(new Error("script-timeout")); }, ms);
      el.src = url;
      el.onload = () => {
        clearTimeout(timer);
        window.__tessLoaded[done] = true;
        resolve();
      };
      el.onerror = () => { clearTimeout(timer); reject(new Error("script-failed")); };
      document.head.appendChild(el);
    });
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
      const p = video.play && video.play();
      if (p && p.catch) p.catch(() => {});
    }).catch(camOff);
  }
  function camOff() {
    video.hidden = true;
    $("camoff").hidden = false;
    $("snap-btn").hidden = true;
    setStatus("Upload a photo of the card.",
      "Use the Upload a Photo button below — the QR code or ID number must be visible.");
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
    if (typeof jsQR === "undefined" || rect.w < 8 || rect.h < 8) return "";
    try {
      const scale = Math.min(1, 1600 / rect.w);
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

  /* Projection-profile skew estimate: rotate a small copy of the card
     region over a few angles; the angle that makes the rows of text
     line up sharpest is the correction. */
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

  function estimateSkew(src, rect) {
    try {
      const w = 360;
      const h = Math.max(40, Math.round(w * rect.h / Math.max(1, rect.w)));
      const base = document.createElement("canvas");
      base.width = w; base.height = h;
      const bx = base.getContext("2d", { willReadFrequently: true });
      bx.fillStyle = "#fff"; bx.fillRect(0, 0, w, h);
      bx.drawImage(src.el, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
      const angles = [-18, -15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15, 18];
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

  /* ---------- persistent OCR worker (only ever reached when no QR read) ---------- */
  function ensureWorker() {
    if (worker) return Promise.resolve(worker);
    if (workerPromise) return workerPromise;
    setStatus("Downloading the ID reader (about 7 MB)…",
      "First time only — cached after this.");
    workerPromise = loadScript(TESS_URL, 15000)
      .then(() => Tesseract.createWorker("eng", 1, {
        logger: (m) => {
          if (worker) return; /* after init, the capture flow owns the status line */
          if (m.status === "recognizing text") return;
          const pct = typeof m.progress === "number" ? Math.round(m.progress * 100) + "%" : "";
          setStatus(m.status ? m.status.replace(/^./, (c) => c.toUpperCase()) + " " + pct : "Loading…",
            "First time only — cached after this.");
        },
      }))
      .then((w) => {
        worker = w;
        if (busy) setStatus("Reading the card…", "");
        return w;
      })
      .catch((err) => {
        workerFailed = true;
        workerPromise = null;   /* the next tap retries from scratch */
        throw err;
      });
    return workerPromise;
  }

  /* Worker setup with a hard deadline: a stalled CDN fetch becomes a
     clear "could not load" message instead of an endless status line. */
  function workerReady(ms) {
    return Promise.race([
      ensureWorker().then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), ms || 45000)),
    ]);
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

  /* ---------- the two readers ---------- */
  /* QR payload -> student ID: exact digits, or digits found inside a
     URL/JSON payload. */
  function idFromPayload(payload) {
    const p = String(payload || "").trim();
    if (/^[1-9]\d{6,11}$/.test(p)) return p;
    const runs = p.match(/\d{6,12}/g) || [];
    for (const r of runs) {
      if (/^[1-9]/.test(r) && r.length >= 7 && r.length <= 12) return r;
    }
    return "";
  }

  /* Printed ID digits: straighten first when the photo is tilted (text
     reads far better straight), then the card region, then the whole
     frame. Whitelist keeps the OCR honest — only digits can come out. */
  async function readDigits(src) {
    const card = cardRect(src.w, src.h);
    const full = { x: 0, y: 0, w: src.w, h: src.h };
    const ang = estimateSkew(src, card);
    const regions = [];
    if (Math.abs(ang) >= 3) regions.push({ src: rotateSrc(src, ang), rect: card });
    regions.push({ src: src, rect: card });
    regions.push({ src: src, rect: full });
    for (const r of regions) {
      for (const psm of ["7", "11"]) {
        const t = await ocr(drawStrip(r.src, r.rect, 1600), psm, "0123456789");
        window.__scanDebug.texts.push({ psm: psm, skew: ang, w: r.rect.w, text: t.slice(0, 200) });
        const hit = (t.match(/\d{7,12}/g) || []).find((d) => /^[1-9]/.test(d));
        if (hit) return hit;
      }
    }
    return "";
  }

  /* ---------- one read of a photo ---------- */
  async function readPhoto(dataUrl, opts) {
    if (busy || !scanning) return;
    setBusy(true);
    setScanError("");
    shotImg.src = dataUrl;
    shotImg.hidden = false;
    video.hidden = true;
    try { await shotImg.decode(); } catch (e) { /* decode() unsupported: onload fallback */ }
    if (!shotImg.naturalWidth) {
      await new Promise((resolve) => { shotImg.onload = resolve; shotImg.onerror = resolve; });
    }
    const src = { el: shotImg, w: shotImg.naturalWidth, h: shotImg.naturalHeight };
    setStatus("Reading the card…", "");

    if (!opts.upload && !cardPresent(src, cardRect(src.w, src.h))) {
      finishShot();
      setStatus("No card found in that photo.",
        "Fit the whole card in the box and try again.");
      return;
    }

    /* 1) QR code — exact, tiny library, loaded on demand */
    if (typeof jsQR === "undefined") {
      try { await loadScript(JSQR_URL, 8000); } catch (e) { /* CDN down: fall through */ }
    }
    let id = idFromPayload(decodeQr(src, cardRect(src.w, src.h)));
    if (!id) id = idFromPayload(decodeQr(src, { x: 0, y: 0, w: src.w, h: src.h }));
    if (id) { finishShot(); accept(id, "qr"); return; }

    /* 2) printed ID digits — needs the reader, downloaded on demand */
    setStatus("No QR code seen — reading the ID number…", "");
    if (!(await workerReady(45000))) {
      finishShot();
      setStatus("The ID reader could not load.",
        "Check your internet and tap Capture again — or upload a photo.");
      return;
    }
    let digits = "";
    try {
      digits = await readDigits(src);
    } catch (err) {
      digits = "";
    }
    finishShot();
    if (digits) {
      accept(digits, "digits");
    } else {
      setStatus("Couldn't find the QR code or ID number.",
        "Move closer, fill the box with the card, avoid glare — or upload a photo.");
    }
  }

  function finishShot() {
    shotImg.hidden = true;
    shotImg.src = "";
    if (camStream) video.hidden = false;
    setBusy(false);
  }

  function accept(id, how) {
    guide.classList.add("accept");
    setStatus(how === "qr"
      ? "QR code read — student ID " + id
      : "Student ID found: " + id,
      "Opening the student form…");
    try {
      sessionStorage.setItem("pr_scan_prefill", JSON.stringify({ student_id: id }));
    } catch (e) { /* the form still works without prefill */ }
    setTimeout(() => {
      scanning = false;
      stopCam();
      window.location.href = "add-student.html?from=scan";
    }, 650);
  }

  /* ---------- controls ---------- */
  $("snap-btn").addEventListener("click", () => {
    if (busy || !scanning) return;
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

  /* ---------- start ---------- */
  hint();
  startCam();
})();
