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
  const fmtGiorno = (d) => `${Number(d.slice(8))} ${mesiCorti[Number(d.slice(5, 7)) - 1]}`;
  const fmtData = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const pad = (n) => String(n).padStart(2, "0");
  // Data di oggi nel fuso locale, come stringa YYYY-MM-DD (niente toISOString: sarebbe UTC)
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const BASE_CAT = ["Stipendio", "Auto", "Università", "Abbonamenti", "Telefono", "Spesa", "Varie", "Acquisto casa", "Casa", "Lavori", "Utenze", "Altro"];
  const DEFAULT_CFG = { c1: { nome: "Conto 1", iniziale: 0 }, c2: { nome: "Conto 2", iniziale: 0 }, dataInizio: localToday() };
  const QUICK_FREQ = ["1", "2", "3", "6", "12"];

  const state = {
    cfg: DEFAULT_CFG, ops: [], rules: [], scenari: [], scenId: null, simConfirm: null, tab: "c1", view: "main", showAnn: false,
    entries: [], annEntries: [], cur: { c1: 0, c2: 0 }, min: { c1: 0, c2: 0 },
    open: null, userId: null, recovery: false, confirmDel: null, confirmRule: null,
    editing: null, editingRule: null, ruleDraft: null, linkOp: null,
  };

  // ---------- utilità UI ----------
  const views = ["loading", "login", "recovery", "app"];
  function showView(name) {
    views.forEach((v) => { $("#view-" + v).hidden = v !== name; });
    document.title = name === "app" ? "Ledger" : "Accesso";
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } };
  const nowIso = () => new Date().toISOString();

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

  // Legge tutte le righe a pagine da 1000 (limite predefinito di Supabase)
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

  const normOp = (r) => ({ ...r, importo: Number(r.importo), ordine: Number(r.ordine) || 0, modificata: !!r.modificata, annullata: !!r.annullata });
  const normRule = (r) => ({ ...r, importo: Number(r.importo), ogni_mesi: Number(r.ogni_mesi), giorno: Number(r.giorno), data_fine: r.data_fine || null, attiva: r.attiva !== false });

  async function load() {
    const [c, sc, ops, rules] = await Promise.all([
      sb.from("config").select("dati").eq("id", "conti").maybeSingle(),
      sb.from("config").select("dati").eq("id", "scenari").maybeSingle(),
      fetchAll(() => sb.from("ops").select("*").order("id")),
      fetchAll(() => sb.from("ricorrenze").select("*").order("id")),
    ]);
    if (c.error) throw c.error;
    if (sc.error) throw sc.error;
    state.scenari = sc.data && Array.isArray(sc.data.dati && sc.data.dati.scenari) ? sc.data.dati.scenari : [];
    state.cfg = { ...DEFAULT_CFG, ...(c.data ? c.data.dati : {}) };
    state.ops = ops.map(normOp);
    state.rules = rules.map(normRule);
    recalc();
  }
  function recalc() {
    const r = compute(state.cfg, state.ops);
    state.entries = r.entries; state.cur = r.cur; state.min = r.min;
    state.annEntries = state.ops.filter((o) => o.annullata).map((o) => ({ o, p: parts(o), b: null, ann: true }));
  }

  // ---------- generazione delle operazioni ricorrenti ----------
  // Crea le righe mancanti di tutte le regole attive. Idempotente: l'upsert ignora i duplicati
  // (unique ricorrenza_id + data_prevista), quindi due persone insieme non creano doppioni.
  async function genera() {
    const today = localToday();
    const r = await sb.from("ricorrenze").select("*").eq("attiva", true);
    if (r.error) throw r.error;
    const rules = (r.data || []).map(normRule);
    if (!rules.length) return 0;
    const ex = await fetchAll(() => sb.from("ops").select("ricorrenza_id,data_prevista").not("ricorrenza_id", "is", null).order("id"));
    const have = new Set(ex.map((x) => `${x.ricorrenza_id}|${x.data_prevista}`));
    const hasAny = new Set(ex.map((x) => x.ricorrenza_id));
    const rows = [];
    for (const rule of rules) {
      for (const d of Calc.generationDates(rule, today, hasAny.has(rule.id))) {
        if (!have.has(`${rule.id}|${d}`)) rows.push({ ...Calc.ruleRow(rule, d), updated_at: nowIso() });
      }
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("ops").upsert(rows.slice(i, i + 200), { onConflict: "ricorrenza_id,data_prevista", ignoreDuplicates: true });
      if (error) throw error;
    }
    return rows.length;
  }

  async function start() {
    showView("loading");
    let genFailed = false;
    try { await genera(); } catch (e) {
      if (isAuthError(e)) { await handleError(e); return; }
      genFailed = true;
    }
    try { await load(); } catch (e) { showView("app"); await handleError(e, "Caricamento non riuscito. Controlla la connessione e riprova."); return; }
    state.scenId = lsGet("conti-scen");
    state.open = loadOpen();
    const saved = lsGet("conti-tab");
    if (saved === "c1" || saved === "c2" || saved === "comune") state.tab = saved;
    showView("app"); render();
    if (genFailed) toast("Operazioni ricorrenti non aggiornate. Riprova più tardi.");
  }
  async function reload() { try { await load(); render(); } catch (e) { await handleError(e); } }
  // dopo una modifica alle regole: genera e ricarica
  async function regenAndReload() {
    try { await genera(); } catch (e) { await handleError(e, "Generazione delle operazioni ricorrenti non riuscita."); }
    await reload();
  }

  // ---------- autenticazione ----------
  sb.auth.onAuthStateChange((event, session) => {
    // differito: evita di chiamare supabase dentro la callback
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") { state.recovery = true; showView("recovery"); return; }
      if (state.recovery) return;
      if (session) {
        if (state.userId !== session.user.id) { state.userId = session.user.id; start(); }
      } else {
        state.userId = null; state.ops = []; state.rules = []; state.scenari = []; showView("login");
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
    $("#subtitle").textContent = `Dal ${fmtData(cfg.dataInizio)} · ${state.entries.length} operazioni`;
    $("#tab-c1").textContent = cfg.c1.nome; $("#tab-c2").textContent = cfg.c2.nome;
    document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#btn-add").textContent = tab === "comune" ? "+ Aggiungi uscita comune" : `+ Aggiungi a ${cfg[tab].nome}`;
    $("#main-view").hidden = state.view !== "main";
    $("#rules-view").hidden = state.view !== "rules";
    $("#sim-view").hidden = state.view !== "sim";
    if (state.view === "rules") { renderRules(); return; }
    if (state.view === "sim") { renderSim(); return; }
    renderCards(); renderMonthly(); renderList();
  }

  function renderCards() {
    const tot = state.entries.filter((e) => e.o.conto === "comune").reduce((s, e) => s + e.o.importo, 0);
    const personal = (k) => `<button type="button" class="card sum ${state.tab === k ? "active" : ""}" data-tab="${k}">
      <span class="t">${esc(state.cfg[k].nome)}</span><span class="big">${eur(state.cur[k])}</span>
      <span class="s">partenza ${eur(state.cfg[k].iniziale)} · minimo ${eur(state.min[k])}</span></button>`;
    $("#cards").innerHTML = personal("c1") + personal("c2") +
      `<button type="button" class="card sum ${state.tab === "comune" ? "active" : ""}" data-tab="comune">
      <span class="t">Conto comune · uscite</span><span class="big">${eur(tot)}</span>
      <span class="s">a testa ${eur(tot / 2)} · totale due conti ${eur(state.cur.c1 + state.cur.c2)}</span></button>`;
  }

  function groupByMonth(arr) {
    const m = new Map();
    for (const e of arr) {
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
      const months = groupByMonth(state.entries.filter((e) => e.o.conto === "comune"));
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
      const months = groupByMonth(state.entries.filter((e) => e.o.conto === tab || e.o.conto === "comune"));
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
      sub = (comune ? `metà di ${eur(o.importo)}` : "");
    }
    if (e.ann) sub = (sub ? sub + " · " : "") + "annullata";
    else sub = (sub ? sub + " · " : "") + (tab === "comune" ? "" : `saldo ${eur(e.b[tab])}`);
    sub = sub.replace(/ · $/, "");
    const tags = (o.categoria ? `<span class="tag">${esc(o.categoria)}</span>` : "") +
      (comune && tab !== "comune" ? `<span class="tag com">Conto comune · metà</span>` : "") +
      (o.ricorrenza_id ? `<button type="button" class="tag rec" data-act="rule" data-rid="${esc(o.ricorrenza_id)}" aria-label="Apri la regola ricorrente">🔁 ricorrente</button>` : "") +
      (o.ricorrenza_id && o.modificata ? `<span class="tag">modificata</span>` : "");
    let act;
    if (e.ann) {
      act = `<button type="button" class="btn sm" data-act="restore" data-id="${esc(o.id)}">Ripristina</button>`;
    } else if (state.confirmDel === o.id) {
      let warn = o.ricorrenza_id ? "Eliminare solo questo mese? Le altre occorrenze restano." : "Eliminare?";
      if (comune && tab !== "comune") warn += " È un'uscita comune: sparisce da entrambi i conti.";
      act = `<span class="confirm">${warn}</span>
        <button type="button" class="btn danger sm" data-act="delok" data-id="${esc(o.id)}">Elimina</button>
        <button type="button" class="btn sm" data-act="delno">Annulla</button>`;
    } else {
      act = `<button type="button" class="btn sm" data-act="edit" data-id="${esc(o.id)}" aria-label="Modifica ${esc(o.voce)}">Modifica</button>
        <button type="button" class="btn sm" data-act="del" data-id="${esc(o.id)}" aria-label="Elimina ${esc(o.voce)}">Elimina</button>`;
    }
    return `<li class="row${e.ann ? " ann" : ""}"><div class="d">${fmtGiorno(o.data)}</div>
      <div><div class="v">${esc(o.voce)}</div><div class="tags">${tags}</div></div>
      <div class="a"><div class="amt ${cls}">${sgn(amt)}</div><div class="sub">${sub}</div></div>
      <div class="act">${act}</div></li>`;
  }

  function renderList() {
    const tab = state.tab;
    const filter = (e) => (tab === "comune" ? e.o.conto === "comune" : e.o.conto === tab || e.o.conto === "comune");
    let arr = state.entries.filter(filter);
    if (state.showAnn) arr = arr.concat(state.annEntries.filter(filter)).sort((a, b) => Calc.cmp(a.o, b.o));
    const months = groupByMonth(arr);
    let h = tab === "comune" ? "" : `<div class="month"><div class="mhead"><span>Saldo di partenza · ${fmtData(state.cfg.dataInizio)}</span><span>${eur(state.cfg[tab].iniziale)}</span></div></div>`;
    if (!months.size) h += `<p class="empty">Nessuna operazione.</p>`;
    else h += `<div class="mbar"><button type="button" class="btn sm" data-mall="open">Espandi tutto</button><button type="button" class="btn sm" data-mall="close">Comprimi tutto</button></div>`;
    // di default è aperto solo il mese corrente (o il primo successivo, altrimenti l'ultimo)
    const keys = [...months.keys()], tm = localToday().slice(0, 7);
    const def = keys.includes(tm) ? tm : (keys.find((k) => k > tm) || keys[keys.length - 1]);
    const isOpen = (k) => (state.open ? state.open.has(k) : k === def);
    for (const [k, es] of months) {
      let ent = 0, usc = 0, last = null;
      for (const e of es) {
        if (e.ann) continue;
        last = e;
        if (tab === "comune") usc += e.o.importo;
        else if (e.p[tab] > 0) ent += e.p[tab]; else usc += -e.p[tab];
      }
      const tot = tab === "comune" ? `uscite ${eur(usc)}` : `entrate ${eur(ent)} · uscite ${eur(usc)}`;
      const foot = tab === "comune" || !last ? "" : `<div class="mfoot">Saldo fine mese: <strong>${eur(last.b[tab])}</strong></div>`;
      const open = isOpen(k);
      const saldo = tab === "comune" || !last ? "" : ` · saldo ${eur(last.b[tab])}`;
      h += `<div class="month"><button type="button" class="mhead" data-month="${k}" aria-expanded="${open}">
          <span><span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span> ${fmtMese(k)}</span><span class="tot">${tot}${open ? "" : saldo}</span></button>
        ${open ? `<ul class="rows">${es.map((e) => rowHtml(e, tab)).join("")}</ul>${foot}` : ""}</div>`;
    }
    $("#list").innerHTML = h;
  }
  // mesi aperti: ricordati su questo dispositivo (null = predefinito)
  function loadOpen() {
    try { const v = JSON.parse(lsGet("conti-open") || "null"); return Array.isArray(v) ? new Set(v) : null; } catch { return null; }
  }
  function setOpen(set) { state.open = set; lsSet("conti-open", JSON.stringify([...set])); renderList(); }

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
  $("#btn-rules").addEventListener("click", () => { state.view = "rules"; state.confirmRule = null; render(); window.scrollTo(0, 0); });
  $("#btn-sim").addEventListener("click", () => { state.view = "sim"; state.simConfirm = null; render(); window.scrollTo(0, 0); });
  $("#sim-back").addEventListener("click", () => { state.view = "main"; state.simConfirm = null; render(); });
  $("#rules-back").addEventListener("click", () => { state.view = "main"; state.confirmRule = null; render(); });
  $("#chk-ann").addEventListener("change", (e) => { state.showAnn = e.target.checked; renderList(); });

  $("#list").addEventListener("click", async (e) => {
    const mo = e.target.closest("[data-month]");
    if (mo) {
      const k = mo.dataset.month, cur = state.open ? new Set(state.open) : new Set([...document.querySelectorAll("#list button.mhead[aria-expanded=true]")].map((x) => x.dataset.month));
      if (cur.has(k)) cur.delete(k); else cur.add(k);
      setOpen(cur); return;
    }
    const all = e.target.closest("[data-mall]");
    if (all) {
      const keys = [...document.querySelectorAll("#list button.mhead")].map((x) => x.dataset.month);
      setOpen(new Set(all.dataset.mall === "open" ? [...(state.open || []), ...keys] : []));
      return;
    }
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === "edit") openOp(state.ops.find((o) => o.id === id));
    else if (act === "del") { state.confirmDel = id; renderList(); }
    else if (act === "delno") { state.confirmDel = null; renderList(); }
    else if (act === "rule") {
      const rule = state.rules.find((r) => r.id === b.dataset.rid);
      if (rule) openRule(rule); else toast("La regola non esiste più.");
    } else if (act === "delok") {
      b.disabled = true;
      const op = state.ops.find((o) => o.id === id);
      // una riga generata non si cancella (verrebbe rigenerata): si annulla
      const { error } = op && op.ricorrenza_id
        ? await sb.from("ops").update({ annullata: true, updated_at: nowIso() }).eq("id", id)
        : await sb.from("ops").delete().eq("id", id);
      state.confirmDel = null;
      if (error) { await handleError(error, "Eliminazione non riuscita. Controlla la connessione e riprova."); renderList(); return; }
      await reload();
    } else if (act === "restore") {
      b.disabled = true;
      const { error } = await sb.from("ops").update({ annullata: false, updated_at: nowIso() }).eq("id", id);
      if (error) { await handleError(error, "Ripristino non riuscito. Controlla la connessione e riprova."); renderList(); return; }
      await reload();
    }
  });

  // ---------- finestra operazione ----------
  const fConto = $("#f-conto");
  function fillCats(listId) {
    const cats = [...new Set([...BASE_CAT, ...state.ops.map((o) => o.categoria).filter(Boolean), ...state.rules.map((r) => r.categoria).filter(Boolean)])];
    $(listId).innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");
  }
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
    fillCats("#cat-list");
    $("#op-title").textContent = op ? "Modifica operazione" : "Nuova operazione";
    fConto.value = op ? op.conto : state.tab;
    $("#f-voce").value = op ? op.voce : "";
    $("#f-tipo").value = op ? op.tipo : "uscita";
    $("#f-importo").value = op ? String(op.importo).replace(".", ",") : "";
    const last = state.entries.length ? state.entries[state.entries.length - 1].o.data : cfg.dataInizio;
    $("#f-data").value = op ? op.data : last;
    $("#f-cat").value = op ? op.categoria || "" : "";
    const generated = !!(op && op.ricorrenza_id);
    $("#op-hint").hidden = !generated;
    $("#op-recur").hidden = generated;
    $("#op-msg").textContent = ""; $("#op-save").disabled = false;
    updateOpUi();
    $("#dlg-op").showModal();
  }
  fConto.addEventListener("change", updateOpUi);
  $("#f-importo").addEventListener("input", updateOpUi);
  $("#op-cancel").addEventListener("click", () => $("#dlg-op").close());

  // Legge e valida il modulo operazione: { row } oppure { err }
  function readOp() {
    const voce = $("#f-voce").value.trim(), importo = parseImporto($("#f-importo").value), data = $("#f-data").value;
    if (!voce) return { err: "Scrivi una descrizione." };
    if (!(importo > 0)) return { err: "L'importo deve essere maggiore di zero." };
    if (!/^\d{4}-\d\d-\d\d$/.test(data)) return { err: "Scegli una data." };
    const conto = fConto.value, op = state.editing;
    const generated = !!(op && op.ricorrenza_id);
    return {
      row: {
        id: op ? op.id : crypto.randomUUID(), data, voce: voce.slice(0, 120), conto,
        tipo: conto === "comune" ? "uscita" : $("#f-tipo").value, importo,
        categoria: $("#f-cat").value.trim() || null,
        ordine: op ? op.ordine : state.ops.reduce((m, o) => Math.max(m, o.ordine), -1) + 1,
        // data_prevista non cambia mai: così il generatore non ricrea la riga nella data originale
        ricorrenza_id: op ? op.ricorrenza_id ?? null : null,
        data_prevista: op ? op.data_prevista ?? null : null,
        modificata: op ? (generated ? true : !!op.modificata) : false,
        annullata: op ? !!op.annullata : false,
        updated_at: nowIso(),
      },
    };
  }

  $("#form-op").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#op-msg"); msg.textContent = "";
    const r = readOp();
    if (r.err) { msg.textContent = r.err; return; }
    $("#op-save").disabled = true;
    const { error } = await sb.from("ops").upsert(r.row);
    if (error) {
      $("#op-save").disabled = false;
      if (isAuthError(error)) { $("#dlg-op").close(); await handleError(error); return; }
      msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return;
    }
    $("#dlg-op").close();
    await reload();
  });

  // "Rendi ricorrente": apre il modulo regola precompilato con i dati dell'operazione
  $("#op-recur").addEventListener("click", () => {
    const msg = $("#op-msg"); msg.textContent = "";
    const r = readOp();
    if (r.err) { msg.textContent = r.err; return; }
    $("#dlg-op").close();
    openRule(null, r.row);
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
    const { error } = await sb.from("config").upsert({ id: "conti", dati, updated_at: nowIso() });
    if (error) {
      $("#start-save").disabled = false;
      if (isAuthError(error)) { $("#dlg-start").close(); await handleError(error); return; }
      msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return;
    }
    $("#dlg-start").close();
    await reload();
  });

  // ---------- vista "Ricorrenti" ----------
  function renderRules() {
    const today = localToday();
    const list = [...state.rules].sort((a, b) => (b.attiva - a.attiva) || a.voce.localeCompare(b.voce, "it"));
    if (!list.length) { $("#rules-list").innerHTML = `<li class="empty">Nessuna ricorrenza. Premi «+ Aggiungi» per crearne una.</li>`; return; }
    $("#rules-list").innerHTML = list.map((r) => {
      const next = r.attiva ? Calc.nextDates(r, today, 1)[0] : null;
      const sign = r.conto !== "comune" && r.tipo === "entrata" ? 1 : -1;
      const periodo = `dal ${fmtData(r.data_inizio)}${r.data_fine ? ` al ${fmtData(r.data_fine)}` : ""}`;
      const prossima = !r.attiva ? "sospesa" : next ? `prossima: ${fmtData(next)}` : "terminata";
      let act;
      const c = state.confirmRule;
      if (c && c.id === r.id) {
        const lead = c.mode === "del" ? "Eliminare la regola." : "Sospendere la regola.";
        act = `<span class="confirm">${lead} Eliminare anche le operazioni future non modificate?</span>
          <button type="button" class="btn danger sm" data-ract="yes" data-id="${esc(r.id)}">Sì, elimina anche le future</button>
          <button type="button" class="btn sm" data-ract="no" data-id="${esc(r.id)}">No, tienile</button>
          <button type="button" class="btn sm" data-ract="cancel">Annulla</button>`;
      } else {
        act = `<button type="button" class="btn sm" data-ract="edit" data-id="${esc(r.id)}">Modifica</button>
          <button type="button" class="btn sm" data-ract="toggle" data-id="${esc(r.id)}">${r.attiva ? "Sospendi" : "Riattiva"}</button>
          <button type="button" class="btn sm" data-ract="del" data-id="${esc(r.id)}">Elimina</button>`;
      }
      return `<li class="row rule"><div>
        <div class="v">${esc(r.voce)}</div>
        <div class="tags"><span class="tag">${esc(nomeConto(r.conto))}</span>${r.categoria ? `<span class="tag">${esc(r.categoria)}</span>` : ""}
          <span class="tag ${r.attiva ? "on" : "off"}">${r.attiva ? "attiva" : "sospesa"}</span></div>
        <div class="sub">${esc(Calc.freqText(r))} · ${periodo} · ${prossima}</div></div>
        <div class="a"><div class="amt ${sign > 0 ? "pos" : "neg"}">${sgn(sign * r.importo)}</div>${r.conto === "comune" ? `<div class="sub">metà per conto</div>` : ""}</div>
        <div class="act">${act}</div></li>`;
    }).join("");
  }

  $("#rule-add").addEventListener("click", () => openRule(null, null));
  $("#rules-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ract]"); if (!b) return;
    const act = b.dataset.ract, id = b.dataset.id;
    const rule = state.rules.find((r) => r.id === id);
    if (act === "edit") { openRule(rule); return; }
    if (act === "cancel") { state.confirmRule = null; renderRules(); return; }
    if (act === "del") { state.confirmRule = { id, mode: "del" }; renderRules(); return; }
    if (act === "toggle") {
      if (rule.attiva) { state.confirmRule = { id, mode: "sus" }; renderRules(); return; }
      b.disabled = true;
      const { error } = await sb.from("ricorrenze").update({ attiva: true, updated_at: nowIso() }).eq("id", id);
      if (error) { await handleError(error); renderRules(); return; }
      await regenAndReload(); return;
    }
    if (act === "yes" || act === "no") {
      const { mode } = state.confirmRule; const dropFuture = act === "yes";
      state.confirmRule = null;
      document.querySelectorAll("#rules-list button").forEach((x) => { x.disabled = true; });
      const today = localToday();
      try {
        if (mode === "sus") {
          if (dropFuture) { // righe future non modificate e non annullate
            const r = await sb.from("ops").delete().eq("ricorrenza_id", id).gte("data_prevista", today).eq("modificata", false).eq("annullata", false);
            if (r.error) throw r.error;
          }
          const r = await sb.from("ricorrenze").update({ attiva: false, updated_at: nowIso() }).eq("id", id);
          if (r.error) throw r.error;
        } else {
          if (dropFuture) { // anche le annullate: la regola sparisce
            const r = await sb.from("ops").delete().eq("ricorrenza_id", id).gte("data_prevista", today).eq("modificata", false);
            if (r.error) throw r.error;
          }
          // le righe passate restano: ricorrenza_id diventa null (on delete set null)
          const r = await sb.from("ricorrenze").delete().eq("id", id);
          if (r.error) throw r.error;
        }
      } catch (err) { await handleError(err); }
      await reload();
    }
  });

  // ---------- modulo regola ----------
  const rConto = $("#r-conto"), rFreq = $("#r-freq");
  function ruleFromForm() {
    const conto = rConto.value;
    const ogni = rFreq.value === "altro" ? Number($("#r-ogni").value) : Number(rFreq.value);
    return {
      conto, voce: $("#r-voce").value.trim(), tipo: conto === "comune" ? "uscita" : $("#r-tipo").value,
      importo: parseImporto($("#r-importo").value), categoria: $("#r-cat").value.trim() || null,
      ogni_mesi: ogni, giorno: Number($("#r-giorno").value), data_inizio: $("#r-inizio").value, data_fine: $("#r-fine").value || null,
    };
  }
  function validateRule(r) {
    if (!r.voce) return "Scrivi una descrizione.";
    if (!(r.importo > 0)) return "L'importo deve essere maggiore di zero.";
    if (!Number.isInteger(r.ogni_mesi) || r.ogni_mesi < 1 || r.ogni_mesi > 24) return "Ogni quanti mesi: scegli un numero da 1 a 24.";
    if (!Number.isInteger(r.giorno) || r.giorno < 1 || r.giorno > 31) return "Il giorno del mese deve essere da 1 a 31.";
    if (!/^\d{4}-\d\d-\d\d$/.test(r.data_inizio)) return "Scegli la data di inizio.";
    if (r.data_fine && r.data_fine < r.data_inizio) return "La data di fine non può precedere l'inizio.";
    return "";
  }
  function updateRuleUi() {
    $("#r-tipo-wrap").hidden = rConto.value === "comune";
    $("#r-ogni").hidden = rFreq.value !== "altro";
    const r = ruleFromForm();
    const ok = Number.isInteger(r.ogni_mesi) && r.ogni_mesi >= 1 && r.ogni_mesi <= 24 && Number.isInteger(r.giorno) && r.giorno >= 1 && r.giorno <= 31 && /^\d{4}-\d\d-\d\d$/.test(r.data_inizio);
    $("#r-preview").textContent = ok
      ? (() => { const d = Calc.nextDates(r, localToday(), 3); return d.length ? `Prossime ${d.length === 1 ? "data" : d.length + " date"}: ${d.map(fmtData).join(", ")}` : "Nessuna data futura."; })()
      : "";
  }
  ["r-conto", "r-freq"].forEach((id) => $("#" + id).addEventListener("change", updateRuleUi));
  ["r-ogni", "r-giorno", "r-inizio", "r-fine", "r-importo"].forEach((id) => $("#" + id).addEventListener("input", updateRuleUi));
  $("#r-inizio").addEventListener("change", () => { if (!$("#r-giorno").value && $("#r-inizio").value) { $("#r-giorno").value = Number($("#r-inizio").value.slice(8)); updateRuleUi(); } });

  // rule: regola esistente; fromOp: operazione da collegare (riga completa)
  function openRule(rule, fromOp) {
    state.editingRule = rule || null; state.linkOp = fromOp || null; state.ruleDraft = null;
    const { cfg } = state;
    rConto.options[0].textContent = cfg.c1.nome; rConto.options[1].textContent = cfg.c2.nome;
    fillCats("#cat-list");
    const src = rule || fromOp;
    $("#rule-title").textContent = rule ? "Modifica ricorrenza" : "Nuova ricorrenza";
    rConto.value = src ? src.conto : (state.tab === "comune" ? "comune" : state.tab);
    $("#r-voce").value = src ? src.voce : "";
    $("#r-tipo").value = src ? src.tipo : "uscita";
    $("#r-importo").value = src ? String(src.importo).replace(".", ",") : "";
    $("#r-cat").value = src ? src.categoria || "" : "";
    const ogni = rule ? String(rule.ogni_mesi) : "1";
    rFreq.value = QUICK_FREQ.includes(ogni) ? ogni : "altro";
    $("#r-ogni").value = QUICK_FREQ.includes(ogni) ? "" : ogni;
    const inizio = rule ? rule.data_inizio : fromOp ? fromOp.data : localToday();
    $("#r-inizio").value = inizio;
    $("#r-giorno").value = rule ? rule.giorno : Number(inizio.slice(8));
    $("#r-fine").value = rule && rule.data_fine ? rule.data_fine : "";
    $("#rule-msg").textContent = ""; $("#rule-save").disabled = false;
    $("#rule-ask").hidden = true; $("#rule-actions").hidden = false;
    updateRuleUi();
    $("#dlg-rule").showModal();
  }
  $("#rule-cancel").addEventListener("click", () => $("#dlg-rule").close());
  // Se si chiude senza salvare dopo "Rendi ricorrente", si torna all'operazione (nessun dato perso)
  $("#dlg-rule").addEventListener("close", () => {
    const pending = state.linkOp; state.linkOp = null;
    if (pending) openOp(pending);
  });

  const SAME = ["voce", "conto", "tipo", "importo", "categoria", "ogni_mesi", "giorno", "data_inizio", "data_fine"];
  $("#form-rule").addEventListener("submit", (e) => {
    e.preventDefault();
    const r = ruleFromForm(), err = validateRule(r);
    $("#rule-msg").textContent = err;
    if (err) return;
    state.ruleDraft = r;
    const old = state.editingRule;
    if (!old) { saveRule(false); return; }
    if (SAME.every((k) => (old[k] ?? null) === (r[k] ?? null))) { $("#dlg-rule").close(); return; } // nessuna modifica
    $("#rule-actions").hidden = true; $("#rule-ask").hidden = false;
  });
  $("#ask-back").addEventListener("click", () => { $("#rule-ask").hidden = true; $("#rule-actions").hidden = false; });
  $("#ask-no").addEventListener("click", () => saveRule(false));
  $("#ask-yes").addEventListener("click", () => saveRule(true));

  async function applyToFuture(old, nuova) {
    const today = localToday();
    const schedule = old.ogni_mesi !== nuova.ogni_mesi || old.giorno !== nuova.giorno || old.data_inizio !== nuova.data_inizio ||
      (old.data_fine || null) !== (nuova.data_fine || null);
    const base = (q) => q.eq("ricorrenza_id", old.id).gte("data_prevista", today).eq("modificata", false).eq("annullata", false);
    if (schedule) { // elimina le future non modificate: poi verranno rigenerate
      const { error } = await base(sb.from("ops").delete());
      if (error) throw error;
    } else {
      const { error } = await base(sb.from("ops").update({
        voce: nuova.voce, conto: nuova.conto, tipo: nuova.tipo, importo: nuova.importo, categoria: nuova.categoria, updated_at: nowIso(),
      }));
      if (error) throw error;
    }
  }

  async function saveRule(applyFuture) {
    const old = state.editingRule, draft = state.ruleDraft;
    if (!draft) return;
    const rule = { ...draft, id: old ? old.id : crypto.randomUUID(), attiva: old ? old.attiva : true, updated_at: nowIso() };
    const msg = $("#rule-msg");
    ["#rule-save", "#ask-yes", "#ask-no", "#ask-back"].forEach((s) => { $(s).disabled = true; });
    const enable = () => ["#rule-save", "#ask-yes", "#ask-no", "#ask-back"].forEach((s) => { $(s).disabled = false; });
    try {
      let r = await sb.from("ricorrenze").upsert(rule);
      if (r.error) throw r.error;
      if (state.linkOp) { // collega l'operazione di partenza invece di crearne una doppia
        const op = { ...state.linkOp, ricorrenza_id: rule.id, data_prevista: state.linkOp.data, modificata: false, annullata: false, updated_at: nowIso() };
        r = await sb.from("ops").upsert(op);
        if (r.error) throw r.error;
        state.linkOp = null;
      }
      if (old && applyFuture) await applyToFuture(old, rule);
      if (rule.attiva) await genera();
    } catch (err) {
      enable();
      if (isAuthError(err)) { state.linkOp = null; $("#dlg-rule").close(); await handleError(err); return; }
      $("#rule-ask").hidden = true; $("#rule-actions").hidden = false;
      msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return;
    }
    enable();
    $("#dlg-rule").close();
    await reload();
  }

  // ---------- simulazione ----------
  // Gli scenari stanno nella tabella `config` (riga id = 'scenari'): nessuna tabella nuova.
  // Si rilegge la riga prima di scrivere, così due persone non si sovrascrivono a vicenda.
  async function saveScenari(mutate) {
    const r = await sb.from("config").select("dati").eq("id", "scenari").maybeSingle();
    if (r.error) throw r.error;
    const dati = { ...(r.data ? r.data.dati : {}) };
    dati.scenari = Array.isArray(dati.scenari) ? dati.scenari : [];
    mutate(dati);
    const w = await sb.from("config").upsert({ id: "scenari", dati, updated_at: nowIso() });
    if (w.error) throw w.error;
    state.scenari = dati.scenari;
  }
  async function simSave(mutate, okMsg) {
    try { await saveScenari(mutate); } catch (e) {
      await handleError(e, "Salvataggio non riuscito. Controlla la connessione e riprova."); return false;
    }
    if (okMsg) toast(okMsg);
    renderSim(); return true;
  }
  const curScen = () => state.scenari.find((s) => s.id === state.scenId) || state.scenari[0] || null;
  const contoSim = (k) => (k === "tot" ? "Conto 1 + Conto 2" : nomeConto(k));
  const voceWhen = (v) => {
    if (!(Number(v.ogni_mesi) > 0)) return `una volta il ${fmtData(v.data)}`;
    const last = Calc.expandVoce(v).pop().data;
    const n = Number(v.ogni_mesi);
    return `${n === 1 ? "ogni mese" : n === 12 ? "ogni anno" : `ogni ${n} mesi`} dal ${fmtData(v.data)} · ${v.volte} volte (fino al ${fmtData(last)})`;
  };

  function renderSim() {
    const body = $("#sim-body");
    const sc = curScen();
    if (!sc) { body.innerHTML = `<p class="empty">Nessuno scenario. Premi «+ Scenario» per crearne uno, per esempio «Acquisto casa».</p>`; return; }
    state.scenId = sc.id;
    const conf = state.simConfirm;
    const opts = state.scenari.map((s) => `<option value="${esc(s.id)}"${s.id === sc.id ? " selected" : ""}>${esc(s.nome)}</option>`).join("");
    const delAsk = conf && conf.type === "scen";
    let h = `<div class="sim-bar"><select id="sim-sel" aria-label="Scenario">${opts}</select>
      ${delAsk ? `<span class="confirm">Eliminare lo scenario «${esc(sc.nome)}»?</span>
        <button type="button" class="btn danger sm" data-sact="scen-delok">Elimina</button>
        <button type="button" class="btn sm" data-sact="cancel">Annulla</button>`
      : `<button type="button" class="btn sm" data-sact="scen-edit">Nome e obiettivo</button>
        <button type="button" class="btn sm" data-sact="scen-dup">Duplica</button>
        <button type="button" class="btn sm" data-sact="scen-del">Elimina</button>`}</div>`;

    const res = Calc.simulate(state.cfg, state.ops, sc);
    const g = sc.obiettivo;

    // verdetto
    if (res.goalDef && res.goal) {
      const gd = res.goalDef, gr = res.goal;
      h += `<div class="card verdict ${gr.ok ? "ok" : "ko"}">
        <div class="big">${gr.ok ? "✅ Ce la fai" : "❌ Non ci arrivi"} — ${esc(contoSim(gd.conto))} al ${fmtData(gd.data)}</div>
        <div>Con lo scenario: <strong>${eur(gr.saldoSim)}</strong> · obiettivo ${eur(gd.minimo)} · ${gr.ok ? "margine" : "mancano"} <strong>${eur(Math.abs(gr.margine))}</strong></div>
        <div class="sub">Senza scenario: ${eur(gr.saldoReale)}</div></div>`;
    } else if (g && g.minimo !== "" && g.minimo != null) {
      h += `<div class="card verdict"><div class="sub">Obiettivo incompleto: aggiungi conto, importo e data da «Nome e obiettivo», oppure aggiungi almeno una voce.</div></div>`;
    } else {
      h += `<div class="card verdict"><div class="sub">Nessun obiettivo. Impostalo da «Nome e obiettivo» per avere un verdetto.</div></div>`;
    }

    // voci
    h += `<div class="sim-h"><h3>Voci dello scenario</h3><button type="button" class="btn primary sm" data-sact="voce-add">+ Voce</button></div>`;
    const voci = sc.voci || [];
    if (!voci.length) h += `<p class="empty">Nessuna voce. Aggiungine una, per esempio la caparra o la rata del mutuo.</p>`;
    else {
      h += `<ul class="rows">` + voci.map((v) => {
        const sign = v.conto !== "comune" && v.tipo === "entrata" ? 1 : -1;
        const on = v.attiva !== false;
        const ask = conf && conf.type === "voce" && conf.id === v.id;
        const act = ask
          ? `<span class="confirm">Eliminare questa voce?</span>
             <button type="button" class="btn danger sm" data-sact="voce-delok" data-id="${esc(v.id)}">Elimina</button>
             <button type="button" class="btn sm" data-sact="cancel">Annulla</button>`
          : `<button type="button" class="btn sm" data-sact="voce-edit" data-id="${esc(v.id)}">Modifica</button>
             <button type="button" class="btn sm" data-sact="voce-del" data-id="${esc(v.id)}">Elimina</button>`;
        return `<li class="row vrow${on ? "" : " off"}">
          <label class="chk"><input type="checkbox" data-sact="voce-toggle" data-id="${esc(v.id)}"${on ? " checked" : ""} aria-label="Includi ${esc(v.voce)} nello scenario"></label>
          <div><div class="v">${esc(v.voce)}</div>
            <div class="tags"><span class="tag">${esc(nomeConto(v.conto))}</span></div>
            <div class="sub">${voceWhen(v)}</div></div>
          <div class="a"><div class="amt ${sign > 0 ? "pos" : "neg"}">${sgn(sign * Number(v.importo))}</div>${v.conto === "comune" ? `<div class="sub">metà per conto</div>` : ""}</div>
          <div class="act">${act}</div></li>`;
      }).join("") + `</ul>`;
    }

    // risultati
    if (res.rows.length) {
      const n = state.cfg;
      const gd = res.goalDef;
      const goalMonth = gd ? gd.data.slice(0, 7) : null;
      const low = (k, row) => {
        if (!gd || row.mese < goalMonth) return false;
        const s = k === "tot" ? r2(row.sim.c1 + row.sim.c2) : row.sim[k];
        return gd.conto === k && s < gd.minimo;
      };
      const cell = (v, extra) => `<td class="${(v < 0 ? "neg-cell " : "") + (extra || "")}">${eur(v)}</td>`;
      const dif = (a, b) => { const d = r2(b - a); return `<td>${d === 0 ? "—" : sgn(d)}</td>`; };
      h += `<div class="sim-h"><h3>Mese per mese</h3></div>
        <section class="card scroll"><table><thead><tr><th>Fine mese</th>
          <th>${esc(n.c1.nome)} reale</th><th>con scenario</th><th>diff.</th>
          <th>${esc(n.c2.nome)} reale</th><th>con scenario</th><th>diff.</th></tr></thead><tbody>` +
        res.rows.map((r) => `<tr class="${goalMonth === r.mese ? "goal-row" : ""}"><td>${fmtMese(r.mese)}</td>
          ${cell(r.real.c1)}${cell(r.sim.c1, low("c1", r) ? "low-cell" : "")}${dif(r.real.c1, r.sim.c1)}
          ${cell(r.real.c2)}${cell(r.sim.c2, low("c2", r) ? "low-cell" : "")}${dif(r.real.c2, r.sim.c2)}</tr>`).join("") +
        `</tbody></table></section>
        <p class="note">Punto più basso con lo scenario: ${esc(n.c1.nome)} <strong>${eur(res.minSim.c1.v)}</strong> (${fmtData(res.minSim.c1.d)}) · ${esc(n.c2.nome)} <strong>${eur(res.minSim.c2.v)}</strong> (${fmtData(res.minSim.c2.d)}).
        Il calcolo arriva fino a ${fmtData(res.endDate)} e conta solo quello che è registrato: stipendi e spese non ancora inseriti non sono inclusi.</p>`;
    }
    body.innerHTML = h;
  }

  const newId = () => crypto.randomUUID();
  $("#sim-body").addEventListener("change", async (e) => {
    if (e.target.id === "sim-sel") { state.scenId = e.target.value; lsSet("conti-scen", state.scenId); state.simConfirm = null; renderSim(); return; }
    const t = e.target.closest('input[data-sact="voce-toggle"]'); if (!t) return;
    const id = t.dataset.id, on = t.checked;
    await simSave((d) => { const s = d.scenari.find((x) => x.id === state.scenId); const v = s && s.voci.find((x) => x.id === id); if (v) v.attiva = on; });
  });
  $("#sim-body").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-sact]"); if (!b) return;
    const a = b.dataset.sact, id = b.dataset.id, sc = curScen();
    if (a === "cancel") { state.simConfirm = null; renderSim(); return; }
    if (a === "voce-add") { openVoce(null); return; }
    if (a === "voce-edit") { openVoce(sc.voci.find((v) => v.id === id)); return; }
    if (a === "voce-del") { state.simConfirm = { type: "voce", id }; renderSim(); return; }
    if (a === "voce-delok") { state.simConfirm = null; await simSave((d) => { const s = d.scenari.find((x) => x.id === sc.id); if (s) s.voci = s.voci.filter((v) => v.id !== id); }); return; }
    if (a === "scen-edit") { openScen(sc); return; }
    if (a === "scen-del") { state.simConfirm = { type: "scen" }; renderSim(); return; }
    if (a === "scen-delok") {
      state.simConfirm = null;
      await simSave((d) => { d.scenari = d.scenari.filter((s) => s.id !== sc.id); });
      state.scenId = state.scenari[0] ? state.scenari[0].id : null; renderSim(); return;
    }
    if (a === "scen-dup") {
      const copy = { ...JSON.parse(JSON.stringify(sc)), id: newId(), nome: `${sc.nome} (copia)` };
      copy.voci = copy.voci.map((v) => ({ ...v, id: newId() }));
      if (await simSave((d) => { d.scenari.push(copy); }, "Scenario duplicato.")) { state.scenId = copy.id; lsSet("conti-scen", copy.id); renderSim(); }
    }
  });

  // --- finestra scenario ---
  let editingScen = null;
  const scConto = $("#sc-conto");
  function openScen(sc) {
    editingScen = sc;
    scConto.options[0].textContent = state.cfg.c1.nome; scConto.options[1].textContent = state.cfg.c2.nome;
    $("#scen-title").textContent = sc ? "Nome e obiettivo" : "Nuovo scenario";
    $("#sc-nome").value = sc ? sc.nome : "";
    const g = sc && sc.obiettivo;
    scConto.value = g && g.conto ? g.conto : "c1";
    $("#sc-min").value = g && g.minimo !== "" && g.minimo != null ? String(g.minimo).replace(".", ",") : "";
    $("#sc-data").value = g && g.data ? g.data : "";
    $("#scen-msg").textContent = ""; $("#scen-save").disabled = false;
    $("#dlg-scen").showModal();
  }
  $("#sim-new").addEventListener("click", () => openScen(null));
  $("#scen-cancel").addEventListener("click", () => $("#dlg-scen").close());
  $("#form-scen").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#scen-msg"); msg.textContent = "";
    const nome = $("#sc-nome").value.trim(), minRaw = $("#sc-min").value.trim(), data = $("#sc-data").value;
    if (!nome) { msg.textContent = "Scrivi un nome per lo scenario."; return; }
    let obiettivo = null;
    if (minRaw || data) {
      const minimo = parseImporto(minRaw.replace(/^-/, ""));
      if (Number.isNaN(minimo) || !data) { msg.textContent = "Per l'obiettivo servono importo e data (oppure lascia vuoti entrambi)."; return; }
      obiettivo = { conto: scConto.value, minimo: /^\s*-/.test(minRaw) ? -minimo : minimo, data };
    }
    $("#scen-save").disabled = true;
    const sc = editingScen;
    const id = sc ? sc.id : newId();
    const ok = await simSave((d) => {
      const s = d.scenari.find((x) => x.id === id);
      if (s) { s.nome = nome; s.obiettivo = obiettivo; } else d.scenari.push({ id, nome, obiettivo, voci: [] });
    });
    $("#scen-save").disabled = false;
    if (!ok) { msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return; }
    state.scenId = id; lsSet("conti-scen", id);
    $("#dlg-scen").close(); renderSim();
  });

  // --- finestra voce ---
  const SIM_TPL = {
    mutuo: { voce: "Rata mutuo", conto: "comune", tipo: "uscita", ogni: "1", volte: 240 },
    caparra: { voce: "Caparra", conto: "comune", tipo: "uscita", ogni: "0" },
    notaio: { voce: "Notaio", conto: "comune", tipo: "uscita", ogni: "0" },
    agenzia: { voce: "Agenzia", conto: "comune", tipo: "uscita", ogni: "0" },
    imposte: { voce: "Imposte", conto: "comune", tipo: "uscita", ogni: "0" },
    spesa: { voce: "Spesa", tipo: "uscita", ogni: "0" },
    entrata: { voce: "Entrata", tipo: "entrata", ogni: "1", volte: 12 },
  };
  const SIM_QUICK = ["0", "1", "2", "3", "6", "12"];
  const vConto = $("#v-conto"), vFreq = $("#v-freq");
  let editingVoce = null;
  function voceFromForm() {
    const conto = vConto.value;
    const ogni = vFreq.value === "altro" ? Number($("#v-ogni").value) : Number(vFreq.value);
    return {
      voce: $("#v-voce").value.trim(), conto, tipo: conto === "comune" ? "uscita" : $("#v-tipo").value,
      importo: parseImporto($("#v-importo").value), data: $("#v-data").value, ogni_mesi: ogni,
      volte: ogni > 0 ? Number($("#v-volte").value) : 1,
    };
  }
  function updateVoceUi() {
    $("#v-tipo-wrap").hidden = vConto.value === "comune";
    $("#v-ogni").hidden = vFreq.value !== "altro";
    const periodic = vFreq.value !== "0";
    $("#v-volte-wrap").hidden = !periodic;
    const v = voceFromForm();
    const okDate = /^\d{4}-\d\d-\d\d$/.test(v.data);
    let txt = "";
    if (okDate && v.importo > 0) {
      const imp = v.importo;
      if (v.conto === "comune") txt = `Divisa: ${eur(r2(imp / 2))} su ${state.cfg.c1.nome} e ${eur(r2(imp - r2(imp / 2)))} su ${state.cfg.c2.nome}. `;
      if (v.ogni_mesi > 0 && Number.isInteger(v.volte) && v.volte >= 1 && v.volte <= 600 && Number.isInteger(v.ogni_mesi) && v.ogni_mesi <= 24) {
        const last = Calc.expandVoce({ ...v, id: "p" }).pop().data;
        txt += `Totale ${eur(imp * v.volte)} in ${v.volte} volte, fino al ${fmtData(last)}.`;
      }
    }
    $("#v-preview").textContent = txt;
  }
  ["v-conto", "v-freq"].forEach((id) => $("#" + id).addEventListener("change", updateVoceUi));
  ["v-ogni", "v-volte", "v-data", "v-importo"].forEach((id) => $("#" + id).addEventListener("input", updateVoceUi));
  $("#v-tpl").addEventListener("change", () => {
    const t = SIM_TPL[$("#v-tpl").value]; if (!t) return;
    if (t.voce) $("#v-voce").value = t.voce;
    if (t.conto) vConto.value = t.conto;
    if (t.tipo) $("#v-tipo").value = t.tipo;
    if (t.ogni) { vFreq.value = t.ogni; $("#v-ogni").value = ""; }
    if (t.volte) $("#v-volte").value = t.volte;
    updateVoceUi();
  });
  function openVoce(v) {
    editingVoce = v || null;
    vConto.options[0].textContent = state.cfg.c1.nome; vConto.options[1].textContent = state.cfg.c2.nome;
    $("#voce-title").textContent = v ? "Modifica voce" : "Nuova voce";
    $("#v-tpl").value = ""; $("#v-tpl").hidden = !!v; document.querySelector('label[for="v-tpl"]').hidden = !!v;
    vConto.value = v ? v.conto : "comune";
    $("#v-voce").value = v ? v.voce : "";
    $("#v-tipo").value = v ? v.tipo : "uscita";
    $("#v-importo").value = v ? String(v.importo).replace(".", ",") : "";
    $("#v-data").value = v ? v.data : localToday();
    const ogni = v ? String(v.ogni_mesi || 0) : "0";
    vFreq.value = SIM_QUICK.includes(ogni) ? ogni : "altro";
    $("#v-ogni").value = SIM_QUICK.includes(ogni) ? "" : ogni;
    $("#v-volte").value = v && v.ogni_mesi > 0 ? v.volte : 12;
    $("#voce-msg").textContent = ""; $("#voce-save").disabled = false;
    updateVoceUi();
    $("#dlg-voce").showModal();
  }
  $("#voce-cancel").addEventListener("click", () => $("#dlg-voce").close());
  $("#form-voce").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#voce-msg"); msg.textContent = "";
    const v = voceFromForm();
    if (!v.voce) { msg.textContent = "Scrivi una descrizione."; return; }
    if (!(v.importo > 0)) { msg.textContent = "L'importo deve essere maggiore di zero."; return; }
    if (!/^\d{4}-\d\d-\d\d$/.test(v.data)) { msg.textContent = "Scegli una data."; return; }
    if (v.ogni_mesi > 0) {
      if (!Number.isInteger(v.ogni_mesi) || v.ogni_mesi > 24) { msg.textContent = "Ogni quanti mesi: scegli un numero da 1 a 24."; return; }
      if (!Number.isInteger(v.volte) || v.volte < 1 || v.volte > 600) { msg.textContent = "Il numero di volte deve essere da 1 a 600."; return; }
    } else v.volte = 1;
    $("#voce-save").disabled = true;
    const id = editingVoce ? editingVoce.id : newId(), sid = state.scenId;
    const ok = await simSave((d) => {
      const s = d.scenari.find((x) => x.id === sid); if (!s) return;
      s.voci = s.voci || [];
      const cur = s.voci.find((x) => x.id === id);
      if (cur) Object.assign(cur, v); else s.voci.push({ id, ...v, attiva: true });
    });
    $("#voce-save").disabled = false;
    if (!ok) { msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return; }
    $("#dlg-voce").close(); renderSim();
  });

  // ---------- CSV ----------
  async function copyCsv() {
    const num = (n) => String(r2(n) + 0).replace(".", ",");
    const q = (s) => (/[;"\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const lines = ["Data;Descrizione;Conto;Categoria;Effetto conto 1;Effetto conto 2;Saldo conto 1;Saldo conto 2"];
    for (const e of state.entries) { // le operazioni annullate non sono in `entries`
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
