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
  // Modalità privacy: saldi, entrate e stipendi diventano asterischi; le uscite restano visibili.
  const MASK = "***** €";
  function mEur(n) { return state.hide ? MASK : eur(n); }
  // Nome del conto da mostrare: con l'occhio attivo le parentesi con numeri (es. lo stipendio) diventano (*****).
  function cname(k) {
    const n = state.cfg[k].nome;
    return state.hide ? n.replace(/\([^)]*\d[^)]*\)/g, "(*****)") : n;
  }
  function sgnPriv(n) { return state.hide && n > 0 ? MASK : sgn(n); }
  const hiddenWarn = (what) => { toast(`Mostra i dati (icona occhio) per modificare ${what}.`); };
  const isEntrata = (x) => !!x && x.conto !== "comune" && x.tipo === "entrata";
  const fmtMese = (k) => `${MESI[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;
  const fmtGiorno = (d) => `${Number(d.slice(8))} ${mesiCorti[Number(d.slice(5, 7)) - 1]}`;
  const fmtData = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const pad = (n) => String(n).padStart(2, "0");
  // Data di oggi nel fuso locale, come stringa YYYY-MM-DD (niente toISOString: sarebbe UTC)
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const CAT_ICON = { Stipendio: "💼", Auto: "🚗", "Università": "🎓", Abbonamenti: "📺", Telefono: "📱", Spesa: "🛒", Varie: "✨", "Acquisto casa": "🏠", Casa: "🛋️", Lavori: "🔨", Utenze: "💡", Altro: "📌" };
  const BASE_CAT = ["Stipendio", "Auto", "Università", "Abbonamenti", "Telefono", "Spesa", "Varie", "Acquisto casa", "Casa", "Lavori", "Utenze", "Altro"];
  const DEFAULT_CFG = { c1: { nome: "Conto 1", iniziale: 0 }, c2: { nome: "Conto 2", iniziale: 0 }, dataInizio: localToday() };
  const QUICK_FREQ = ["1", "2", "3", "6", "12"];

  const state = {
    cfg: DEFAULT_CFG, ops: [], rules: [], scenari: [], scenId: null, catConto: "tot", catPer: null, hide: false, simChart: null, chartData: null, shown: {}, panelPer: null, simConfirm: null, tab: "c1", view: "main", showAnn: false,
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
    // una regola ha al massimo una occorrenza al mese: se il mese ha già una riga (anche spostata o annullata) non se ne crea un'altra
    const have = new Set(ex.map((x) => `${x.ricorrenza_id}|${String(x.data_prevista || "").slice(0, 7)}`));
    const hasAny = new Set(ex.map((x) => x.ricorrenza_id));
    const rows = [];
    for (const rule of rules) {
      for (const d of Calc.generationDates(rule, today, hasAny.has(rule.id))) {
        if (!have.has(`${rule.id}|${d.slice(0, 7)}`)) rows.push({ ...Calc.ruleRow(rule, d), updated_at: nowIso() });
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
    state.hide = lsGet("conti-hide") === "1"; applyHide();
    const saved = lsGet("conti-tab");
    if (saved === "c1" || saved === "c2" || saved === "comune") state.tab = saved;
    showView("app");
    const va = $("#view-app"); va.classList.add("enter"); setTimeout(() => va.classList.remove("enter"), 1500);
    render();
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

  // ---------- privacy (occhio) ----------
  function applyHide() {
    const b = $("#btn-eye");
    b.setAttribute("aria-pressed", String(state.hide));
    const label = state.hide ? "Mostra saldi ed entrate" : "Nascondi saldi ed entrate";
    b.setAttribute("aria-label", label); b.title = label;
  }
  $("#btn-eye").addEventListener("click", () => {
    state.hide = !state.hide; lsSet("conti-hide", state.hide ? "1" : "0");
    applyHide(); render();
  });

  // ---------- rendering ----------
  const nomeConto = (k) => (k === "comune" ? "Conto comune" : cname(k));

  function render() {
    const { cfg, tab } = state;
    $("#subtitle").textContent = `Dal ${fmtData(cfg.dataInizio)} · ${state.entries.length} operazioni`;
    $("#tab-c1").textContent = cname("c1"); $("#tab-c2").textContent = cname("c2");
    document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#btn-add").textContent = tab === "comune" ? "+ Aggiungi uscita comune" : `+ Aggiungi a ${cname(tab)}`;
    markNav(state.view);
    $("#main-view").hidden = state.view !== "main";
    $("#rules-view").hidden = state.view !== "rules";
    $("#sim-view").hidden = state.view !== "sim";
    $("#cat-view").hidden = state.view !== "cat";
    if (state.view === "cat") { renderCat(); return; }
    if (state.view === "rules") { renderRules(); return; }
    if (state.view === "sim") { renderSim(); return; }
    renderCards(); renderMonthly(); renderList(); renderCatPanel();
  }

  function renderCards() {
    // Il numero grande è il saldo di OGGI; la proiezione (dopo l'ultima operazione registrata) è in piccolo.
    const today = localToday();
    const now = Calc.balanceAt(state.entries, state.cfg, today);
    const lastDate = state.entries.length ? state.entries[state.entries.length - 1].o.data : null;
    const future = lastDate && lastDate > today;
    const proj = (k) => (future ? `fine ${fmtMese(lastDate.slice(0, 7))}: ${mEur(state.cur[k])}` : "");
    const comuni = state.entries.filter((e) => e.o.conto === "comune");
    const tot = comuni.reduce((s, e) => s + e.o.importo, 0);
    const totOggi = comuni.filter((e) => e.o.data <= today).reduce((s, e) => s + e.o.importo, 0);
    const personal = (k) => `<button type="button" class="card sum ${state.tab === k ? "active" : ""}" data-tab="${k}">
      <span class="t">${esc(cname(k))} · oggi</span><span class="big"${state.hide ? "" : ` data-k="${k}" data-v="${now[k]}"`}>${mEur(now[k])}</span>
      <span class="s">${proj(k) ? proj(k) + " · " : ""}minimo ${mEur(state.min[k])}</span>${sparkHtml(k, today)}</button>`;
    $("#cards").innerHTML = personal("c1") + personal("c2") +
      `<button type="button" class="card sum ${state.tab === "comune" ? "active" : ""}" data-tab="comune">
      <span class="t">Conto comune · uscite finora</span><span class="big" data-k="comune" data-v="${totOggi}">${eur(totOggi)}</span>
      <span class="s">${future ? `previste in tutto ${eur(tot)} · ` : ""}a testa ${eur(totOggi / 2)} · due conti oggi ${mEur(now.c1 + now.c2)}</span>${sparkHtml("comune", today)}</button>`;
    countUp();
  }

  // Mini-grafico del riquadro: tratto pieno fino a oggi, tratteggiato dopo. Con la privacy attiva non si disegna.
  function sparkHtml(k, today) {
    if (state.hide) return "";
    const { cfg, entries } = state;
    const last = entries.length ? entries[entries.length - 1].o.data : today;
    let f;
    if (k === "comune") {
      const com = entries.filter((e) => e.o.conto === "comune");
      f = (d) => com.reduce((s, e) => (e.o.data <= d ? s + e.o.importo : s), 0);
    } else f = (d) => Calc.balanceAt(entries, cfg, d)[k];
    const pts = Calc.monthlySeries(cfg.dataInizio, last > today ? last : today, today, f);
    if (pts.length < 2) return "";
    const W = 100, H = 34, g = Calc.sparkGeometry(pts, W, H, 2, 4);
    const dot = g.today ? `<i class="spark-dot" style="left:${((g.today.x / W) * 100).toFixed(1)}%;top:${((g.today.y / H) * 100).toFixed(1)}%"></i>` : "";
    return `<span class="spark-wrap" aria-hidden="true"><svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      (g.area ? `<path class="sp-area" d="${g.area}"/>` : "") + `<path class="sp-line" pathLength="1" d="${g.past}"/>` +
      (g.fut ? `<path class="sp-fut" d="${g.fut}"/>` : "") + `</svg>${dot}</span>`;
  }

  // I saldi "scorrono" fino al valore. Solo se il browser lo permette e senza "riduci movimento".
  function countUp() {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (state.hide || reduce || typeof requestAnimationFrame !== "function") return;
    document.querySelectorAll("#cards .big[data-v]").forEach((el) => {
      const k = el.dataset.k, to = Number(el.dataset.v), from = state.shown[k] === undefined ? 0 : state.shown[k];
      state.shown[k] = to;
      if (from === to) return;
      const t0 = performance.now(), dur = 750;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = eur(p >= 1 ? to : from + (to - from) * e);
        if (p < 1 && el.isConnected) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
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
      h = `<p class="note">Ogni uscita qui viene divisa a metà e tolta da ${esc(cname("c1"))} e ${esc(cname("c2"))}.</p>
        <table><thead><tr><th>Mese</th><th>Uscite comuni</th><th>${esc(cname("c1"))}</th><th>${esc(cname("c2"))}</th></tr></thead>
        <tbody>${rows}<tr class="tot"><td>Totale</td><td>${eur(t)}</td><td>${eur(a)}</td><td>${eur(b)}</td></tr></tbody></table>`;
    } else {
      const months = groupByMonth(state.entries.filter((e) => e.o.conto === tab || e.o.conto === "comune"));
      const rows = [...months].map(([k, es]) => {
        let ent = 0, usc = 0, com = 0;
        for (const e of es) {
          const v = e.p[tab];
          if (e.o.conto === "comune") com += -v; else if (v > 0) ent += v; else usc += -v;
        }
        return `<tr><td>${fmtMese(k)}</td><td>${mEur(ent)}</td><td>${eur(usc)}</td><td>${eur(com)}</td><td><strong>${mEur(es[es.length - 1].b[tab])}</strong></td></tr>`;
      }).join("");
      h = `<table><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Conto comune</th><th>Saldo fine mese</th></tr></thead>
        <tbody><tr><td>Partenza</td><td colspan="3"></td><td><strong>${mEur(state.cfg[tab].iniziale)}</strong></td></tr>${rows}</tbody></table>`;
    }
    $("#monthly").innerHTML = h;
  }

  function rowHtml(e, tab) {
    const o = e.o, comune = o.conto === "comune";
    let amt, cls, sub;
    if (tab === "comune") {
      amt = -o.importo; cls = "neg";
      sub = `${esc(cname("c1"))} ${eur(-e.p.c1)} · ${esc(cname("c2"))} ${eur(-e.p.c2)}`;
    } else {
      amt = e.p[tab]; cls = amt >= 0 ? "pos" : "neg";
      sub = (comune ? `metà di ${eur(o.importo)}` : "");
    }
    if (e.ann) sub = (sub ? sub + " · " : "") + "annullata";
    else sub = (sub ? sub + " · " : "") + (tab === "comune" ? "" : `saldo ${mEur(e.b[tab])}`);
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
    return `<li class="row tx ${cls === "pos" ? "in" : "out"}${e.ann ? " ann" : ""}"><div class="av" aria-hidden="true">${CAT_ICON[o.categoria] || (cls === "pos" ? "💶" : "🧾")}</div>
      <div class="mn"><div class="v">${esc(o.voce)}</div><div class="tags"><span class="d">${fmtGiorno(o.data)}</span>${tags}</div>${tab === "comune" && sub ? `<div class="sub split">${sub}</div>` : ""}</div>
      <div class="a"><div class="amt ${cls}">${sgnPriv(amt)}</div>${tab !== "comune" && sub ? `<div class="sub">${sub}</div>` : ""}</div>
      <div class="act">${act}</div></li>`;
  }

  function renderList() {
    const tab = state.tab;
    const filter = (e) => (tab === "comune" ? e.o.conto === "comune" : e.o.conto === tab || e.o.conto === "comune");
    let arr = state.entries.filter(filter);
    if (state.showAnn) arr = arr.concat(state.annEntries.filter(filter)).sort((a, b) => Calc.cmp(a.o, b.o));
    const months = groupByMonth(arr);
    let h = tab === "comune" ? "" : `<div class="month"><div class="mhead"><span>Saldo di partenza · ${fmtData(state.cfg.dataInizio)}</span><span>${mEur(state.cfg[tab].iniziale)}</span></div></div>`;
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
      const tot = tab === "comune" ? `uscite ${eur(usc)}` : `entrate ${mEur(ent)} · uscite ${eur(usc)}`;
      const foot = tab === "comune" || !last ? "" : `<div class="mfoot">Saldo fine mese: <strong>${mEur(last.b[tab])}</strong></div>`;
      const open = isOpen(k);
      const saldo = tab === "comune" || !last ? "" : ` · saldo ${mEur(last.b[tab])}`;
      h += `<div class="month"><button type="button" class="mhead" data-month="${k}" aria-expanded="${open}">
          <span><span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span> ${fmtMese(k)}</span><span class="tot">${tot}${open ? "" : saldo}</span></button>
        ${open ? `<ul class="rows">${es.map((e) => rowHtml(e, tab)).join("")}</ul>${foot}` : ""}</div>`;
    }
    $("#list").innerHTML = h;
    updatePinned();
  }

  // L'intestazione del mese resta agganciata in alto mentre scorri. Solo quella agganciata riceve lo sfondo
  // di vetro sfocato (un solo effetto alla volta: più leggero per il telefono).
  let pinTick = false;
  function updatePinned() {
    pinTick = false;
    const heads = [...document.querySelectorAll("#list button.mhead")];
    if (!heads.length || state.view !== "main") return;
    const top = parseFloat(window.getComputedStyle(heads[0]).top);
    const limit = (Number.isFinite(top) ? top : 8) + 1;
    let pinned = null;
    for (const h of heads) { if (h.getBoundingClientRect().top <= limit) pinned = h; else break; }
    heads.forEach((h) => h.classList.toggle("pinned", h === pinned));
  }
  window.addEventListener("scroll", () => {
    if (pinTick) return;
    pinTick = true;
    (window.requestAnimationFrame || ((f) => f()))(updatePinned);
  }, { passive: true });
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
  $("#btn-rules").addEventListener("click", () => go("rules"));
  // barra di navigazione in basso (telefono)
  // Cambio pagina: la vecchia esce sfumando da un lato, la nuova entra dall'altro con una leggera zoomata
  // (la direzione segue l'ordine della barra). Senza animazioni disponibili o con "riduci movimento" il cambio è immediato.
  const VIEW_ORDER = ["main", "cat", "rules", "sim"];
  const viewEl = (v) => $("#" + v + "-view");
  let navTok = 0;
  function markNav(view) {
    const i = VIEW_ORDER.indexOf(view);
    document.querySelectorAll("#bnav button").forEach((b) => b.setAttribute("aria-current", b.dataset.nav === view ? "page" : "false"));
    $("#bnav").style.setProperty("--i", String([0, 1, 3, 4][Math.max(0, i)]));
    // il "+" compie l'azione di creazione della pagina in cui ti trovi
    const add = $("#bnav-add");
    if (add) {
      const label = view === "rules" ? "Nuova ricorrenza" : view === "sim" ? (curScen() ? "Nuova voce dello scenario" : "Nuovo scenario") : "Aggiungi operazione";
      add.setAttribute("aria-label", label); add.title = label;
    }
  }
  $("#bnav-add").addEventListener("click", () => {
    if (state.view === "rules") openRule(null, null);
    else if (state.view === "sim") { if (curScen()) openVoce(null); else openScen(null); }
    else openOp(null);
  });
  function go(view) {
    if (view === state.view) { window.scrollTo(0, 0); return; }
    const dir = VIEW_ORDER.indexOf(view) > VIEW_ORDER.indexOf(state.view) ? "fwd" : "back";
    const apply = () => {
      state.view = view; state.confirmDel = null; state.confirmRule = null; state.simConfirm = null;
      render(); window.scrollTo(0, 0);
      const el = viewEl(view);
      if (el && animOk()) { el.dataset.dir = dir; el.classList.add("vin"); setTimeout(() => el.classList.remove("vin"), 520); }
    };
    document.querySelectorAll(".vout, .vin").forEach((x) => x.classList.remove("vout", "vin"));
    if (!animOk()) { apply(); return; }
    markNav(view);                                  // la capsula di vetro parte subito
    const cur = viewEl(state.view), tok = ++navTok;
    cur.dataset.dir = dir; cur.classList.add("vout");
    setTimeout(() => { if (tok !== navTok) return; cur.classList.remove("vout"); apply(); }, 160);
  }
  function animOk() {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return !reduce && typeof requestAnimationFrame === "function";
  }
  $("#bnav").addEventListener("click", (e) => { const b = e.target.closest("[data-nav]"); if (b) go(b.dataset.nav); });
  $("#btn-sim").addEventListener("click", () => go("sim"));
  $("#sim-back").addEventListener("click", () => go("main"));
  $("#rules-back").addEventListener("click", () => go("main"));
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
      ? `Verrà tolto ${eur(r2(imp / 2))} da ${cname("c1")} e ${eur(r2(imp - r2(imp / 2)))} da ${cname("c2")}.` : "";
  }
  function openOp(op) {
    if (state.hide && isEntrata(op)) { hiddenWarn("le entrate"); return; }
    state.editing = op;
    const { cfg } = state;
    fConto.options[0].textContent = cname("c1"); fConto.options[1].textContent = cname("c2");
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
    if (state.hide) { hiddenWarn("i saldi di partenza"); return; }
    const { cfg } = state;
    $("#s-data").value = cfg.dataInizio; $("#s-n1").value = cname("c1"); $("#s-n2").value = cname("c2");
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
        if (c.mode === "ral") {
          act = `<span class="confirm">Riallineare le operazioni dal mese in corso alla regola? Quelle modificate a mano non si toccano.</span>
            <button type="button" class="btn primary sm" data-ract="yes" data-id="${esc(r.id)}">Sì, riallinea</button>
            <button type="button" class="btn sm" data-ract="cancel">Annulla</button>`;
        } else {
          const lead = c.mode === "del" ? "Eliminare la regola." : "Sospendere la regola.";
          act = `<span class="confirm">${lead} Eliminare anche le operazioni future non modificate?</span>
            <button type="button" class="btn danger sm" data-ract="yes" data-id="${esc(r.id)}">Sì, elimina anche le future</button>
            <button type="button" class="btn sm" data-ract="no" data-id="${esc(r.id)}">No, tienile</button>
            <button type="button" class="btn sm" data-ract="cancel">Annulla</button>`;
        }
      } else {
        act = `<button type="button" class="btn sm" data-ract="edit" data-id="${esc(r.id)}">Modifica</button>
          ${r.attiva ? `<button type="button" class="btn sm" data-ract="ral" data-id="${esc(r.id)}">Riallinea</button>` : ""}
          <button type="button" class="btn sm" data-ract="toggle" data-id="${esc(r.id)}">${r.attiva ? "Sospendi" : "Riattiva"}</button>
          <button type="button" class="btn sm" data-ract="del" data-id="${esc(r.id)}">Elimina</button>`;
      }
      return `<li class="row rule"><div>
        <div class="v">${esc(r.voce)}</div>
        <div class="tags"><span class="tag">${esc(nomeConto(r.conto))}</span>${r.categoria ? `<span class="tag">${esc(r.categoria)}</span>` : ""}
          <span class="tag ${r.attiva ? "on" : "off"}">${r.attiva ? "attiva" : "sospesa"}</span></div>
        <div class="sub">${esc(Calc.freqText(r))} · ${periodo} · ${prossima}</div></div>
        <div class="a"><div class="amt ${sign > 0 ? "pos" : "neg"}">${sgnPriv(sign * r.importo)}</div>${r.conto === "comune" ? `<div class="sub">metà per conto</div>` : ""}</div>
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
    if (act === "ral") { state.confirmRule = { id, mode: "ral" }; renderRules(); return; }
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
        if (mode === "ral") {
          await applyToFuture(rule, rule, true);
          await genera();
          toast("Operazioni riallineate.");
        } else if (mode === "sus") {
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
    if (state.hide && (isEntrata(rule) || isEntrata(fromOp))) { hiddenWarn("le entrate"); return; }
    state.editingRule = rule || null; state.linkOp = fromOp || null; state.ruleDraft = null;
    const { cfg } = state;
    rConto.options[0].textContent = cname("c1"); rConto.options[1].textContent = cname("c2");
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

  // Applica la modifica di una regola alle operazioni già create, dal MESE IN CORSO in poi.
  // Le righe modificate a mano non si toccano. Se cambia il calendario (giorno, frequenza, inizio, fine)
  // la riga di ogni mese viene SPOSTATA alla nuova data dello stesso mese (gli annullamenti la seguono);
  // se in un mese non c'è più una data, la riga futura viene eliminata e quella già passata resta.
  async function applyToFuture(old, nuova, force) {
    const today = localToday(), from = today.slice(0, 7) + "-01";
    const schedule = force || old.ogni_mesi !== nuova.ogni_mesi || old.giorno !== nuova.giorno || old.data_inizio !== nuova.data_inizio ||
      (old.data_fine || null) !== (nuova.data_fine || null);
    const fields = { voce: nuova.voce, conto: nuova.conto, tipo: nuova.tipo, importo: nuova.importo, categoria: nuova.categoria };
    if (!schedule) {
      const { error } = await sb.from("ops").update({ ...fields, updated_at: nowIso() })
        .eq("ricorrenza_id", old.id).gte("data_prevista", from).eq("modificata", false).eq("annullata", false);
      if (error) throw error;
      return;
    }
    const rows = (await fetchAll(() => sb.from("ops").select("*").eq("ricorrenza_id", old.id).gte("data_prevista", from).order("id"))).map(normOp);
    const occ = new Map();
    for (const d of Calc.occurrences(nuova, from, Calc.horizon(nuova, today))) occ.set(d.slice(0, 7), d);
    const taken = new Set(rows.filter((r) => r.modificata).map((r) => r.data_prevista));
    const groups = new Map();
    for (const r of rows) {
      if (r.modificata) continue;
      const mk = r.data_prevista.slice(0, 7);
      if (!groups.has(mk)) groups.set(mk, []);
      groups.get(mk).push(r);
    }
    const del = [], upd = [];
    for (const [mk, g] of groups) {
      const nd = occ.get(mk);
      if (!nd) { g.forEach((r) => { if (r.data_prevista >= today) del.push(r.id); }); continue; }
      if (taken.has(nd)) { g.forEach((r) => del.push(r.id)); continue; } // c'è già una riga modificata a mano a quella data
      const keep = g.find((r) => r.data_prevista === nd) || g[0];
      g.forEach((r) => { if (r !== keep) del.push(r.id); }); // doppioni dello stesso mese
      upd.push({ id: keep.id, patch: { ...fields, data: nd, data_prevista: nd, updated_at: nowIso() } });
    }
    // prima le eliminazioni, così lo spostamento non urta il vincolo (regola, data prevista)
    for (let i = 0; i < del.length; i += 100) {
      const { error } = await sb.from("ops").delete().in("id", del.slice(i, i + 100));
      if (error) throw error;
    }
    for (const u of upd) {
      const { error } = await sb.from("ops").update(u.patch).eq("id", u.id);
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
        <div>Con lo scenario: <strong>${mEur(gr.saldoSim)}</strong> · obiettivo ${eur(gd.minimo)} · ${gr.ok ? "margine" : "mancano"} <strong>${mEur(Math.abs(gr.margine))}</strong></div>
        <div class="sub">Senza scenario: ${mEur(gr.saldoReale)}</div></div>`;
    } else if (g && g.minimo !== "" && g.minimo != null) {
      h += `<div class="card verdict"><div class="sub">Obiettivo incompleto: aggiungi conto, importo e data da «Nome e obiettivo», oppure aggiungi almeno una voce.</div></div>`;
    } else {
      h += `<div class="card verdict"><div class="sub">Nessun obiettivo. Impostalo da «Nome e obiettivo» per avere un verdetto.</div></div>`;
    }

    // grafico dell'andamento
    if (res.rows.length) h += chartCard(res, state.simChart || (res.goalDef ? res.goalDef.conto : "c1"));

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
          <div class="a"><div class="amt ${sign > 0 ? "pos" : "neg"}">${sgnPriv(sign * Number(v.importo))}</div>${v.conto === "comune" ? `<div class="sub">metà per conto</div>` : ""}</div>
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
      const cell = (v, extra) => `<td class="saldo ${state.hide ? "" : (v < 0 ? "neg-cell " : "") + (extra || "")}">${mEur(v)}</td>`;
      const mv = (v) => `<td>${v === 0 ? "—" : sgnPriv(v)}</td>`;
      const spesa = (v) => `<td class="grp">${v === 0 ? "—" : eur(v)}</td>`;
      h += `<div class="sim-h"><h3>Mese per mese</h3></div>
        <section class="card scroll"><table><thead><tr><th rowspan="2">Mese</th>
          <th colspan="3" class="grp">${esc(cname("c1"))}</th><th colspan="3" class="grp">${esc(cname("c2"))}</th></tr>
          <tr><th class="grp">spese</th><th>scenario</th><th class="saldo">saldo</th><th class="grp">spese</th><th>scenario</th><th class="saldo">saldo</th></tr></thead><tbody>` +
        res.rows.map((r) => `<tr class="${goalMonth === r.mese ? "goal-row" : ""}"><td>${fmtMese(r.mese)}</td>
          ${spesa(r.spese.c1)}${mv(r.voci.c1)}${cell(r.sim.c1, low("c1", r) ? "low-cell" : "")}
          ${spesa(r.spese.c2)}${mv(r.voci.c2)}${cell(r.sim.c2, low("c2", r) ? "low-cell" : "")}</tr>`).join("") +
        `</tbody></table></section>
        <p class="note">Per ogni mese: «spese» = uscite già registrate, «scenario» = effetto delle voci simulate, «saldo» = fine mese con lo scenario.<br>Punto più basso con lo scenario: ${esc(cname("c1"))} <strong>${mEur(res.minSim.c1.v)}</strong> (${fmtData(res.minSim.c1.d)}) · ${esc(cname("c2"))} <strong>${mEur(res.minSim.c2.v)}</strong> (${fmtData(res.minSim.c2.d)}).
        Il calcolo arriva fino a ${fmtData(res.endDate)} e conta solo quello che è registrato: stipendi e spese non ancora inseriti non sono inclusi.</p>`;
    }
    body.innerHTML = h;
  }

  const kfmt = (v) => { const a = Math.abs(v); const s = a >= 1000 ? String(r2(a / 1000)).replace(".", ",") + "k" : String(Math.round(a)); return (v < 0 ? "−" : "") + s; };
  function chartCard(res, conto) {
    if (state.hide) return `<div class="card chart-card"><div class="sub">Grafico nascosto: la modalità privacy è attiva.</div></div>`;
    const rows = res.rows;
    if (rows.length < 2) return "";
    const pills = [["c1", "Conto 1"], ["c2", "Conto 2"], ["tot", "Insieme"]]
      .map(([k, l]) => `<button type="button" class="seg-b" data-sact="chart" data-k="${k}" aria-pressed="${k === conto}">${l}</button>`).join("");
    const W = Math.max(280, Math.round(($("#sim-body").clientWidth || 640) - 30)), H = 230, L = 44, R = 12, T = 14, B = 26;
    const pv = (b) => (conto === "tot" ? r2(b.c1 + b.c2) : b[conto]);
    const dates = rows.map((r) => Calc.monthEndPlus(`${r.mese}-01`, 0));
    const real = rows.map((r) => pv(r.real)), sim = rows.map((r) => pv(r.sim));
    const gd = res.goalDef && res.goalDef.conto === conto ? res.goalDef : null;
    const vals = real.concat(sim, gd ? [gd.minimo] : []);
    const tk = Calc.niceTicks(Math.min(...vals), Math.max(...vals), 4);
    const x0 = Calc.dayNum(dates[0]), x1 = Calc.dayNum(dates[dates.length - 1]);
    const X = (d) => L + ((Calc.dayNum(d) - x0) / ((x1 - x0) || 1)) * (W - L - R);
    const Y = (v) => T + (1 - (v - tk.min) / ((tk.max - tk.min) || 1)) * (H - T - B);
    const line = (vs) => vs.map((v, i) => `${i ? "L" : "M"}${X(dates[i]).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    const xs = dates.map((d) => X(d)), ysSim = sim.map((v) => Y(v)), ysReal = real.map((v) => Y(v));
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento del saldo: reale e con scenario">`;
    for (const v of tk.ticks) s += `<line class="ch-grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ch-t" x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${kfmt(v)}</text>`;
    const every = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach((d, i) => { if (i % every === 0) s += `<text class="ch-t" x="${xs[i].toFixed(1)}" y="${H - 8}" text-anchor="middle">${mesiCorti[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}</text>`; });
    s += `<path class="ch-area" d="${line(sim)} L${xs[xs.length - 1].toFixed(1)} ${Y(tk.min).toFixed(1)} L${xs[0].toFixed(1)} ${Y(tk.min).toFixed(1)} Z"/>`;
    const today = localToday();
    if (today >= dates[0] && today <= dates[dates.length - 1]) s += `<line class="ch-today" x1="${X(today).toFixed(1)}" x2="${X(today).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
    if (gd) {
      s += `<line class="ch-goal" x1="${L}" x2="${W - R}" y1="${Y(gd.minimo).toFixed(1)}" y2="${Y(gd.minimo).toFixed(1)}"/><text class="ch-goal-t" x="${W - R - 2}" y="${(Y(gd.minimo) - 5).toFixed(1)}" text-anchor="end">obiettivo</text>`;
      if (gd.data >= dates[0] && gd.data <= dates[dates.length - 1]) s += `<line class="ch-goalv" x1="${X(gd.data).toFixed(1)}" x2="${X(gd.data).toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
    }
    s += `<path class="ch-real" d="${line(real)}"/><path class="ch-sim" d="${line(sim)}"/>`;
    const mi = sim.indexOf(Math.min(...sim));
    s += `<circle class="ch-min" cx="${xs[mi].toFixed(1)}" cy="${ysSim[mi].toFixed(1)}" r="4.5"/>`;
    s += `<line class="ch-cur" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><circle class="ch-d2" r="4" style="display:none"/><circle class="ch-d1" r="4.5" style="display:none"/>`;
    s += `<rect class="ch-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></svg>`;
    state.chartData = { W, xs, ysSim, ysReal, real, sim, mesi: rows.map((r) => r.mese) };
    return `<div class="card chart-card"><div class="seg" role="group" aria-label="Conto del grafico">${pills}</div>${s}
      <div class="ch-leg"><span class="k real">Reale</span><span class="k">Con scenario</span>${gd ? `<span class="k goal">Obiettivo</span>` : ""}<span class="k today">Oggi</span></div>
      <div class="ch-read" id="ch-read">Passa sul grafico (o toccalo) per vedere i valori di ogni mese.</div></div>`;
  }
  // il cursore segue il dito/mouse e mostra i valori del mese più vicino
  function chartMove(e) {
    const hit = e.target.closest && e.target.closest(".ch-hit"), cd = state.chartData;
    if (!hit || !cd) return;
    const svg = hit.closest("svg"), rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((e.clientX - rect.left) * cd.W) / rect.width;
    let bi = 0, bd = Infinity;
    cd.xs.forEach((x, i) => { const d = Math.abs(x - px); if (d < bd) { bd = d; bi = i; } });
    const cur = svg.querySelector(".ch-cur"), d1 = svg.querySelector(".ch-d1"), d2 = svg.querySelector(".ch-d2");
    cur.setAttribute("x1", cd.xs[bi]); cur.setAttribute("x2", cd.xs[bi]); cur.style.display = "";
    d1.setAttribute("cx", cd.xs[bi]); d1.setAttribute("cy", cd.ysSim[bi]); d1.style.display = "";
    d2.setAttribute("cx", cd.xs[bi]); d2.setAttribute("cy", cd.ysReal[bi]); d2.style.display = "";
    $("#ch-read").innerHTML = `<strong>${fmtMese(cd.mesi[bi])}</strong> · reale ${eur(cd.real[bi])} · con scenario <strong>${eur(cd.sim[bi])}</strong>`;
  }
  $("#sim-body").addEventListener("pointermove", chartMove);
  $("#sim-body").addEventListener("pointerdown", chartMove);
  let rzT; window.addEventListener("resize", () => { clearTimeout(rzT); rzT = setTimeout(() => { if (state.view === "sim") renderSim(); }, 200); });

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
    if (a === "chart") { state.simChart = b.dataset.k; renderSim(); return; }
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
    scConto.options[0].textContent = cname("c1"); scConto.options[1].textContent = cname("c2");
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
      if (v.conto === "comune") txt = `Divisa: ${eur(r2(imp / 2))} su ${cname("c1")} e ${eur(r2(imp - r2(imp / 2)))} su ${cname("c2")}. `;
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
    if (state.hide && isEntrata(v)) { hiddenWarn("le entrate"); return; }
    editingVoce = v || null;
    vConto.options[0].textContent = cname("c1"); vConto.options[1].textContent = cname("c2");
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

  // ---------- spese per categoria ----------
  const catColor = (name) => { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 62% 52%)`; };
  $("#btn-cat").addEventListener("click", () => go("cat"));
  $("#cat-back").addEventListener("click", () => go("main"));
  $("#cat-conto").addEventListener("change", (e) => { state.catConto = e.target.value; renderCat(); });
  $("#cat-per").addEventListener("change", (e) => { state.catPer = e.target.value; renderCat(); });

  function renderCat() {
    const { cfg } = state, today = localToday(), tm = today.slice(0, 7);
    const sel = $("#cat-conto");
    sel.options[0].textContent = `${cname("c1")} + ${cname("c2")}`; sel.options[1].textContent = cname("c1"); sel.options[2].textContent = cname("c2");
    sel.value = state.catConto;
    // periodi: tutto il periodo + ogni mese con operazioni
    const keys = [...new Set(state.entries.map((e) => e.o.data.slice(0, 7)))].sort();
    if (state.catPer !== "all" && !keys.includes(state.catPer)) state.catPer = keys.includes(tm) ? tm : (keys.find((k) => k > tm) || keys[keys.length - 1] || "all");
    $("#cat-per").innerHTML = `<option value="all">Tutto il periodo</option>` +
      keys.map((k) => `<option value="${k}">${fmtMese(k)}${k > tm ? " (previsto)" : ""}</option>`).join("");
    $("#cat-per").value = state.catPer;

    $("#cat-body").innerHTML = catBlock(state.catConto, state.catPer, tm);
  }

  // Riepilogo delle uscite per categoria (HTML) per un conto ("c1" | "c2" | "tot") e un periodo ("all" o "YYYY-MM")
  function catBlock(conto, per, tm) {
    const range = per === "all" ? ["0000-01-01", "9999-12-31"] : [`${per}-01`, `${per}-31`];
    const cur = Calc.categorySummary(state.entries, conto, range[0], range[1]);
    let prev = null, prevKey = null;
    if (per !== "all") {
      prevKey = Calc.monthEndPlus(`${per}-01`, -1).slice(0, 7);
      prev = Calc.categorySummary(state.entries, conto, `${prevKey}-01`, `${prevKey}-31`);
    }
    if (!cur.rows.length) return `<p class="empty">Nessuna spesa nel periodo.</p>`;
    const prevMap = prev ? new Map(prev.rows.map((r) => [r.cat, r.tot])) : null;
    const dTot = prev && prev.uscite > 0 ? r2(cur.uscite - prev.uscite) : null;
    const saldo = r2(cur.entrate - cur.uscite);
    let h = `<div class="card cat-sum"><div class="lbl">Uscite${per !== "all" && per > tm ? " previste" : ""} · ${per === "all" ? "tutto il periodo" : fmtMese(per)}</div>
      <div class="big">${eur(cur.uscite)}</div>
      <div class="line"><span>Entrate <strong>${mEur(cur.entrate)}</strong></span><span>Differenza <strong>${state.hide ? MASK : sgn(saldo)}</strong></span>
      ${dTot !== null ? `<span>${dTot > 0 ? "▲" : dTot < 0 ? "▼" : "="} <strong>${eur(Math.abs(dTot))}</strong> rispetto a ${fmtMese(prevKey)}</span>` : ""}</div></div>
      <div class="card" style="padding:6px 12px">`;
    h += cur.rows.map((r) => {
      const share = cur.uscite > 0 ? (r.tot / cur.uscite) * 100 : 0;
      let delta = "";
      if (prevMap) {
        const before = prevMap.get(r.cat) || 0, d = r2(r.tot - before);
        if (prevMap.has(r.cat) && d !== 0) delta = `<small class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${eur(Math.abs(d))}</small>`;
        else if (!prevMap.has(r.cat)) delta = `<small>nuova</small>`;
      }
      return `<div class="catrow"><div class="top2"><div class="av2" aria-hidden="true">${CAT_ICON[r.cat] || "🏷️"}</div>
        <div class="nm">${esc(r.cat)}<small>${r.n} ${r.n === 1 ? "operazione" : "operazioni"} · ${share.toFixed(share < 10 ? 1 : 0).replace(".", ",")}%</small></div>
        <div class="vl">${eur(r.tot)}${delta}</div></div>
        <div class="bar" role="img" aria-label="${esc(r.cat)}: ${share.toFixed(0)}% delle uscite"><i style="width:${Math.max(share, 1.5).toFixed(1)}%;background:${catColor(r.cat)}"></i></div></div>`;
    }).join("");
    return h + `</div><p class="note" style="margin-top:10px">Le uscite comuni contano per la quota di ciascun conto (metà). Le operazioni annullate sono escluse.</p>`;
  }

  // Pannello laterale (schermi larghi): le categorie del conto della scheda aperta
  function renderCatPanel() {
    if (!$("#cat-panel")) return;
    const tm = localToday().slice(0, 7), conto = state.tab === "comune" ? "tot" : state.tab;
    const keys = [...new Set(state.entries.map((e) => e.o.data.slice(0, 7)))].sort();
    if (state.panelPer !== "all" && !keys.includes(state.panelPer)) state.panelPer = keys.includes(tm) ? tm : (keys.find((k) => k > tm) || keys[keys.length - 1] || "all");
    $("#cp-per").innerHTML = `<option value="all">Tutto il periodo</option>` + keys.map((k) => `<option value="${k}">${fmtMese(k)}${k > tm ? " (previsto)" : ""}</option>`).join("");
    $("#cp-per").value = state.panelPer;
    $("#cp-conto").textContent = conto === "tot" ? `${cname("c1")} + ${cname("c2")}` : cname(conto);
    $("#cp-body").innerHTML = catBlock(conto, state.panelPer, tm);
  }
  $("#cp-per").addEventListener("change", (e) => { state.panelPer = e.target.value; renderCatPanel(); });
  $("#cp-open").addEventListener("click", () => { state.catConto = state.tab === "comune" ? "tot" : state.tab; state.catPer = state.panelPer; go("cat"); });

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
