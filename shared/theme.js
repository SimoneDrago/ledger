// Tema chiaro/scuro condiviso dalle pagine (stessa scelta salvata per tutto il sito).
(() => {
  "use strict";
  const KEY = "conti-theme";
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const set = (v) => { try { localStorage.setItem(KEY, v); } catch { /* ignora */ } };
  const systemDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const current = () => document.documentElement.dataset.theme || (systemDark() ? "dark" : "light");
  function toggle() {
    const next = current() === "dark" ? "light" : "dark", root = document.documentElement;
    root.classList.add("theme-anim"); setTimeout(() => root.classList.remove("theme-anim"), 450);
    root.dataset.theme = next; set(next);
    return next;
  }
  window.Theme = { current, toggle, saved: get };
})();
