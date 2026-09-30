/* Scan the front + back of a student ID card with the camera,
   read it with OCR + QR, then hand the extracted fields to the
   Add Student form (via sessionStorage). */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome(null);
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  const $ = (id) => document.getElementById(id);
  const panels = { 1: $("panel-1"), 2: $("panel-2"), 3: $("panel-3") };
  const steps = { 1: $("step-1"), 2: $("step-2"), 3: $("step-3") };
  const shots = { front: null, back: null };
  const streams = { front: null, back: null };
  let reading = false;

  $("reading-icon").innerHTML = UI.icon("clock");
  $("fail-icon").innerHTML = UI.icon("warn");

  /* ---------- step navigation ---------- */
  function goStep(n) {
    for (const i of [1, 2, 3]) {
      panels[i].hidden = i !== n;
      steps[i].classList.toggle("active", i === n);
      steps[i].classList.toggle("done", i < n);
    }
    window.scrollTo({ top: 0 });
    stopCam("front");
    stopCam("back");
    if (n === 1 && !shots.front) startCam("front");
    if (n === 2 && !shots.back) startCam("back");
  }

  /* ---------- camera ---------- */
  function startCam(side) {
    const vid = $("cam-" + side);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return camOff(side);
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
      audio: false,
    }).then((stream) => {
      streams[side] = stream;
      vid.srcObject = stream;
      vid.hidden = false;
      $("camoff-" + side).hidden = true;
      $("shoot-" + side).hidden = false;
    }).catch(() => camOff(side));
  }

  function camOff(side) {
    $("cam-" + side).hidden = true;
    $("camoff-" + side).hidden = false;
    $("shutter-" + side).hidden = true;
  }

  function stopCam(side) {
    const s = streams[side];
    if (s) { s.getTracks().forEach((t) => t.stop()); streams[side] = null; }
    const vid = $("cam-" + side);
    if (vid) vid.srcObject = null;
  }

  function grabVideo(side) {
    const vid = $("cam-" + side);
    const w = vid.videoWidth;
    if (!w || !vid.videoHeight) return null;
    const scale = Math.min(1, 1600 / w);
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(vid.videoHeight * scale);
    c.getContext("2d").drawImage(vid, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.92);
  }

  function setShot(side, dataURL) {
    shots[side] = dataURL;
    stopCam(side);
    $("cam-" + side).hidden = true;
    const img = $("shot-" + side);
    img.src = dataURL;
    img.hidden = false;
    $("shoot-" + side).hidden = true;
    $("confirm-" + side).hidden = false;
    setErr(side, "");
  }

  function clearShot(side, autoStart) {
    shots[side] = null;
    const img = $("shot-" + side);
    img.hidden = true;
    img.src = "";
    $("confirm-" + side).hidden = true;
    $("shoot-" + side).hidden = false;
    setErr(side, "");
    if (autoStart !== false) startCam(side);
  }

  function setErr(side, msg) {
    const box = $("err-" + side);
    box.textContent = msg || "";
    box.classList.toggle("show", !!msg);
  }

  for (const side of ["front", "back"]) {
    $("shutter-" + side).addEventListener("click", () => {
      const dataURL = grabVideo(side);
      if (dataURL) setShot(side, dataURL);
      else setErr(side, "The camera is not ready yet — give it a moment or upload a photo.");
    });

    $("file-" + side).addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.type && file.type.indexOf("image/") !== 0) {
        setErr(side, "Please choose an image file (jpg or png).");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => setShot(side, reader.result);
      reader.onerror = () => setErr(side, "Could not read that file. Try another photo.");
      reader.readAsDataURL(file);
      e.target.value = "";
    });

    $("retake-" + side).addEventListener("click", () => clearShot(side));
  }

  $("use-front").addEventListener("click", () => goStep(2));
  $("use-back").addEventListener("click", () => { goStep(3); readCard(); });

  /* ---------- OCR + QR ---------- */
  function setStatus(text) {
    $("scan-status").textContent = text;
  }

  function tesseractLogger(label) {
    return (m) => {
      if (m.status === "recognizing text") {
        setStatus("Reading the " + label + " of the card… " +
          Math.round((m.progress || 0) * 100) + "%");
      } else if (m.status) {
        setStatus(m.status.replace(/^./, (c) => c.toUpperCase()) + "…");
      }
    };
  }

  function readQr(dataURL) {
    return new Promise((resolve) => {
      if (typeof jsQR === "undefined") return resolve("");
      const img = new Image();
      img.onload = () => {
        try {
          const maxW = 1200;
          const scale = Math.min(1, maxW / img.naturalWidth);
          const c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * scale);
          c.height = Math.round(img.naturalHeight * scale);
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height);
          const found = jsQR(d.data, d.width, d.height);
          resolve(found && found.data ? found.data : "");
        } catch (e) { resolve(""); }
      };
      img.onerror = () => resolve("");
      img.src = dataURL;
    });
  }

  async function readCard() {
    if (reading) return;
    reading = true;
    $("reading-zone").hidden = false;
    $("review-zone").hidden = true;
    $("fail-zone").hidden = true;
    setStatus("Starting the card reader…");

    if (typeof Tesseract === "undefined") {
      return failRead("The card reader library did not load — please check your internet connection and try again.");
    }

    let frontText = "";
    let backText = "";
    try {
      setStatus("Loading the reader the first time can take a minute…");
      const front = await Tesseract.recognize(shots.front, "eng", {
        logger: tesseractLogger("front"),
      });
      frontText = (front.data && front.data.text) || "";
      const back = await Tesseract.recognize(shots.back, "eng", {
        logger: tesseractLogger("back"),
      });
      backText = (back.data && back.data.text) || "";
    } catch (err) {
      return failRead("Reading failed: " + (err.message || err));
    }

    setStatus("Checking the QR code…");
    const qr = (await readQr(shots.back)) || (await readQr(shots.front)) || "";
    reading = false;
    renderReview(ScanParse.parseCard(frontText, backText, qr));
  }

  function failRead(reason) {
    reading = false;
    $("reading-zone").hidden = true;
    $("fail-zone").hidden = false;
    $("fail-reason").textContent = reason;
    window.scrollTo({ top: 0 });
  }

  $("retry-read-btn").addEventListener("click", () => readCard());

  /* ---------- review ---------- */
  const REVIEW_FIELDS = [
    ["name", "rv-name"],
    ["student_id", "rv-student_id"],
    ["class_name", "rv-class_name"],
    ["address", "rv-address"],
    ["notes", "rv-notes"],
  ];

  function renderReview(ex) {
    $("reading-zone").hidden = true;
    $("review-zone").hidden = false;
    window.scrollTo({ top: 0 });

    let found = 0;
    REVIEW_FIELDS.forEach(([key, id]) => {
      $(id).value = ex[key] || "";
      const wrap = $("fw-" + key);
      const missing = !ex.found[key];
      wrap.classList.toggle("missing", missing);
      let hint = wrap.querySelector(".miss-hint");
      if (missing) {
        if (!hint) {
          hint = document.createElement("span");
          hint.className = "miss-hint";
          wrap.appendChild(hint);
        }
        hint.textContent = "Not clearly readable — please check or type it.";
      } else if (hint) {
        hint.remove();
      }
      if (ex.found[key]) found++;
    });

    const cross = ex.idCrossChecked
      ? " The QR code matched the printed ID."
      : "";
    $("review-summary").innerHTML =
      '<span class="sb-num">' + found + " of " + REVIEW_FIELDS.length +
      "</span> fields read from the card." + cross;
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
    } catch (e) { /* the form still works without prefill */ }
    window.location.href = "add-student.html?from=scan";
  });

  $("restart-btn").addEventListener("click", () => {
    clearShot("front", false);
    clearShot("back", false);
    reviewError("");
    goStep(1);
  });

  /* ---------- start ---------- */
  for (const side of ["front", "back"]) {
    $("shoot-" + side).hidden = false;
    $("cam-" + side).hidden = true;
  }
  goStep(1);
})();
