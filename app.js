(() => {
  "use strict";
  const { r2, parts, compute, parseImporto } = window.Calc;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", useGrouping: "always" });
  const eur = (n) => nf.format(r2(n) + 0);
  const sgn = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + nf.format(Math.abs(r2(n)));
  const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const mesiCorti = MESI.map((m) => m.slice(0, 3));
  const fmtMese = (k) => `${MESI[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;
  const fmtMeseCorto = (k) => `${mesiCorti[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`;
  const fmtGiorno = (d) => `${Number(d.slice(8))} ${mesiCorti[Number(d.slice(5, 7)) - 1]}`;
  const fmtData = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const BASE_CAT = ["Stipendio", "Auto", "Università", "Abbonamenti", "Telefono", "Spesa", "Varie", "Acquisto casa", "Casa", "Lavori", "Utenze", "Altro"];
  const DEFAULT_CFG = { c1: { nome: "Conto 1", iniziale: 0 }, c2: { nome: "Conto 2", iniziale: 0 }, dataInizio: new Date().toISOString().slice(0, 10) };

  const state = { cfg: DEFAULT_CFG, ops: [], tab: "c1", entries: [], cur: { c1: 0, c2: 0 }, min: { c1: 0, c2: 0 }, userId: null, recovery: false, confirmDel: null, editing: null };

  // ---------- utilità UI ----------
  const views = ["loading", "login", "recovery", "app"];
  function showView(name) {
    views.forEach((v) => { $("#view-" + v).hidden = v !== name; });
    document.title = name === "app" ? "Conti casa" : "Accesso";
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } };

  // ---------- Supabase ----------
  const C = window.CONFIG || {};
  if (!C.SUPABASE_URL || /XXXX/.test(C.SUPABASE_URL) || !C.SUPABASE_PUBLISHABLE_KEY || /XXXX/.test(C.SUPABASE_PUBLISHABLE_KEY)) {
    showView("login");
    $("#login-msg").textContent = "Configurazione mancante: inserisci URL e chiave Supabase in config.js.";
    $("#form-login button[type=submit]").disabled = true;
    return;
  }
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_PUBLISHABLE_KEY);

  const isAuthError = (e) => e && (e.status === 401 || /JWT|expired|not authenticated/i.test(e.message || ""));
  async function handleError(e, fallback) {
    if (isAuthError(e)) { toast("Sessione scaduta: accedi di nuovo."); await sb.auth.signOut(); return; }
    toast(fallback || "Operazione non riuscita. Controlla la connessione e riprova.");
  }

  async function load() {
    const [c, o] = await Promise.all([
      sb.from("config").select("dati").eq("id", "conti").maybeSingle(),
      sb.from("ops").select("*").range(0, 4999),
    ]);
    if (c.error || o.error) throw c.error || o.error;
    state.cfg = { ...DEFAULT_CFG, ...(c.data ? c.data.dati : {}) };
    state.ops = (o.data || []).map((r) => ({ ...r, importo: Number(r.importo), ordine: Number(r.ordine) || 0 }));
    recalc();
  }
  function recalc() {
    const r = compute(state.cfg, state.ops);
    state.entries = r.entries; state.cur = r.cur; state.min = r.min;
  }
  async function start() {
    showView("loading");
    try { await load(); } catch (e) { showView("app"); await handleError(e, "Caricamento non riuscito. Controlla la connessione e riprova."); return; }
    const saved = lsGet("conti-tab");
    if (saved === "c1" || saved === "c2" || saved === "comune") state.tab = saved;
    showView("app"); render();
  }
  async function reload() { try { await load(); render(); } catch (e) { await handleError(e); } }

  // ---------- autenticazione ----------
  sb.auth.onAuthStateChange((event, session) => {
    // differito: evita di chiamare supabase dentro la callback
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") { state.recovery = true; showView("recovery"); return; }
      if (state.recovery) return;
      if (session) {
        if (state.userId !== session.user.id) { state.userId = session.user.id; start(); }
      } else {
        state.userId = null; state.ops = []; showView("login");
      }
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
    state.recovery = false; $("#rec-pass").value = "";
    const { data } = await sb.auth.getSession();
    if (data.session) { state.userId = data.session.user.id; start(); } else showView("login");
  });
  $("#btn-logout").addEventListener("click", () => sb.auth.signOut());

  // ---------- rendering ----------
  const nomeConto = (k) => (k === "comune" ? "Conto comune" : state.cfg[k].nome);

  function render() {
    const { cfg, tab } = state;
    $("#subtitle").textContent = `Dal ${fmtData(cfg.dataInizio)} · ${state.ops.length} operazioni`;
    $("#tab-c1").textContent = cfg.c1.nome; $("#tab-c2").textContent = cfg.c2.nome;
    document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#btn-add").textContent = tab === "comune" ? "+ Aggiungi uscita comune" : `+ Aggiungi a ${cfg[tab].nome}`;
    renderCards(); renderMonthly(); renderList();
  }

  function renderCards() {
    const tot = state.ops.filter((o) => o.conto === "comune").reduce((s, o) => s + o.importo, 0);
    const personal = (k) => `<button type="button" class="card sum ${state.tab === k ? "active" : ""}" data-tab="${k}">
      <span class="t">${esc(state.cfg[k].nome)}</span><span class="big">${eur(state.cur[k])}</span>
      <span class="s">partenza ${eur(state.cfg[k].iniziale)} · minimo ${eur(state.min[k])}</span></button>`;
    $("#cards").innerHTML = personal("c1") + personal("c2") +
      `<button type="button" class="card sum ${state.tab === "comune" ? "active" : ""}" data-tab="comune">
      <span class="t">Conto comune · uscite</span><span class="big">${eur(tot)}</span>
      <span class="s">a testa ${eur(tot / 2)} · totale due conti ${eur(state.cur.c1 + state.cur.c2)}</span></button>`;
  }

  function monthsOf(filter) {
    const m = new Map();
    for (const e of state.entries) {
      if (!filter(e)) continue;
      const k = e.o.data.slice(0, 7);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return m;
  }

  function renderMonthly() {
    const tab = state.tab;
    let h;
    if (tab === "comune") {
      const months = monthsOf((e) => e.o.conto === "comune");
      let t = 0, a = 0, b = 0;
      const rows = [...months].map(([k, es]) => {
        const s = es.reduce((x, e) => x + e.o.importo, 0), q1 = es.reduce((x, e) => x - e.p.c1, 0), q2 = es.reduce((x, e) => x - e.p.c2, 0);
        t += s; a += q1; b += q2;
        return `<tr><td>${fmtMese(k)}</td><td>${eur(s)}</td><td>${eur(q1)}</td><td>${eur(q2)}</td></tr>`;
      }).join("");
      h = `<p class="note">Ogni uscita qui viene divisa a metà e tolta da ${esc(state.cfg.c1.nome)} e ${esc(state.cfg.c2.nome)}.</p>
        <table><thead><tr><th>Mese</th><th>Uscite comuni</th><th>${esc(state.cfg.c1.nome)}</th><th>${esc(state.cfg.c2.nome)}</th></tr></thead>
        <tbody>${rows}<tr class="tot"><td>Totale</td><td>${eur(t)}</td><td>${eur(a)}</td><td>${eur(b)}</td></tr></tbody></table>`;
    } else {
      const months = monthsOf((e) => e.o.conto === tab || e.o.conto === "comune");
      const rows = [...months].map(([k, es]) => {
        let ent = 0, usc = 0, com = 0;
        for (const e of es) {
          const v = e.p[tab];
          if (e.o.conto === "comune") com += -v; else if (v > 0) ent += v; else usc += -v;
        }
        return `<tr><td>${fmtMese(k)}</td><td>${eur(ent)}</td><td>${eur(usc)}</td><td>${eur(com)}</td><td><strong>${eur(es[es.length - 1].b[tab])}</strong></td></tr>`;
      }).join("");
      h = `<table><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Conto comune</th><th>Saldo fine mese</th></tr></thead>
        <tbody><tr><td>Partenza</td><td colspan="3"></td><td><strong>${eur(state.cfg[tab].iniziale)}</strong></td></tr>${rows}</tbody></table>`;
    }
    $("#monthly").innerHTML = h;
  }

  function rowHtml(e, tab) {
    const o = e.o, comune = o.conto === "comune";
    let amt, cls, sub;
    if (tab === "comune") {
      amt = -o.importo; cls = "neg";
      sub = `${esc(state.cfg.c1.nome)} ${eur(-e.p.c1)} · ${esc(state.cfg.c2.nome)} ${eur(-e.p.c2)}`;
    } else {
      amt = e.p[tab]; cls = amt >= 0 ? "pos" : "neg";
      sub = (comune ? `metà di ${eur(o.importo)} · ` : "") + `saldo ${eur(e.b[tab])}`;
    }
    const tags = (o.categoria ? `<span class="tag">${esc(o.categoria)}</span>` : "") + (comune && tab !== "comune" ? `<span class="tag com">Conto comune · metà</span>` : "");
    let act;
    if (state.confirmDel === o.id) {
      const warn = comune && tab !== "comune" ? "Eliminare? È un'uscita comune: sparisce da entrambi i conti." : "Eliminare?";
      act = `<span class="confirm">${warn}</span>
        <button type="button" class="btn danger sm" data-act="delok" data-id="${esc(o.id)}">Elimina</button>
        <button type="button" class="btn sm" data-act="delno">Annulla</button>`;
    } else {
      act = `<button type="button" class="btn sm" data-act="edit" data-id="${esc(o.id)}" aria-label="Modifica ${esc(o.voce)}">Modifica</button>
        <button type="button" class="btn sm" data-act="del" data-id="${esc(o.id)}" aria-label="Elimina ${esc(o.voce)}">Elimina</button>`;
    }
    return `<li class="row"><div class="d">${fmtGiorno(o.data)}</div>
      <div><div class="v">${esc(o.voce)}</div><div class="tags">${tags}</div></div>
      <div class="a"><div class="amt ${cls}">${sgn(amt)}</div><div class="sub">${sub}</div></div>
      <div class="act">${act}</div></li>`;
  }

  function renderList() {
    const tab = state.tab;
    const months = monthsOf((e) => (tab === "comune" ? e.o.conto === "comune" : e.o.conto === tab || e.o.conto === "comune"));
    let h = tab === "comune" ? "" : `<div class="month"><div class="mhead"><span>Saldo di partenza · ${fmtData(state.cfg.dataInizio)}</span><span>${eur(state.cfg[tab].iniziale)}</span></div></div>`;
    if (!months.size) h += `<p class="empty">Nessuna operazione.</p>`;
    for (const [k, es] of months) {
      let ent = 0, usc = 0;
      for (const e of es) {
        if (tab === "comune") usc += e.o.importo;
        else if (e.p[tab] > 0) ent += e.p[tab]; else usc += -e.p[tab];
      }
      const tot = tab === "comune" ? `uscite ${eur(usc)}` : `entrate ${eur(ent)} · uscite ${eur(usc)}`;
      const foot = tab === "comune" ? "" : `<div class="mfoot">Saldo fine mese: <strong>${eur(es[es.length - 1].b[tab])}</strong></div>`;
      h += `<div class="month"><div class="mhead"><span>${fmtMese(k)}</span><span class="tot">${tot}</span></div>
        <ul class="rows">${es.map((e) => rowHtml(e, tab)).join("")}</ul>${foot}</div>`;
    }
    $("#list").innerHTML = h;
  }

  // ---------- eventi: schede, azioni, righe ----------
  function setTab(t) { state.tab = t; state.confirmDel = null; lsSet("conti-tab", t); render(); }
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
  $("#cards").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) { setTab(b.dataset.tab); $("#monthly").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });
  $("#btn-add").addEventListener("click", () => openOp(null));
  $("#btn-start").addEventListener("click", openStart);
  $("#btn-csv").addEventListener("click", copyCsv);
  $("#list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === "edit") openOp(state.ops.find((o) => o.id === id));
    else if (act === "del") { state.confirmDel = id; renderList(); }
    else if (act === "delno") { state.confirmDel = null; renderList(); }
    else if (act === "delok") {
      b.disabled = true;
      const { error } = await sb.from("ops").delete().eq("id", id);
      state.confirmDel = null;
      if (error) { await handleError(error, "Eliminazione non riuscita. Controlla la connessione e riprova."); renderList(); return; }
      await reload();
    }
  });

  // ---------- finestra operazione ----------
  const fConto = $("#f-conto");
  function updateOpUi() {
    const comune = fConto.value === "comune";
    $("#f-tipo-wrap").hidden = comune;
    const imp = parseImporto($("#f-importo").value);
    $("#f-preview").textContent = comune && imp > 0
      ? `Verrà tolto ${eur(r2(imp / 2))} da ${state.cfg.c1.nome} e ${eur(r2(imp - r2(imp / 2)))} da ${state.cfg.c2.nome}.` : "";
  }
  function openOp(op) {
    state.editing = op;
    const { cfg } = state;
    fConto.options[0].textContent = cfg.c1.nome; fConto.options[1].textContent = cfg.c2.nome;
    const cats = [...new Set([...BASE_CAT, ...state.ops.map((o) => o.categoria).filter(Boolean)])];
    $("#cat-list").innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");
    $("#op-title").textContent = op ? "Modifica operazione" : "Nuova operazione";
    fConto.value = op ? op.conto : state.tab;
    $("#f-voce").value = op ? op.voce : "";
    $("#f-tipo").value = op ? op.tipo : "uscita";
    $("#f-importo").value = op ? String(op.importo).replace(".", ",") : "";
    const last = state.entries.length ? state.entries[state.entries.length - 1].o.data : cfg.dataInizio;
    $("#f-data").value = op ? op.data : last;
    $("#f-cat").value = op ? op.categoria || "" : "";
    $("#op-msg").textContent = ""; $("#op-save").disabled = false;
    updateOpUi();
    $("#dlg-op").showModal();
  }
  fConto.addEventListener("change", updateOpUi);
  $("#f-importo").addEventListener("input", updateOpUi);
  $("#op-cancel").addEventListener("click", () => $("#dlg-op").close());

  $("#form-op").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#op-msg"); msg.textContent = "";
    const voce = $("#f-voce").value.trim(), importo = parseImporto($("#f-importo").value), data = $("#f-data").value;
    if (!voce) { msg.textContent = "Scrivi una descrizione."; return; }
    if (!(importo > 0)) { msg.textContent = "L'importo deve essere maggiore di zero."; return; }
    if (!/^\d{4}-\d\d-\d\d$/.test(data)) { msg.textContent = "Scegli una data."; return; }
    const conto = fConto.value;
    const op = state.editing;
    const row = {
      id: op ? op.id : crypto.randomUUID(), data, voce: voce.slice(0, 120), conto,
      tipo: conto === "comune" ? "uscita" : $("#f-tipo").value, importo,
      categoria: $("#f-cat").value.trim() || null,
      ordine: op ? op.ordine : state.ops.reduce((m, o) => Math.max(m, o.ordine), -1) + 1,
      updated_at: new Date().toISOString(),
    };
    $("#op-save").disabled = true;
    const { error } = await sb.from("ops").upsert(row);
    if (error) {
      $("#op-save").disabled = false;
      if (isAuthError(error)) { $("#dlg-op").close(); await handleError(error); return; }
      msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return;
    }
    $("#dlg-op").close();
    await reload();
  });

  // ---------- saldi di partenza ----------
  function openStart() {
    const { cfg } = state;
    $("#s-data").value = cfg.dataInizio; $("#s-n1").value = cfg.c1.nome; $("#s-n2").value = cfg.c2.nome;
    $("#s-i1").value = String(cfg.c1.iniziale).replace(".", ","); $("#s-i2").value = String(cfg.c2.iniziale).replace(".", ",");
    $("#start-msg").textContent = ""; $("#start-save").disabled = false;
    $("#dlg-start").showModal();
  }
  $("#start-cancel").addEventListener("click", () => $("#dlg-start").close());
  $("#form-start").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#start-msg"); msg.textContent = "";
    const i1 = parseImporto($("#s-i1").value.replace(/^-/, "")), i2 = parseImporto($("#s-i2").value.replace(/^-/, ""));
    const neg = (el) => /^\s*-/.test(el.value);
    const n1 = $("#s-n1").value.trim(), n2 = $("#s-n2").value.trim(), d = $("#s-data").value;
    if (!n1 || !n2 || !d || Number.isNaN(i1) || Number.isNaN(i2)) { msg.textContent = "Controlla nomi, data e saldi."; return; }
    const dati = { c1: { nome: n1, iniziale: neg($("#s-i1")) ? -i1 : i1 }, c2: { nome: n2, iniziale: neg($("#s-i2")) ? -i2 : i2 }, dataInizio: d };
    $("#start-save").disabled = true;
    const { error } = await sb.from("config").upsert({ id: "conti", dati, updated_at: new Date().toISOString() });
    if (error) {
      $("#start-save").disabled = false;
      if (isAuthError(error)) { $("#dlg-start").close(); await handleError(error); return; }
      msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return;
    }
    $("#dlg-start").close();
    await reload();
  });

  // ---------- CSV ----------
  async function copyCsv() {
    const num = (n) => String(r2(n) + 0).replace(".", ",");
    const q = (s) => (/[;"\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const lines = ["Data;Descrizione;Conto;Categoria;Effetto conto 1;Effetto conto 2;Saldo conto 1;Saldo conto 2"];
    for (const e of state.entries) {
      lines.push([fmtData(e.o.data), q(e.o.voce), q(nomeConto(e.o.conto)), q(e.o.categoria || ""), num(e.p.c1), num(e.p.c2), num(e.b.c1), num(e.b.c2)].join(";"));
    }
    const text = lines.join("\n");
    try { await navigator.clipboard.writeText(text); toast("CSV copiato negli appunti."); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("CSV copiato negli appunti."); } catch { toast("Copia non riuscita."); }
      ta.remove();
    }
  }
})();
