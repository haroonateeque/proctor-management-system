/* Sign-in screen: Google sign-in through Supabase Auth.
   Until js/config.js is filled in, setup steps are shown instead. */
(async () => {
  (function () {
    document.getElementById("login-logo").innerHTML = UI.icon("book");
    document.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = UI.icon(el.dataset.icon);
    });
  })();

  const loginForm = document.getElementById("login-form");
  const setupPanel = document.getElementById("setup-panel");
  const googleBtn = document.getElementById("google-btn");
  const errBox = document.getElementById("login-error");

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add("show");
  }

  if (!DB.isConnected) {
    loginForm.style.display = "none";
    setupPanel.style.display = "block";
    return;
  }

  /* Coming back from Google: supabase-js picks the session up
     from the URL automatically — go straight to the register. */
  if (await DB.getSession()) {
    window.location.replace("home.html");
    return;
  }

  googleBtn.addEventListener("click", async () => {
    errBox.classList.remove("show");
    googleBtn.disabled = true;
    try {
      const res = await DB.signInWithGoogle();
      if (!res.ok) {
        googleBtn.disabled = false;
        showError(res.message || "Could not start Google sign-in. Please try again.");
      }
      /* on success the browser redirects to Google, nothing to do */
    } catch (err) {
      googleBtn.disabled = false;
      showError(err.message || "Could not start Google sign-in. Please try again.");
    }
  });
})();
