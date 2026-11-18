// Planning: calendario di ferie e permessi per più persone, con banca ore annuale.
(() => {
  "use strict";
  const P = window.Plan;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } };
  const pad = (n) => String(n).padStart(2, "0");
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const COLORI = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];
  const okColore = (c) => /^#[0-9a-f]{6}$/i.test(c || "");

  const t0 = todayIso();
  const state = {
    persone: [], banche: [], voci: [], pid: null,
    anno: Number(t0.slice(0, 4)), mese: Number(t0.slice(5, 7)) - 1, vista: "mese",
    tool: "ferie", ferieTipo: "intera", permOre: 1, userId: null, editing: null, confirmDel: null,
  };

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
  const showView = (name) => { $("#view-loading").hidden = name !== "loading"; $("#view-app").hidden = name !== "app"; };

  // ---------- Supabase ----------
  const goCockpit = () => { window.location.replace("../"); };
  const C = window.CONFIG || {};
  if (!C.SUPABASE_URL || /XXXX/.test(C.SUPABASE_URL) || !C.SUPABASE_PUBLISHABLE_KEY || /XXXX/.test(C.SUPABASE_PUBLISHABLE_KEY)) { goCockpit(); return; }
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_PUBLISHABLE_KEY);
  const isAuthError = (e) => e && (e.status === 401 || /JWT|expired|not authenticated/i.test(e.message || ""));
  async function handleError(e, fallback) {
    if (isAuthError(e)) { toast("Sessione scaduta: accedi di nuovo."); await sb.auth.signOut(); return; }
    toast(fallback || "Operazione non riuscita. Controlla la connessione e riprova.");
  }
  async function fetchAll(make) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await make().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }
  async function load() {
    const [persone, banche, voci] = await Promise.all([
      fetchAll(() => sb.from("plan_persone").select("*").order("ordine")),
      fetchAll(() => sb.from("plan_banche").select("*").order("anno")),
      fetchAll(() => sb.from("plan_voci").select("*").order("data")),
    ]);
    state.persone = persone; state.banche = banche; state.voci = voci.map((v) => ({ ...v, data: String(v.data).slice(0, 10) }));
    const saved = lsGet("plan-persona");
    if (!state.persone.some((p) => p.id === state.pid)) state.pid = state.persone.some((p) => p.id === saved) ? saved : (state.persone[0] ? state.persone[0].id : null);
  }
  async function start() {
    showView("loading");
    try { await load(); } catch (e) {
      if (isAuthError(e)) { await handleError(e); return; }
      showView("app"); render(); toast("Caricamento non riuscito: le tabelle del planning sono state create su Supabase?"); return;
    }
    showView("app"); render();
  }
  async function reload() { try { await load(); render(); } catch (e) { await handleError(e); } }

  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (session) { if (state.userId !== session.user.id) { state.userId = session.user.id; start(); } }
      else { state.userId = null; goCockpit(); }
    }, 0);
  });

  // ---------- dati correnti ----------
  const persona = () => state.persone.find((p) => p.id === state.pid) || null;
  const oreGiorno = (p) => Number(p && p.ore_giorno) || 8;
  const banca = (pid, anno) => state.banche.find((b) => b.persona_id === pid && b.anno === anno) || null;

  // ---------- disegno ----------
  function render() {
    const p = persona();
    $("#empty").hidden = !!state.persone.length; $("#board").hidden = !state.persone.length;
    $("#subtitle").textContent = p ? `Ferie e permessi · ${p.nome}` : "Ferie e permessi";
    renderChips();
    if (!p) return;
    renderBanks(p); renderTools(p); renderCal(p);
    $("#y-label").textContent = String(state.anno);
    $("#m-label").textContent = P.MESI[state.mese];
    $("#m-grp").hidden = state.vista !== "mese";
    $("#v-mese").setAttribute("aria-pressed", String(state.vista === "mese"));
    $("#v-anno").setAttribute("aria-pressed", String(state.vista === "anno"));
  }
  function renderChips() {
    $("#chips").innerHTML = state.persone.map((p) => {
      const col = okColore(p.colore) ? p.colore : COLORI[0];
      return `<button type="button" role="tab" class="chip" data-pid="${esc(p.id)}" aria-selected="${p.id === state.pid}"><i class="avatar" style="background:${col}">${esc((p.nome || "?").trim().charAt(0).toUpperCase())}</i>${esc(p.nome)}</button>`;
    }).join("");
  }
  function bankCard(tipo, label, icon, r, og) {
    const b = r[tipo], oltre = b.oltre;
    const big = tipo === "ferie" ? P.fmtGiorni(b.residuo, og) : P.fmtOre(b.residuo);
    const sub = tipo === "ferie" ? `${P.fmtOre(b.residuo)} rimaste` : P.fmtGiorni(b.residuo, og);
    return `<article class="card bank ${tipo}${oltre ? " over" : ""}">
      <div class="bank-h"><span class="bank-ico">${icon}</span><span>${label}</span></div>
      <div class="bank-big">${esc(big)}</div>
      <div class="bank-sub">${esc(oltre ? `Oltre la banca di ${P.fmtOre(-b.residuo)}` : sub)}</div>
      <div class="bar"><i style="width:${b.perc}%"></i></div>
      <div class="bank-foot">Pianificate ${esc(P.fmtOre(b.usate))} su ${esc(P.fmtOre(b.totale))}</div>
    </article>`;
  }
  function renderBanks(p) {
    const r = P.riepilogo(banca(p.id, state.anno), state.voci, p, state.anno), og = oreGiorno(p);
    if (!r.configurata) {
      $("#banks").innerHTML = `<article class="card bank-empty"><div><strong>Banca ore ${state.anno} non impostata</strong><p class="note">Indica quante ore di ferie e permessi hai a disposizione per l'anno.</p></div><button class="btn primary" id="btn-bank" type="button">Imposta banca ore</button></article>`;
      return;
    }
    $("#banks").innerHTML = bankCard("ferie", "Ferie", "🌴", r, og) + bankCard("permessi", "Permessi", "⏱️", r, og)
      + `<button class="btn sm bank-edit" id="btn-bank" type="button">✏️ Banca ore ${state.anno}</button>`;
  }
  function renderTools(p) {
    $$("#tools .tool").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === state.tool)));
    $("#opt-ferie").hidden = state.tool !== "ferie"; $("#opt-perm").hidden = state.tool !== "permessi";
    $("#ferie-tipo").value = state.ferieTipo;
    $("#p-ore").textContent = P.fmtOre(state.permOre);
    $("#tool-hint").textContent = state.tool === "ferie" ? "Tocca un giorno per segnare le ferie; toccalo di nuovo per toglierle."
      : state.tool === "permessi" ? "Scegli le ore e tocca i giorni. Si possono unire alle ferie dello stesso giorno (mezza giornata)."
      : "Tocca un giorno per cancellare ferie e permessi.";
  }
  function dayInfo(g, og) {
    const f = g.ferie, pm = g.permessi;
    return { f, pm, fLab: f === undefined ? "" : f >= og ? "Ferie" : P.fmtOre(f), pLab: pm === undefined ? "" : P.fmtOre(pm) };
  }
  function renderCal(p) {
    const og = oreGiorno(p), gg = P.perGiorno(state.voci, p.id), oggi = todayIso();
    const dayBtn = (c, mini) => {
      const g = gg[c.iso] || {}, i = dayInfo(g, og);
      const cls = ["day"]; if (!c.dentro) cls.push("out"); if (c.weekend) cls.push("we"); if (c.festivo) cls.push("fest"); if (c.iso === oggi) cls.push("today");
      if (i.f !== undefined) cls.push("has-f"); if (i.pm !== undefined) cls.push("has-p");
      const lab = `${c.d} ${P.MESI[Number(c.iso.slice(5, 7)) - 1]}${c.festivo ? ", " + c.festivo : ""}${i.f !== undefined ? ", ferie " + P.fmtOre(i.f) : ""}${i.pm !== undefined ? ", permessi " + P.fmtOre(i.pm) : ""}`;
      if (mini) return `<button type="button" class="${cls.join(" ")}" data-iso="${c.iso}" ${c.dentro ? "" : "disabled"} aria-label="${esc(lab)}" title="${esc(c.festivo || "")}">${c.dentro ? c.d : ""}</button>`;
      return `<button type="button" class="${cls.join(" ")}" data-iso="${c.iso}" ${c.dentro ? "" : "disabled"} aria-label="${esc(lab)}" title="${esc(c.festivo || "")}">
        <span class="n">${c.d}</span>${c.festivo && c.dentro ? `<span class="fn">${esc(c.festivo)}</span>` : ""}
        ${i.f !== undefined ? `<span class="mk mk-f">${esc(i.fLab)}</span>` : ""}${i.pm !== undefined ? `<span class="mk mk-p">${esc(i.pLab)}</span>` : ""}
      </button>`;
    };
    const head = P.GIORNI.map((g, i) => `<span class="${i >= 5 ? "we" : ""}">${g}</span>`).join("");
    if (state.vista === "mese") {
      $("#cal-body").innerHTML = `<div class="month"><div class="dow">${head}</div><div class="grid">${P.monthGrid(state.anno, state.mese).flat().map((c) => dayBtn(c, false)).join("")}</div></div>`;
    } else {
      $("#cal-body").innerHTML = `<div class="year">${P.MESI.map((nome, m) => `<section class="mini${m === state.mese ? " cur" : ""}"><button type="button" class="mini-t" data-goto="${m}">${nome}</button><div class="dow">${P.GIORNI.map((g, i) => `<span class="${i >= 5 ? "we" : ""}">${g.charAt(0)}</span>`).join("")}</div><div class="grid">${P.monthGrid(state.anno, m).flat().map((c) => dayBtn(c, true)).join("")}</div></section>`).join("")}</div>`;
    }
  }

  // ---------- azioni sul calendario ----------
  async function paint(dataIso) {
    const p = persona(); if (!p) return;
    const og = oreGiorno(p), gg = P.perGiorno(state.voci, p.id)[dataIso];
    const ore = state.tool === "ferie" ? (state.ferieTipo === "mezza" ? P.r2(og / 2) : og) : state.permOre;
    const r = P.applica(gg, { tipo: state.tool, ore }, og, dataIso);
    if (r.errore) { toast(r.errore); return; }
    if (r.op === "none") { toast("Niente da cancellare in questo giorno."); return; }
    const azioni = r.op === "multi" ? r.azioni : [r];
    const sets = [], dels = [];
    for (const a of azioni) {
      const i = state.voci.findIndex((v) => v.persona_id === p.id && v.data === a.data && v.tipo === a.tipo);
      if (a.op === "del") { if (i >= 0) state.voci.splice(i, 1); dels.push(a); }
      else if (i >= 0) { state.voci[i].ore = a.ore; sets.push(state.voci[i]); }
      else { const v = { id: crypto.randomUUID(), persona_id: p.id, data: a.data, tipo: a.tipo, ore: a.ore }; state.voci.push(v); sets.push(v); }
    }
    render();
    try {
      for (const a of dels) { const { error } = await sb.from("plan_voci").delete().eq("persona_id", p.id).eq("data", a.data).eq("tipo", a.tipo); if (error) throw error; }
      if (sets.length) { const { error } = await sb.from("plan_voci").upsert(sets.map((v) => ({ id: v.id, persona_id: v.persona_id, data: v.data, tipo: v.tipo, ore: v.ore })), { onConflict: "persona_id,data,tipo" }); if (error) throw error; }
    } catch (e) { await handleError(e, "Salvataggio non riuscito: ricarico i dati."); await reload(); }
  }
  $("#cal-body").addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]");
    if (g) { state.mese = Number(g.dataset.goto); state.vista = "mese"; render(); return; }
    const d = e.target.closest("button.day[data-iso]");
    if (d && !d.disabled) paint(d.dataset.iso);
  });

  // navigazione
  const stepMese = (n) => { let m = state.mese + n, y = state.anno; if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; } state.mese = m; state.anno = y; render(); };
  $("#m-prev").addEventListener("click", () => stepMese(-1));
  $("#m-next").addEventListener("click", () => stepMese(1));
  $("#y-prev").addEventListener("click", () => { state.anno--; render(); });
  $("#y-next").addEventListener("click", () => { state.anno++; render(); });
  $("#btn-oggi").addEventListener("click", () => { const t = todayIso(); state.anno = Number(t.slice(0, 4)); state.mese = Number(t.slice(5, 7)) - 1; render(); });
  $("#v-mese").addEventListener("click", () => { state.vista = "mese"; render(); });
  $("#v-anno").addEventListener("click", () => { state.vista = "anno"; render(); });

  // strumenti
  $("#tools").addEventListener("click", (e) => { const b = e.target.closest(".tool"); if (b) { state.tool = b.dataset.tool; render(); } });
  $("#ferie-tipo").addEventListener("change", (e) => { state.ferieTipo = e.target.value === "mezza" ? "mezza" : "intera"; render(); });
  const stepOre = (n) => { const og = oreGiorno(persona()); state.permOre = Math.min(og, Math.max(0.5, P.r2(state.permOre + n))); render(); };
  $("#p-meno").addEventListener("click", () => stepOre(-0.5));
  $("#p-piu").addEventListener("click", () => stepOre(0.5));

  // persona attiva
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pid]"); if (!b) return;
    state.pid = b.dataset.pid; lsSet("plan-persona", state.pid);
    state.permOre = Math.min(state.permOre, oreGiorno(persona())); render();
  });

  // ---------- persone ----------
  const dlgPeople = $("#dlg-people");
  function renderPeople() {
    $("#plist").innerHTML = state.persone.length ? state.persone.map((p) => {
      const col = okColore(p.colore) ? p.colore : COLORI[0], conf = state.confirmDel === p.id;
      return `<li class="prow"><i class="avatar" style="background:${col}">${esc((p.nome || "?").trim().charAt(0).toUpperCase())}</i>
        <span class="pn"><strong>${esc(p.nome)}</strong><small>${esc(P.fmtOre(oreGiorno(p)))} al giorno</small></span>
        ${conf ? `<span class="pconf">Eliminare con tutte le sue ferie e permessi?</span><button class="btn sm" data-pback="${esc(p.id)}" type="button">No</button><button class="btn sm danger" data-pdel-ok="${esc(p.id)}" type="button">Elimina</button>`
          : `<button class="btn sm" data-pedit="${esc(p.id)}" type="button">Modifica</button><button class="btn sm" data-pdel="${esc(p.id)}" type="button" aria-label="Elimina ${esc(p.nome)}">🗑️</button>`}
      </li>`;
    }).join("") : `<li class="empty">Nessuna persona.</li>`;
  }
  function renderSwatches(sel) {
    $("#pf-cols").innerHTML = COLORI.map((c) => `<button type="button" class="sw" role="radio" aria-checked="${c === sel}" data-col="${c}" style="background:${c}" aria-label="Colore ${c}"></button>`).join("");
  }
  const selColor = () => { const b = $("#pf-cols [aria-checked=true]"); return b ? b.dataset.col : COLORI[0]; };
  function resetPersonForm() {
    state.editing = null; $("#pf-title").textContent = "Nuova persona"; $("#pf-save").textContent = "Aggiungi"; $("#pf-reset").hidden = true;
    $("#pf-nome").value = ""; $("#pf-ore").value = "8"; $("#pf-msg").textContent = "";
    renderSwatches(COLORI.find((c) => !state.persone.some((p) => p.colore === c)) || COLORI[state.persone.length % COLORI.length]);
  }
  function openPeople() { state.confirmDel = null; resetPersonForm(); renderPeople(); dlgPeople.showModal(); }
  $("#btn-people").addEventListener("click", openPeople);
  $("#btn-first").addEventListener("click", openPeople);
  $("#pf-close").addEventListener("click", () => dlgPeople.close());
  $("#pf-reset").addEventListener("click", resetPersonForm);
  $("#pf-cols").addEventListener("click", (e) => { const b = e.target.closest(".sw"); if (b) renderSwatches(b.dataset.col); });
  $("#plist").addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.pedit) {
      const p = state.persone.find((x) => x.id === t.dataset.pedit); if (!p) return;
      state.editing = p.id; $("#pf-title").textContent = "Modifica persona"; $("#pf-save").textContent = "Salva"; $("#pf-reset").hidden = false;
      $("#pf-nome").value = p.nome; $("#pf-ore").value = P.fmtNum(oreGiorno(p)); $("#pf-msg").textContent = ""; renderSwatches(okColore(p.colore) ? p.colore : COLORI[0]);
      $("#pf-nome").focus();
    } else if (t.dataset.pdel) { state.confirmDel = t.dataset.pdel; renderPeople(); }
    else if (t.dataset.pback) { state.confirmDel = null; renderPeople(); }
    else if (t.dataset.pdelOk) {
      const id = t.dataset.pdelOk;
      const { error } = await sb.from("plan_persone").delete().eq("id", id);
      if (error) { await handleError(error, "Eliminazione non riuscita."); return; }
      state.persone = state.persone.filter((p) => p.id !== id); state.banche = state.banche.filter((b) => b.persona_id !== id); state.voci = state.voci.filter((v) => v.persona_id !== id);
      if (state.pid === id) state.pid = state.persone[0] ? state.persone[0].id : null;
      state.confirmDel = null; if (state.editing === id) resetPersonForm();
      renderPeople(); render();
    }
  });
  $("#form-person").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#pf-msg"); msg.textContent = "";
    const nome = $("#pf-nome").value.trim(), ore = P.parseOre($("#pf-ore").value), colore = selColor();
    if (!nome) { msg.textContent = "Scrivi un nome."; return; }
    if (!(ore > 0 && ore <= P.ORE_MAX)) { msg.textContent = `Le ore di una giornata devono essere tra 0,5 e ${P.ORE_MAX}.`; return; }
    const btn = $("#pf-save"); btn.disabled = true;
    try {
      if (state.editing) {
        const row = { nome: nome.slice(0, 40), colore, ore_giorno: ore };
        const { error } = await sb.from("plan_persone").update(row).eq("id", state.editing); if (error) throw error;
        Object.assign(state.persone.find((p) => p.id === state.editing), row);
      } else {
        const row = { id: crypto.randomUUID(), nome: nome.slice(0, 40), colore, ore_giorno: ore, ordine: state.persone.reduce((m, p) => Math.max(m, p.ordine || 0), 0) + 1 };
        const { error } = await sb.from("plan_persone").insert(row); if (error) throw error;
        state.persone.push(row); if (!state.pid) state.pid = row.id;
      }
      resetPersonForm(); renderPeople(); render();
    } catch (err) { if (isAuthError(err)) await handleError(err); else msg.textContent = "Salvataggio non riuscito. Riprova."; }
    btn.disabled = false;
  });

  // ---------- banca ore ----------
  const dlgBank = $("#dlg-bank");
  function bankHints() {
    const og = oreGiorno(persona()), f = P.parseOre($("#bk-ferie").value), pm = P.parseOre($("#bk-perm").value);
    $("#bk-ferie-g").textContent = Number.isNaN(f) ? "" : `≈ ${P.fmtGiorni(f, og)}`;
    $("#bk-perm-g").textContent = Number.isNaN(pm) ? "" : `≈ ${P.fmtGiorni(pm, og)}`;
  }
  function openBank() {
    const p = persona(); if (!p) return;
    const cur = banca(p.id, state.anno), prev = cur ? null : state.banche.filter((b) => b.persona_id === p.id && b.anno < state.anno).sort((a, b) => b.anno - a.anno)[0];
    const src = cur || prev;
    $("#bk-title").textContent = `Banca ore ${state.anno}`;
    $("#bk-sub").textContent = `${p.nome}: ore a disposizione per l'anno.${prev ? ` Valori precompilati dal ${prev.anno}.` : ""}`;
    $("#bk-ferie").value = src ? P.fmtNum(src.ferie_ore) : ""; $("#bk-perm").value = src ? P.fmtNum(src.permessi_ore) : "";
    $("#bk-msg").textContent = ""; bankHints(); dlgBank.showModal();
  }
  $("#banks").addEventListener("click", (e) => { if (e.target.closest("#btn-bank")) openBank(); });
  $("#bk-ferie").addEventListener("input", bankHints); $("#bk-perm").addEventListener("input", bankHints);
  $("#bk-cancel").addEventListener("click", () => dlgBank.close());
  $("#form-bank").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#bk-msg"); msg.textContent = "";
    const f = P.parseOre($("#bk-ferie").value), pm = P.parseOre($("#bk-perm").value), p = persona();
    if (Number.isNaN(f) || Number.isNaN(pm)) { msg.textContent = "Inserisci le ore (anche 0): numeri positivi, es. 160 o 7,5."; return; }
    const btn = $("#bk-save"); btn.disabled = true;
    const row = { persona_id: p.id, anno: state.anno, ferie_ore: f, permessi_ore: pm };
    const { error } = await sb.from("plan_banche").upsert(row, { onConflict: "persona_id,anno" });
    btn.disabled = false;
    if (error) { if (isAuthError(error)) await handleError(error); else msg.textContent = "Salvataggio non riuscito. Riprova."; return; }
    const i = state.banche.findIndex((b) => b.persona_id === p.id && b.anno === state.anno);
    if (i >= 0) state.banche[i] = row; else state.banche.push(row);
    dlgBank.close(); render();
  });

  // ---------- tema ----------
  $("#btn-theme").addEventListener("click", () => { toast(window.Theme.toggle() === "dark" ? "Tema scuro" : "Tema chiaro"); });
})();
