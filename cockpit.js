// Cockpit: accesso (login e recupero password) e scelta del servizio.
// I servizi sono pagine separate (budget/, planning/…): la sessione Supabase è nel localStorage
// dello stesso sito, quindi si accede una volta sola.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const views = ["loading", "login", "recovery", "cockpit"];
  function showView(name) { views.forEach((v) => { $("#view-" + v).hidden = v !== name; }); }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  // ---------- tema chiaro / scuro (stessa scelta del budget) ----------
  $("#btn-theme").addEventListener("click", () => { toast(window.Theme.toggle() === "dark" ? "Tema scuro" : "Tema chiaro"); });

  // ---------- Supabase ----------
  const C = window.CONFIG || {};
  if (!C.SUPABASE_URL || /XXXX/.test(C.SUPABASE_URL) || !C.SUPABASE_PUBLISHABLE_KEY || /XXXX/.test(C.SUPABASE_PUBLISHABLE_KEY)) {
    showView("login");
    $("#login-msg").textContent = "Configurazione mancante: inserisci URL e chiave Supabase in shared/config.js.";
    $("#form-login button[type=submit]").disabled = true;
    return;
  }
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_PUBLISHABLE_KEY);
  let recovery = false, userId = null;

  function showCockpit() {
    showView("cockpit");
    const v = $("#view-cockpit"); v.classList.add("enter"); setTimeout(() => v.classList.remove("enter"), 1200);
  }

  sb.auth.onAuthStateChange((event, session) => {
    // differito: evita di chiamare supabase dentro la callback
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") { recovery = true; showView("recovery"); return; }
      if (recovery) return;
      if (session) { if (userId !== session.user.id) { userId = session.user.id; showCockpit(); } }
      else { userId = null; showView("login"); }
    }, 0);
  });

  $("#form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#login-msg"); msg.textContent = ""; msg.className = "msg";
    const { error } = await sb.auth.signInWithPassword({ email: $("#login-email").value.trim(), password: $("#login-pass").value });
    if (error) msg.textContent = "Email o password non corretti.";
  });
  $("#form-recovery").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#rec-msg"); msg.textContent = "";
    const { error } = await sb.auth.updateUser({ password: $("#rec-pass").value });
    if (error) { msg.textContent = "Password non valida o link scaduto (minimo 8 caratteri)."; return; }
    recovery = false; $("#rec-pass").value = "";
    const { data } = await sb.auth.getSession();
    if (data.session) { userId = data.session.user.id; showCockpit(); } else showView("login");
  });
  $("#btn-logout").addEventListener("click", () => sb.auth.signOut());
})();
