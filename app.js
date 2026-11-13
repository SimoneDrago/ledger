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
    cfg: DEFAULT_CFG, ops: [], rules: [], tab: "c1", view: "main", showAnn: false,
    entries: [], annEntries: [], cur: { c1: 0, c2: 0 }, min: { c1: 0, c2: 0 },
    userId: null, recovery: false, confirmDel: null, confirmRule: null,
    editing: null, editingRule: null, ruleDraft: null, linkOp: null,
  };

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
    const [c, ops, rules] = await Promise.all([
      sb.from("config").select("dati").eq("id", "conti").maybeSingle(),
      fetchAll(() => sb.from("ops").select("*").order("id")),
      fetchAll(() => sb.from("ricorrenze").select("*").order("id")),
    ]);
    if (c.error) throw c.error;
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
        state.userId = null; state.ops = []; state.rules = []; showView("login");
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
    if (state.view === "rules") { renderRules(); return; }
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
  $("#btn-rules").addEventListener("click", () => { state.view = "rules"; state.confirmRule = null; render(); window.scrollTo(0, 0); });
  $("#rules-back").addEventListener("click", () => { state.view = "main"; state.confirmRule = null; render(); });
  $("#chk-ann").addEventListener("change", (e) => { state.showAnn = e.target.checked; renderList(); });

  $("#list").addEventListener("click", async (e) => {
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
