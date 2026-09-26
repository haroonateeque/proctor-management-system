/* =============================================================
   Shared interface helpers — messages, dialogs, formatting.
   Written in plain language on purpose: nothing technical
   ever reaches the proctor.
   ============================================================= */

const UI = (() => {

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function formatDate(d) {
    const date = new Date(d);
    if (isNaN(date)) return "";
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  function formatMoney(n) {
    const v = Number(n);
    if (isNaN(v)) return "";
    return "Rs. " + v.toLocaleString("en-US");
  }

  /* Statuses always show their full text (requirement 14). */
  const STATUSES = ["ACTIVE", "WARNING", "FINED", "SUSPENDED", "EXPELLED"];
  const SEVERITY = { ACTIVE: 0, WARNING: 1, FINED: 2, SUSPENDED: 3, EXPELLED: 4 };

  function statusBadge(status) {
    const s = String(status || "ACTIVE").toUpperCase();
    return '<span class="status-badge st-' + s.toLowerCase() + '">' + escapeHtml(s) + "</span>";
  }

  function isMoreSerious(newStatus, currentStatus) {
    return (SEVERITY[newStatus] || 0) > (SEVERITY[currentStatus] || 0);
  }

  /* ---------- toasts (success / undo messages) ---------- */
  function toast(message, opts) {
    opts = opts || {};
    let zone = document.querySelector(".toast-zone");
    if (!zone) {
      zone = document.createElement("div");
      zone.className = "toast-zone";
      document.body.appendChild(zone);
    }
    const t = document.createElement("div");
    t.className = "toast " + (opts.type || "info");
    t.innerHTML = '<span class="toast-msg">' + escapeHtml(message) + "</span>" +
      (opts.actionLabel ? '<button class="toast-action">' + escapeHtml(opts.actionLabel) + "</button>" : "");
    zone.appendChild(t);
    const ms = opts.duration || (opts.actionLabel ? 7000 : 3500);
    const kill = () => t.remove();
    if (opts.actionLabel) {
      t.querySelector(".toast-action").addEventListener("click", () => {
        kill();
        if (opts.onAction) opts.onAction();
      });
    }
    setTimeout(kill, ms);
  }
  /* ---------- confirmations (requirement 9) ---------- */
  /* Shared dialog behaviour: Escape cancels, the Tab key cycles
     inside the dialog only, and a click on the dark backdrop closes. */
  function watchDialog(overlay, close) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const items = overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";
      overlay.innerHTML =
        '<div class="dialog" role="dialog" aria-modal="true">' +
        "<h3>" + escapeHtml(opts.title) + "</h3>" +
        '<p class="dialog-desc">' + (opts.message || "") + "</p>" +
        '<div class="dialog-actions">' +
        '<button class="btn btn-secondary" data-act="cancel">' + escapeHtml(opts.cancelLabel || "Cancel") + "</button>" +
        '<button class="btn ' + (opts.danger ? "btn-danger" : "btn-primary") + '" data-act="ok">' +
        escapeHtml(opts.confirmLabel || "Confirm") + "</button>" +
        "</div></div>";
      document.body.appendChild(overlay);
      overlay.querySelector('[data-act="ok"]').focus();
      let done = false;
      const close = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
      watchDialog(overlay, () => close(false));
      overlay.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]");
        if (act && act.dataset.act === "cancel") close(false);
        if (act && act.dataset.act === "ok") close(true);
      });
    });
  }

  /* ---------- quick-add dialogs (requirement 15) ---------- */
  function fieldHtml(f) {
    const val = f.value == null ? "" : escapeHtml(String(f.value));
    const ph = escapeHtml(f.placeholder || "");
    if (f.type === "select") {
      const opts = (f.options || []).map((o) =>
        '<option value="' + escapeHtml(o) + '"' + (String(o) === String(f.value) ? " selected" : "") + ">" +
        escapeHtml(o) + "</option>").join("");
      return '<div class="field"><label>' + escapeHtml(f.label) + "</label>" +
        '<select name="' + f.name + '">' +
        (f.placeholder ? '<option value="">' + escapeHtml(f.placeholder) + "</option>" : "") +
        opts + "</select></div>";
    }
    if (f.type === "textarea") {
      return '<div class="field"><label>' + escapeHtml(f.label) + "</label>" +
        '<textarea name="' + f.name + '" placeholder="' + ph + '">' + val + "</textarea></div>";
    }
    const list = f.list ? ' list="' + f.list + '"' : "";
    const type = f.type || "text";
    return '<div class="field"><label>' + escapeHtml(f.label) + "</label>" +
      '<input type="' + type + '" name="' + f.name + '" value="' + val + '" placeholder="' + ph + '"' + list + "></div>";
  }

  function formDialog(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";
      overlay.innerHTML =
        '<div class="dialog" role="dialog" aria-modal="true">' +
        "<h3>" + escapeHtml(opts.title) + "</h3>" +
        (opts.description ? '<p class="dialog-desc">' + escapeHtml(opts.description) + "</p>" : "") +
        (opts.fields || []).map(fieldHtml).join("") +
        '<div class="dialog-actions">' +
        '<button class="btn btn-secondary" data-act="cancel">' + escapeHtml(opts.cancelLabel || "Cancel") + "</button>" +
        '<button class="btn btn-primary" data-act="ok">' + escapeHtml(opts.confirmLabel || "Save") + "</button>" +
        "</div></div>";
      document.body.appendChild(overlay);
      const first = overlay.querySelector("input, select, textarea");
      if (first) first.focus();
      let done = false;
      const close = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
      watchDialog(overlay, () => close(null));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(null);
        const act = e.target.closest("[data-act]");
        if (!act) return;
        if (act.dataset.act === "cancel") close(null);
        if (act.dataset.act === "ok") {
          const values = {};
          let ok = true;
          (opts.fields || []).forEach((f) => {
            const el = overlay.querySelector('[name="' + f.name + '"]');
            const v = el ? el.value.trim() : "";
            if (f.required && !v) { el.classList.add("invalid"); ok = false; }
            else if (el) el.classList.remove("invalid");
            values[f.name] = v;
          });
          if (!ok) return;
          close(values);
        }
      });
    });
  }
  /* ---------- friendly empty states (requirement 20) ---------- */
  function emptyState(opts) {
    return '<div class="empty-state">' +
      '<div class="empty-icon">' + (opts.icon || "🔍") + "</div>" +
      '<div class="empty-title">' + escapeHtml(opts.title) + "</div>" +
      '<div class="empty-desc">' + escapeHtml(opts.description || "") + "</div>" +
      (opts.action ? '<a class="btn btn-primary" href="' + opts.action.href + '">' +
        escapeHtml(opts.action.label) + "</a>" : "") +
      "</div>";
  }

  function spinner() {
    return '<div class="empty-state"><div class="empty-title">Loading…</div></div>';
  }

  /* ---------- inline stroke icons (replace emoji everywhere) ---------- */
  const ICONS = {
    book: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    home: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5"/><path d="M5 8.5V21h14V8.5"/><path d="M10 21v-6h4v6"/></svg>',
    users: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M21 21v-2a4 4 0 0 0-3-3.87"/><path d="M15 3.13a4 4 0 0 1 0 7.75"/></svg>',
    upload: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/></svg>',
    grid: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    signout: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
    userplus: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>',
    search: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
    save: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
    sheet: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h2"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    history: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    help: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17.5h.01"/></svg>',
    money: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.5 8.5c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.7.8 2.7 2.1-1.2 2.1-2.7 2.1c-1.2 0-2.2-.5-2.7-1.4"/><path d="M12 5.5v2m0 9v2"/></svg>',
    warn: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    stop: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    note: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    edit: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    print: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
    clock: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    question: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17.5h.01"/></svg>',
    moon: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };

  function icon(name) {
    return ICONS[name] || "";
  }

  /* ---------- page chrome (top bar + mobile bottom nav).
      Pass null to skip chrome on drill-down pages that have
      their own back-button header. ---------- */
  function buildChrome(active) {
    if (!active) return;
    const top = document.createElement("div");
    top.className = "topbar";
    const brand = '<span class="brand">' + icon("book") + "<span>Proctor Register</span></span>";
    const links = [
      ["home.html", "Home", "home", "home"],
      ["students.html", "Students", "users", "students"],
      ["upload.html", "Excel", "upload", "upload"],
      ["more.html", "More", "grid", "more"],
      ["#signout", "Sign Out", "signout", "signout"],
    ];
    top.innerHTML = '<div class="topbar-inner">' + brand + '<span class="spacer"></span>' +
      links.map((l) =>
        '<a class="nav-link' + (l[3] === active ? " active" : "") + '" href="' + l[0] + '">' + l[1] + "</a>"
      ).join("") + "</div>";
    document.body.prepend(top);

    const bottom = document.createElement("nav");
    bottom.className = "bottom-nav";
    bottom.innerHTML = links.filter((l) => l[3] !== "signout").map((l) =>
      '<a class="' + (l[3] === active ? "active" : "") + '" href="' + l[0] + '">' +
      '<span class="icon">' + icon(l[2]) + "</span>" + l[1] + "</a>"
    ).join("");
    document.body.appendChild(bottom);

    document.querySelectorAll('a[href="#signout"]').forEach((a) => {
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        await DB.signOut();
        window.location.href = "index.html";
      });
    });
  }
  /* ---------- dark mode (preference kept on this device) ---------- */
  function setTheme(dark) {
    if (dark) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("pr-theme", dark ? "dark" : "light"); } catch (e) { /* ignore */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#122019" : "#1d3a30");
    return dark;
  }

  return {
    escapeHtml, debounce, formatDate, formatMoney, icon,
    statusBadge, isMoreSerious, toast, confirmDialog, formDialog,
    emptyState, spinner, buildChrome, setTheme,
  };
})();



/* ---------- PWA: offline support (registered on every page) ---------- */
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' ||
     location.hostname === '127.0.0.1')) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
