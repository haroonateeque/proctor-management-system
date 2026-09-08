/* Home screen: hero greeting, live counts, quick actions, activity feed. */
(async () => {
  const session = await DB.requireSession();
  if (!session) return;
  UI.buildChrome("home");

  /* greeting + today's date in the hero band */
  const name = (session.email || "").split("@")[0];
  const nice = name.charAt(0).toUpperCase() + name.slice(1);
  const hr = new Date().getHours();
  const part = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  document.getElementById("greeting").textContent = part + ", " + nice;
  document.getElementById("hero-date").textContent = new Date().toLocaleDateString("en-US",
    { weekday: "long", month: "long", day: "numeric" });

  /* stroke icons in the quick-start cards */
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = UI.icon(el.dataset.icon);
  });

  /* short "time ago" labels for the activity feed */
  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(diff)) return "";
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " hr ago";
    const days = Math.floor(diff / 86400);
    if (days < 7) return days === 1 ? "1 day ago" : days + " days ago";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  const TYPE_META = {
    fine:       { icon: "warn", cls: "tone-danger", label: "Fine" },
    warning:    { icon: "warn", cls: "tone-warn",   label: "Warning" },
    suspension: { icon: "stop", cls: "tone-danger", label: "Suspension" },
    note:       { icon: "note", cls: "",            label: "Note" },
  };

  /* ---------- counts ---------- */
  try {
    const stats = await DB.getStats();
    if (stats.total > 0 || stats.removed > 0) {
      document.getElementById("stats-zone").hidden = false;
      const cards = [
        { icon: "users", num: stats.total, label: "In register", cls: "" },
        { icon: "warn",  num: stats.attention, label: "Need attention", cls: "sc-warn" },
      ];
      if (stats.removed > 0) {
        cards.push({ icon: "stop", num: stats.removed, label: "Removed", cls: "sc-danger" });
      }
      document.getElementById("stats-grid").innerHTML = cards.map((c) =>
        '<div class="stat-card ' + c.cls + '">' +
        '<span class="sc-icon">' + UI.icon(c.icon) + "</span>" +
        '<div class="st-num">' + c.num + "</div>" +
        '<div class="st-label">' + UI.escapeHtml(c.label) + "</div></div>"
      ).join("");

      /* status chips — only the statuses that actually exist */
      const chips = [
        ["st-warning", "Warnings", stats.byStatus.WARNING],
        ["st-fined", "Fined", stats.byStatus.FINED],
        ["st-suspended", "Suspended", stats.byStatus.SUSPENDED],
        ["st-expelled", "Expelled", stats.byStatus.EXPELLED],
      ].filter(function (c) { return c[2] > 0; });
      if (chips.length) {
        const chipZone = document.getElementById("status-chips");
        chipZone.hidden = false;
        chipZone.innerHTML = chips.map((c) =>
          '<span class="chip ' + c[0] + '">' + c[2] + " " + c[1] + "</span>"
        ).join("");
      }
    } else {
      document.getElementById("hero-sub").textContent =
        "Your register is empty — add your first student to get started.";
    }
  } catch (err) {
    UI.toast(err.message || "Could not load your counts.", { type: "error" });
  }

  /* ---------- recent activity ---------- */
  try {
    const acts = await DB.getRecentActivity(6);
    if (acts.length) {
      document.getElementById("activity-zone").hidden = false;
      document.getElementById("activity-list").innerHTML = acts.map((a) => {
        const meta = TYPE_META[a.type] || TYPE_META.note;
        const amount = a.type === "fine" && a.amount != null
          ? " · " + UI.formatMoney(a.amount) + (a.paid ? " (paid)" : " (unpaid)")
          : "";
        return '<li><a class="activity-item" href="student.html?id=' +
          encodeURIComponent(a.studentId) + '">' +
          '<span class="icon ' + meta.cls + '">' + UI.icon(meta.icon) + "</span>" +
          '<span class="ai-main"><span class="ai-title">' + UI.escapeHtml(a.studentName) + "</span>" +
          '<span class="ai-sub">' + UI.escapeHtml(a.description) + amount + "</span></span>" +
          '<span class="ai-when">' + UI.escapeHtml(timeAgo(a.created_at)) + "</span></a></li>";
      }).join("");
    }
  } catch (err) {
    /* the activity feed is a nice-to-have; stay quiet if it fails */
  }
})();
