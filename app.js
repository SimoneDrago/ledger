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
  const fmtData = (d) => (/^\d{4}-\d\d-\d\d/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
  const pad = (n) => String(n).padStart(2, "0");
  // Data di oggi nel fuso locale, come stringa YYYY-MM-DD (niente toISOString: sarebbe UTC)
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const CAT_ICON = { Stipendio: "💼", Auto: "🚗", "Università": "🎓", Abbonamenti: "📺", Telefono: "📱", Spesa: "🛒", Varie: "✨", "Acquisto casa": "🏠", Casa: "🛋️", Lavori: "🔨", Utenze: "💡", Altro: "📌", Rettifica: "⚖️" };
  const catIcon = (c, fallback) => (Object.prototype.hasOwnProperty.call(CAT_ICON, c) ? CAT_ICON[c] : fallback);
  const BASE_CAT = ["Stipendio", "Auto", "Università", "Abbonamenti", "Telefono", "Spesa", "Varie", "Acquisto casa", "Casa", "Lavori", "Utenze", "Altro"];
  const DEFAULT_CFG = { c1: { nome: "Conto 1", iniziale: 0 }, c2: { nome: "Conto 2", iniziale: 0 }, dataInizio: localToday() };
  const QUICK_FREQ = ["1", "2", "3", "6", "12"];

  const state = {
    cfg: DEFAULT_CFG, ops: [], rules: [], scenari: [], scenId: null, hide: false, riconc: { c1: [], c2: [] }, budget: Calc.emptyBudget(), bud: { mese: null, conto: "c1" }, bmConfirm: null, editingBusta: null, editingFondo: null, copri: null, buDel: false, foDel: false, simChart: null, simMese: null, simSeg: null, chartData: null, shown: {}, panelPer: null, simConfirm: null, tab: "c1", view: "main", showAnn: false,
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
    const [c, sc, rc, bd, ops, rules] = await Promise.all([
      sb.from("config").select("dati").eq("id", "conti").maybeSingle(),
      sb.from("config").select("dati").eq("id", "scenari").maybeSingle(),
      sb.from("config").select("dati").eq("id", "riconciliazioni").maybeSingle(),
      sb.from("config").select("dati").eq("id", "budget").maybeSingle(),
      fetchAll(() => sb.from("ops").select("*").order("id")),
      fetchAll(() => sb.from("ricorrenze").select("*").order("id")),
    ]);
    if (c.error) throw c.error;
    if (sc.error) throw sc.error;
    // le verifiche sono un di più: se la riga non si legge, l'app funziona lo stesso
    const rd = !rc.error && rc.data && rc.data.dati ? rc.data.dati : {};
    state.riconc = { c1: Array.isArray(rd.c1) ? rd.c1 : [], c2: Array.isArray(rd.c2) ? rd.c2 : [] };
    state.budget = Calc.normBudget(!bd.error && bd.data ? bd.data.dati : null);
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
    $("#bud-view").hidden = state.view !== "bud";
    if (state.view === "bud") { renderBud(); return; }
    if (state.view === "rules") { renderRules(); return; }
    if (state.view === "sim") { renderSim(); return; }
    renderCards(); renderMonthly(); renderList(); renderCatPanel();
  }

  // Saldo a fine mese di un conto: quello reale, calcolato per data (operazioni registrate fino all'ultimo giorno del mese).
  const saldoFine = (k, mese) => Calc.balanceAt(state.entries, state.cfg, Calc.monthEndPlus(`${mese}-01`, 0))[k];
  // Con le buste ogni mese, da oggi per i prossimi dodici (o fino all'ultimo con operazioni), mostra le sue buste anche se
  // non ha ancora operazioni.
  function withBudgetMonths(months) {
    if (!state.budget.buste.length) return months;
    const tm = localToday().slice(0, 7), last = months.size ? [...months.keys()].pop() : tm, to12 = Calc.monthEndPlus(`${tm}-01`, 11).slice(0, 7);
    const end = last > to12 ? last : to12, out = new Map(months);
    for (let m = tm, n = 0; m <= end && n < 240; m = Calc.monthEndPlus(`${m}-01`, 1).slice(0, 7), n++) if (!out.has(m)) out.set(m, []);
    return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
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
      <span class="s">${proj(k) ? proj(k) + " · " : ""}minimo ${mEur(state.min[k])}</span>${vfHtml(k, today)}${sparkHtml(k, today)}</button>`;
    $("#cards").innerHTML = personal("c1") + personal("c2") +
      `<button type="button" class="card sum ${state.tab === "comune" ? "active" : ""}" data-tab="comune">
      <span class="t">Conto comune · uscite finora</span><span class="big" data-k="comune" data-v="${totOggi}">${eur(totOggi)}</span>
      <span class="s">${future ? `previste in tutto ${eur(tot)} · ` : ""}a testa ${eur(totOggi / 2)} · due conti oggi ${mEur(now.c1 + now.c2)}</span>${sparkHtml("comune", today)}</button>`;
    countUp();
  }

  // Quando il saldo calcolato è stato confrontato per l'ultima volta con quello della banca (nessuna cifra mostrata).
  function vfHtml(k, today) {
    const v = Calc.verifyStatus(state.riconc[k], today);
    if (!v) return `<span class="vf none">⚖️ saldo non ancora verificato</span>`;
    const when = v.days === 0 ? "oggi" : v.days === 1 ? "ieri" : `${v.days} giorni fa`;
    return `<span class="vf ${v.stale ? "old" : "ok"}">${v.aperta ? "⚠ non allineato" : v.stale ? "⚠ verificato" : "✓ verificato"} ${when}</span>`;
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
      const months = withBudgetMonths(groupByMonth(state.entries.filter((e) => e.o.conto === tab || e.o.conto === "comune")));
      const rows = [...months].map(([k, es]) => {
        let ent = 0, usc = 0, com = 0;
        for (const e of es) {
          const v = e.p[tab];
          if (e.o.conto === "comune") com += -v; else if (v > 0) ent += v; else usc += -v;
        }
        return `<tr><td>${fmtMese(k)}</td><td>${mEur(ent)}</td><td>${eur(usc)}</td><td>${eur(com)}</td><td><strong>${mEur(saldoFine(tab, k))}</strong></td></tr>`;
      }).join("");
      h = `<table><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Conto comune</th><th>Saldo fine mese</th></tr></thead>
        <tbody><tr><td>Partenza</td><td colspan="3"></td><td><strong>${mEur(state.cfg[tab].iniziale)}</strong></td></tr>${rows}</tbody></table>`;
    }
    $("#monthly").innerHTML = h;
  }

  // Le buste dentro ogni mese della sezione Conti: lo stipendio (entrate del mese), le spese che lo riducono, il budget di
  // ogni busta e, per l'accumulo, il fondo accumulato fino al mese prima più il budget assegnato in questo mese.
  function monthBuste(tab, k) {
    const bud = state.budget;
    if (!bud.buste.length) return "";
    const hide = state.hide, M = (v) => (hide ? MASK : eur(v)), personal = tab !== "comune";
    const mine = (b) => (personal ? b.conto === tab || b.conto === "comune" : b.conto === "comune");
    const plan = Calc.monthPlan(bud, state.ops, k, personal ? tab : "tot");
    const righe = plan.righe.filter((r) => mine(r.busta));
    const rimosse = bud.buste.filter((b) => mine(b) && (b.escluse || []).includes(k));
    if (!righe.length && !rimosse.length) return "";
    let usc = 0;
    if (personal) for (const e of state.entries) if (e.o.data.slice(0, 7) === k && e.p[tab] < 0) usc = r2(usc - e.p[tab]);
    let h = `<div class="mbuste">`;
    if (personal) {
      const neg = plan.daAssegnare < 0 && !hide;
      h += `<div class="mb-sum"><div><span>Stipendio</span><strong>${plan.entrate > 0 ? M(plan.entrate) : "—"}</strong></div>
        <div><span>Speso</span><strong>${eur(usc)}</strong></div>
        <div><span>Rimasto dallo stipendio</span><strong>${plan.entrate > 0 ? M(r2(plan.entrate - usc)) : "—"}</strong></div>
        <div><span>Assegnato alle buste</span><strong>${M(plan.assegnato)}</strong></div>
        <div class="${neg ? "neg" : ""}"><span>Da assegnare</span><strong>${plan.entrate > 0 ? M(plan.daAssegnare) : "—"}</strong></div></div>`;
    }
    h += righe.map((r) => {
      const b = r.busta, conf = state.bmConfirm === `${b.id}|${k}`;
      const tag = b.conto === "comune" && personal ? ` <small>· Conto comune, metà ciascuno</small>` : "";
      const fondo = b.fondo ? bud.fondi.find((f) => f.id === b.fondo) : null;
      const rem = conf
        ? `<span class="confirm">Togliere dal mese?</span><button type="button" class="btn danger sm" data-bm="remok" data-id="${esc(b.id)}" data-month="${k}">Sì</button><button type="button" class="btn sm" data-bm="no">No</button>`
        : `<button type="button" class="btn sm" data-bm="edit" data-id="${esc(b.id)}" data-month="${k}">Modifica</button><button type="button" class="btn sm" data-bm="rem" data-id="${esc(b.id)}" data-month="${k}">Rimuovi dal mese</button>`;
      if (b.tipo === "accumulo") {
        const s = fondo ? Calc.fondoSaldo(bud, fondo, state.ops, `${k}-01`) : null;
        return `<div class="mb-row acc"><div class="mb-top"><span class="mb-nm">${esc(b.nome)}<small>Accumulo${fondo ? ` → ${esc(fondo.nome)}` : ""}</small></span><span class="mb-v"><strong>${M(r.budget)}</strong><small>budget del mese</small></span></div>
          ${s ? `<p class="mb-fondo">Fondo accumulato fino al mese scorso: <strong>${M(s.saldo)}</strong> · questo mese assegni <strong>${M(r.budget)}</strong></p>` : ""}
          <div class="mb-act">${rem}</div></div>`;
      }
      const pct = r.budget > 0 ? Math.min(100, (r.speso / r.budget) * 100) : r.speso > 0 ? 100 : 0;
      const foot = r.stato === "over"
        ? `<p class="mb-foot over">⚠ Superi il budget di ${eur(r.over)}: prendi budget da un'altra busta. <button type="button" class="btn sm danger" data-bm="copri" data-id="${esc(b.id)}" data-month="${k}">Copri</button></p>`
        : `<p class="mb-foot">${r.stato === "warn" ? "Quasi finito · " : ""}restano ${eur(r.residuo)}</p>`;
      return `<div class="mb-row st-${r.stato}"><div class="mb-top"><span class="mb-nm">${esc(b.nome)}${tag}<small>Spesa</small></span><span class="mb-v"><strong>${eur(r.speso)}</strong><small>su ${eur(r.budget)}</small></span></div>
        <div class="bar" role="img" aria-label="${esc(b.nome)}: speso ${eur(r.speso)} su ${eur(r.budget)}"><i style="width:${pct.toFixed(1)}%"></i></div>${foot}<div class="mb-act">${rem}</div></div>`;
    }).join("");
    if (rimosse.length) h += `<p class="mb-rim">Tolte da questo mese: ${rimosse.map((b) => `${esc(b.nome)} <button type="button" class="btn link sm" data-bm="res" data-id="${esc(b.id)}" data-month="${k}">Rimetti</button>`).join(" · ")}</p>`;
    return h + `</div>`;
  }
  async function monthBustaAction(a, id, k) {
    const b = state.budget.buste.find((x) => x.id === id);
    if (a === "no") { state.bmConfirm = null; renderList(); return; }
    if (a === "rem") {
      if (state.hide) { hiddenWarn("le buste"); return; }
      if (b && b.tipo === "spesa" && Calc.bustaSpeso(state.ops, b, k) > 0) { toast("In questa busta ci sono spese registrate in questo mese: assegnale a un'altra busta prima di toglierla."); return; }
      state.bmConfirm = `${id}|${k}`; renderList(); return;
    }
    if (a === "remok" || a === "res") {
      if (state.hide) { hiddenWarn("le buste"); return; }
      state.bmConfirm = null;
      const ok = await saveBudget((d) => {
        const x = d.buste.find((y) => y.id === id); if (!x) return;
        const set = new Set(x.escluse || []);
        if (a === "remok") { set.add(k); d.spostamenti = d.spostamenti.filter((s) => !(s.mese === k && (s.da === id || s.a === id))); } else set.delete(k);
        x.escluse = [...set].sort();
      }, a === "remok" ? "Busta tolta da questo mese." : "Busta rimessa nel mese.");
      if (ok) render();
      return;
    }
    state.bud.mese = k;
    if (a === "edit") openBusta(b);
    else if (a === "copri") openCopri(id);
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
    return `<li class="row tx ${cls === "pos" ? "in" : "out"}${e.ann ? " ann" : ""}"><div class="av" aria-hidden="true">${catIcon(o.categoria, cls === "pos" ? "💶" : "🧾")}</div>
      <div class="mn"><div class="v">${esc(o.voce)}</div><div class="tags"><span class="d">${fmtGiorno(o.data)}</span>${tags}</div>${tab === "comune" && sub ? `<div class="sub split">${sub}</div>` : ""}</div>
      <div class="a"><div class="amt ${cls}">${sgnPriv(amt)}</div>${tab !== "comune" && sub ? `<div class="sub">${sub}</div>` : ""}</div>
      <div class="act">${act}</div></li>`;
  }

  function renderList() {
    const tab = state.tab;
    const filter = (e) => (tab === "comune" ? e.o.conto === "comune" : e.o.conto === tab || e.o.conto === "comune");
    let arr = state.entries.filter(filter);
    if (state.showAnn) arr = arr.concat(state.annEntries.filter(filter)).sort((a, b) => Calc.cmp(a.o, b.o));
    const months = withBudgetMonths(groupByMonth(arr));
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
      const sf = tab === "comune" ? null : saldoFine(tab, k);
      const foot = sf === null ? "" : `<div class="mfoot">Saldo fine mese: <strong>${mEur(sf)}</strong></div>`;
      const open = isOpen(k);
      const saldo = sf === null ? "" : ` · saldo ${mEur(sf)}`;
      h += `<div class="month"><button type="button" class="mhead" data-month="${k}" aria-expanded="${open}">
          <span><span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span> ${fmtMese(k)}</span><span class="tot">${tot}${open ? "" : saldo}</span></button>
        ${open ? `${monthBuste(tab, k)}<ul class="rows">${es.map((e) => rowHtml(e, tab)).join("")}</ul>${foot}` : ""}</div>`;
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
  const VIEW_ORDER = ["main", "bud", "rules", "sim"];
  const NAVPOS = { main: 0, bud: 1, rules: 3, sim: 4 };
  const viewEl = (v) => $("#" + v + "-view");
  let navTok = 0;
  function markNav(view) {
    document.querySelectorAll("#bnav button").forEach((b) => b.setAttribute("aria-current", b.dataset.nav === view ? "page" : "false"));
    $("#bnav").style.setProperty("--i", String(NAVPOS[view] ?? 0));
    // il "+" compie l'azione di creazione della pagina in cui ti trovi
    const add = $("#bnav-add");
    if (add) {
      const label = view === "rules" ? "Nuova ricorrenza" : view === "bud" ? "Nuova busta" : view === "sim" ? (curScen() ? "Nuova voce dello scenario" : "Nuovo scenario") : "Aggiungi operazione";
      add.setAttribute("aria-label", label); add.title = label;
    }
  }
  $("#bnav-add").addEventListener("click", () => {
    if (state.view === "rules") openRule(null, null);
    else if (state.view === "bud") openBusta(null);
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
  $("#btn-bud").addEventListener("click", () => go("bud"));
  $("#bud-back").addEventListener("click", () => go("main"));
  $("#sim-back").addEventListener("click", () => go("main"));
  $("#rules-back").addEventListener("click", () => go("main"));
  $("#chk-ann").addEventListener("change", (e) => { state.showAnn = e.target.checked; renderList(); });

  $("#list").addEventListener("click", async (e) => {
    const bm = e.target.closest("[data-bm]");
    if (bm) { monthBustaAction(bm.dataset.bm, bm.dataset.id, bm.dataset.month); return; }
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
  const fConto = $("#f-conto"), fBusta = $("#f-busta");
  function fillCats(listId) {
    const cats = [...new Set([...BASE_CAT, ...state.ops.map((o) => o.categoria).filter(Boolean), ...state.rules.map((r) => r.categoria).filter(Boolean)])];
    $(listId).innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");
  }
  // Buste di spesa tra cui scegliere: stesso conto, attive nel mese della data (più quella già scelta, se c'è).
  const bustaChoices = (conto, data, keepId) => {
    const mese = String(data || "").slice(0, 7);
    return state.budget.buste.filter((b) => b.tipo === "spesa" && b.conto === conto && (b.id === keepId || (mese.length === 7 && Calc.bustaAttiva(b, mese))));
  };
  function refreshBusta() {
    const conto = fConto.value, uscita = conto === "comune" || $("#f-tipo").value === "uscita", ed = state.editing;
    const any = state.budget.buste.length > 0, warn = $("#f-busta-warn");
    $("#f-busta-wrap").hidden = !(uscita && (any || (ed && ed.busta_id)));
    warn.textContent = ""; warn.classList.remove("warn");
    if ($("#f-busta-wrap").hidden) { fBusta.value = ""; return; }
    const list = bustaChoices(conto, $("#f-data").value, ed && ed.busta_id), pick = fBusta.dataset.pick || "";
    const legacy = !!ed && !ed.busta_id;
    fBusta.innerHTML = `<option value="">${list.length ? (legacy ? "Senza busta (storico)" : "Scegli la busta…") : "Nessuna busta di spesa per questo conto"}</option>` +
      list.map((b) => `<option value="${esc(b.id)}">${esc(b.nome)}</option>`).join("");
    fBusta.value = list.some((b) => b.id === pick) ? pick : "";
    const imp = parseImporto($("#f-importo").value), mese = $("#f-data").value.slice(0, 7);
    if (fBusta.value && imp > 0) {
      const ck = Calc.checkSpesa(state.budget, state.ops, fBusta.value, mese, imp, ed ? ed.id : null);
      const b = state.budget.buste.find((x) => x.id === fBusta.value);
      if (ck.over > 0) { warn.textContent = `⚠ Supera il budget di «${b.nome}» di ${eur(ck.over)} (${eur(ck.speso)} su ${eur(ck.budget)}). Dopo averla salvata copri la differenza prendendo budget da un'altra busta.`; warn.classList.add("warn"); }
      else warn.textContent = `Dopo questa spesa restano ${eur(r2(ck.budget - ck.speso))} nella busta.`;
    }
  }
  fBusta.addEventListener("change", () => { fBusta.dataset.pick = fBusta.value; refreshBusta(); });
  $("#f-tipo").addEventListener("change", updateOpUi);
  $("#f-data").addEventListener("change", updateOpUi);
  $("#f-data").addEventListener("input", updateOpUi);
  function updateOpUi() {
    const comune = fConto.value === "comune";
    $("#f-tipo-wrap").hidden = comune;
    refreshBusta();
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
    fBusta.dataset.pick = op && op.busta_id ? op.busta_id : "";
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
    const uscita = conto === "comune" || $("#f-tipo").value === "uscita";
    const busta = uscita ? fBusta.value || null : null;
    // con almeno una busta creata, ogni nuova uscita ne ha una (le vecchie operazioni senza busta possono restare così)
    if (uscita && state.budget.buste.length > 0 && !busta && !(op && !op.busta_id)) {
      return { err: bustaChoices(conto, data, null).length ? "Scegli la busta della spesa." : "Per questo conto non c'è ancora una busta di spesa: creala dalla sezione Buste." };
    }
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
        ...(busta ? { busta_id: busta } : op && op.busta_id ? { busta_id: null } : {}),
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

  // ---------- riconciliazione col saldo della banca ----------
  // La rettifica è una normale operazione (categoria «Rettifica») alla data scelta; lo storico delle verifiche sta
  // nella tabella `config` (riga id = 'riconciliazioni'): nessuna tabella nuova.
  async function saveRiconc(conto, rec) {
    const r = await sb.from("config").select("dati").eq("id", "riconciliazioni").maybeSingle();
    if (r.error) throw r.error;
    const dati = { ...(r.data ? r.data.dati : {}) };
    const list = (Array.isArray(dati[conto]) ? dati[conto] : []).concat([rec]).slice(-24);
    dati[conto] = list;
    const w = await sb.from("config").upsert({ id: "riconciliazioni", dati, updated_at: nowIso() });
    if (w.error) throw w.error;
    state.riconc = { c1: Array.isArray(dati.c1) ? dati.c1 : [], c2: Array.isArray(dati.c2) ? dati.c2 : [] };
  }
  const recState = { calc: null };
  function openRec() {
    if (state.hide) { hiddenWarn("la riconciliazione"); return; }
    const sel = $("#rc-conto");
    sel.options[0].textContent = cname("c1"); sel.options[1].textContent = cname("c2");
    sel.value = state.tab === "c2" ? "c2" : "c1";
    const today = localToday();
    $("#rc-data").value = today; $("#rc-data").max = today;
    $("#rc-banca").value = ""; $("#rc-msg").textContent = "";
    recState.calc = null; recRefresh();
    $("#dlg-rec").showModal();
  }
  function recParse() {
    const raw = $("#rc-banca").value, neg = /^\s*-/.test(raw), n = parseImporto(raw.replace(/^\s*-/, ""));
    return Number.isNaN(n) || raw.trim() === "" ? NaN : neg ? -n : n;
  }
  // Ricalcola il confronto ogni volta che cambiano conto, data o saldo scritto.
  function recRefresh() {
    const conto = $("#rc-conto").value, data = $("#rc-data").value, banca = recParse();
    const box = $("#rc-box"), save = $("#rc-save"), chk = $("#rc-check");
    // storico del conto scelto
    const hist = state.riconc[conto].slice(-3).reverse();
    const hb = $("#rc-hist");
    hb.hidden = !hist.length;
    hb.innerHTML = hist.length ? `<strong>Ultime verifiche</strong>` + hist.map((x) => `<div><span>${fmtData(x.data)}</span><span>${x.diff === 0 ? "coincideva" : x.rettifica ? `rettificato ${sgn(x.diff)}` : `differenza ${sgn(x.diff)} non registrata`}</span></div>`).join("") : "";
    const ok = Number.isFinite(banca) && /^\d{4}-\d\d-\d\d$/.test(data) && data <= localToday();
    if (!ok) {
      recState.calc = null; box.hidden = true; chk.hidden = true; save.disabled = true; save.textContent = "Confronta";
      return;
    }
    const c = Calc.reconcile(state.entries, state.cfg, conto, data, banca);
    recState.calc = { ...c, conto, data, banca };
    box.hidden = false;
    const d = c.diff;
    box.className = "rec-box " + (d === 0 ? "ok" : "diff");
    box.innerHTML = `<div class="rb-l"><span>Calcolato dall'app</span><strong>${eur(c.calcolato)}</strong></div>
      <div class="rb-l"><span>Sulla banca</span><strong>${eur(banca)}</strong></div>
      <div class="rb-l tot"><span>Differenza</span><strong>${d === 0 ? "nessuna ✓" : sgn(d)}</strong></div>
      <p class="rb-n">${d === 0 ? "I saldi coincidono: il conto è allineato alla banca."
        : d > 0 ? "Alla banca c'è di più: manca un'entrata o hai segnato una spesa in più. Controlla prima di rettificare."
          : "Alla banca c'è meno: probabilmente manca una spesa. Controlla prima di rettificare."}</p>`;
    save.disabled = false;
    if (d === 0) { chk.hidden = true; save.textContent = "Conferma verifica"; }
    else { chk.hidden = false; save.textContent = `Registra rettifica ${sgn(d)} €`; }
  }
  ["#rc-conto", "#rc-data"].forEach((s) => $(s).addEventListener("change", recRefresh));
  $("#rc-banca").addEventListener("input", recRefresh);
  $("#btn-rec").addEventListener("click", openRec);
  $("#rc-cancel").addEventListener("click", () => $("#dlg-rec").close());
  async function recDo(withAdjust) {
    const c = recState.calc, msg = $("#rc-msg"); msg.textContent = "";
    if (!c) return;
    if (c.data > localToday()) { msg.textContent = "Scegli una data fino a oggi."; return; }
    const btns = ["#rc-save", "#rc-check", "#rc-cancel"].map((s) => $(s));
    btns.forEach((b) => { b.disabled = true; });
    try {
      if (withAdjust && c.diff !== 0) {
        const row = {
          id: crypto.randomUUID(), data: c.data, voce: "Rettifica saldo (banca)", conto: c.conto, tipo: c.tipo, importo: c.importo,
          categoria: "Rettifica", ordine: state.ops.reduce((m, o) => Math.max(m, o.ordine), -1) + 1,
          ricorrenza_id: null, data_prevista: null, modificata: false, annullata: false, updated_at: nowIso(),
        };
        const { error } = await sb.from("ops").upsert(row);
        if (error) throw error;
      }
    } catch (e) {
      btns.forEach((b) => { b.disabled = false; });
      if (isAuthError(e)) { $("#dlg-rec").close(); await handleError(e); return; }
      msg.textContent = "Salvataggio non riuscito. Controlla la connessione e riprova."; return;
    }
    let warn = false;
    try { await saveRiconc(c.conto, { data: c.data, banca: c.banca, calcolato: c.calcolato, diff: c.diff, rettifica: !!(withAdjust && c.diff !== 0), at: nowIso() }); } catch (e) { warn = true; }
    btns.forEach((b) => { b.disabled = false; });
    $("#dlg-rec").close();
    await reload();
    toast(warn ? "Rettifica registrata, ma la verifica non è stata salvata." : withAdjust && c.diff !== 0 ? "Rettifica registrata. Il conto è allineato." : c.diff === 0 ? "Verificato: i saldi coincidono." : "Verifica salvata (differenza non registrata).");
  }
  $("#form-rec").addEventListener("submit", (e) => { e.preventDefault(); recDo(true); });
  $("#rc-check").addEventListener("click", () => recDo(false));

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
  const rConto = $("#r-conto"), rFreq = $("#r-freq"), rBusta = $("#r-busta");
  function ruleFromForm() {
    const conto = rConto.value;
    const ogni = rFreq.value === "altro" ? Number($("#r-ogni").value) : Number(rFreq.value);
    return {
      conto, voce: $("#r-voce").value.trim(), tipo: conto === "comune" ? "uscita" : $("#r-tipo").value,
      importo: parseImporto($("#r-importo").value), categoria: $("#r-cat").value.trim() || null,
      ogni_mesi: ogni, giorno: Number($("#r-giorno").value), data_inizio: $("#r-inizio").value, data_fine: $("#r-fine").value || null,
      busta_id: (conto === "comune" || $("#r-tipo").value === "uscita") && !$("#r-busta-wrap").hidden ? rBusta.value || null : null,
    };
  }
  function refreshRuleBusta() {
    const conto = rConto.value, uscita = conto === "comune" || $("#r-tipo").value === "uscita", ed = state.editingRule;
    $("#r-busta-wrap").hidden = !(uscita && (state.budget.buste.length > 0 || (ed && ed.busta_id)));
    if ($("#r-busta-wrap").hidden) { rBusta.value = ""; return; }
    const list = bustaChoices(conto, $("#r-inizio").value, ed && ed.busta_id), pick = rBusta.dataset.pick || "";
    rBusta.innerHTML = `<option value="">${list.length ? (ed && !ed.busta_id ? "Senza busta (storico)" : "Scegli la busta…") : "Nessuna busta di spesa per questo conto"}</option>` +
      list.map((b) => `<option value="${esc(b.id)}">${esc(b.nome)}</option>`).join("");
    rBusta.value = list.some((b) => b.id === pick) ? pick : "";
  }
  rBusta.addEventListener("change", () => { rBusta.dataset.pick = rBusta.value; });
  $("#r-tipo").addEventListener("change", updateRuleUi);
  function validateRule(r) {
    if (!r.voce) return "Scrivi una descrizione.";
    if (!(r.importo > 0)) return "L'importo deve essere maggiore di zero.";
    if (!Number.isInteger(r.ogni_mesi) || r.ogni_mesi < 1 || r.ogni_mesi > 24) return "Ogni quanti mesi: scegli un numero da 1 a 24.";
    if (!Number.isInteger(r.giorno) || r.giorno < 1 || r.giorno > 31) return "Il giorno del mese deve essere da 1 a 31.";
    if (!/^\d{4}-\d\d-\d\d$/.test(r.data_inizio)) return "Scegli la data di inizio.";
    if (r.data_fine && r.data_fine < r.data_inizio) return "La data di fine non può precedere l'inizio.";
    const ed = state.editingRule;
    if ((r.conto === "comune" || r.tipo === "uscita") && state.budget.buste.length > 0 && !r.busta_id && !(ed && !ed.busta_id)) return "Scegli la busta della spesa.";
    return "";
  }
  function updateRuleUi() {
    $("#r-tipo-wrap").hidden = rConto.value === "comune";
    refreshRuleBusta();
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
    rBusta.dataset.pick = src && src.busta_id ? src.busta_id : "";
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

  const SAME = ["voce", "conto", "tipo", "importo", "categoria", "ogni_mesi", "giorno", "data_inizio", "data_fine", "busta_id"];
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
    const fields = { voce: nuova.voce, conto: nuova.conto, tipo: nuova.tipo, importo: nuova.importo, categoria: nuova.categoria, busta_id: nuova.busta_id ?? null };
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

  // ---------- buste e fondi ----------
  // Le definizioni stanno nella riga `config` id = 'budget' (nessuna tabella nuova). Ogni uscita ha la sua busta (`busta_id`).
  // Si rilegge la riga prima di scrivere, così due persone non si sovrascrivono a vicenda.
  async function saveBudget(mutate, okMsg) {
    try {
      const r = await sb.from("config").select("dati").eq("id", "budget").maybeSingle();
      if (r.error) throw r.error;
      const dati = Calc.normBudget(r.data ? r.data.dati : null);
      mutate(dati);
      const w = await sb.from("config").upsert({ id: "budget", dati, updated_at: nowIso() });
      if (w.error) throw w.error;
      state.budget = dati;
    } catch (e) { await handleError(e, "Salvataggio non riuscito. Controlla la connessione e riprova."); return false; }
    if (okMsg) toast(okMsg);
    return true;
  }
  const budMese = () => state.bud.mese || localToday().slice(0, 7);
  const shiftMese = (m, n) => Calc.monthEndPlus(`${m}-01`, n).slice(0, 7);

  function renderBud() {
    const bud = state.budget, mese = budMese(), conto = state.bud.conto, today = localToday(), hide = state.hide;
    const M = (v) => (hide ? MASK : eur(v));
    const names = { c1: cname("c1"), c2: cname("c2"), tot: "Insieme" };
    $("#bud-ctl").innerHTML = `<div class="bud-mese"><button type="button" class="btn sm" data-bact="prev" aria-label="Mese precedente">‹</button><strong>${esc(fmtMese(mese))}</strong><button type="button" class="btn sm" data-bact="next" aria-label="Mese successivo">›</button></div>
      <div class="seg">${["c1", "c2", "tot"].map((k) => `<button type="button" class="seg-b" data-bact="conto" data-k="${k}" aria-pressed="${k === conto}">${esc(names[k])}</button>`).join("")}</div>`;
    const body = $("#bud-body");
    if (!bud.buste.length && !bud.fondi.length) {
      body.innerHTML = `<div class="card bud-empty"><h3>Pianifica dove vanno i soldi</h3>
        <p>Una <strong>busta</strong> dice come usi il denaro del mese: di <em>spesa</em> (un budget da spendere) oppure di <em>accumulo</em> (soldi messi da parte per un <strong>fondo</strong>). Quello che non assegni resta nel conto.</p>
        <div class="actions"><button class="btn primary" type="button" data-bact="busta-new">+ Nuova busta</button><button class="btn" type="button" data-bact="fondo-new">+ Nuovo fondo</button></div></div>`;
      return;
    }
    const plan = Calc.monthPlan(bud, state.ops, mese, conto);
    const pv = Calc.previsto(bud, state.ops, state.entries, state.cfg, mese, conto, today);
    const lib = Calc.libero(bud, state.ops, state.entries, state.cfg, conto, today);
    const neg = plan.daAssegnare < 0, chiuso = mese < today.slice(0, 7);
    let h = `<div class="card bud-sum"><div class="lbl">Da assegnare · ${esc(fmtMese(mese))}</div>
      <div class="big${neg && !hide ? " neg" : ""}">${M(plan.daAssegnare)}</div>
      <div class="line"><span>Entrate <strong>${M(plan.entrate)}</strong></span><span>Assegnato alle buste <strong>${M(plan.assegnato)}</strong></span><span>Uscite senza busta <strong>${eur(plan.senza)}</strong></span></div>
      <div class="line"><span>${chiuso ? "Saldo a fine mese" : "Saldo a fine mese previsto"} <strong>${M(pv.previsto)}</strong></span><span>Libero fuori dai fondi <strong>${M(lib.libero)}</strong></span></div>
      ${neg && !hide ? `<p class="bud-warn">Hai assegnato più di quanto entra questo mese: stai usando soldi già presenti sul conto.</p>` : ""}</div>`;

    h += `<div class="sim-h"><h3>Buste</h3><button class="btn sm primary" type="button" data-bact="busta-new">+ Busta</button></div>`;
    const righe = plan.righe.filter((r) => conto === "tot" || r.busta.conto === conto || r.busta.conto === "comune");
    h += righe.length ? `<div class="bud-list">${righe.map((r) => budCard(r, mese)).join("")}</div>` : `<p class="empty">Nessuna busta per questo conto in questo mese.</p>`;

    const fondi = bud.fondi.filter((f) => conto === "tot" || f.conto === conto);
    h += `<div class="sim-h"><h3>Fondi</h3><button class="btn sm" type="button" data-bact="fondo-new">+ Fondo</button></div>`;
    h += fondi.length ? `<div class="bud-list">${fondi.map((f) => {
      const s = Calc.fondoSaldo(bud, f, state.ops, today);
      return `<div class="card fcard"><div class="bc-top"><div class="bc-nm">${esc(f.nome)}<small>${esc(cname(f.conto))}</small></div>
        <div class="bc-v"><strong>${M(s.saldo)}</strong>${s.inArrivo ? `<small>+${M(s.inArrivo)} a fine mese</small>` : ""}</div></div>
        <div class="bc-act"><button class="btn sm" type="button" data-bact="fondo-edit" data-id="${esc(f.id)}">Modifica</button></div></div>`;
    }).join("")}</div>` : `<p class="empty">Nessun fondo per questo conto.</p>`;
    h += `<div class="actions" style="margin-top:14px"><button class="btn" type="button" data-bact="cat">📊 Spese per categoria</button></div>`;
    body.innerHTML = h;
  }

  function budCard(r, mese) {
    const b = r.busta, bud = state.budget, hide = state.hide;
    const fondo = b.fondo ? bud.fondi.find((f) => f.id === b.fondo) : null;
    const meta = [b.tipo === "spesa" ? "Spesa" : "Accumulo", b.conto === "comune" ? "Conto comune · metà" : cname(b.conto)];
    if (fondo) meta.push(b.tipo === "accumulo" ? `→ ${fondo.nome}` : `paga dal fondo ${fondo.nome}`);
    const nm = (id) => { const x = bud.buste.find((y) => y.id === id); return x ? x.nome : "busta eliminata"; };
    const mv = bud.spostamenti.filter((x) => x.mese === mese && (x.a === b.id || x.da === b.id)).map((x) =>
      `<div class="bc-mv"><span>${hide ? MASK : x.a === b.id ? `+${eur(x.importo)}` : `−${eur(x.importo)}`} ${x.a === b.id ? "da" : "a"} «${esc(nm(x.a === b.id ? x.da : x.a))}»</span>
        <button type="button" class="btn link sm" data-bact="undo" data-id="${esc(x.id)}">Annulla</button></div>`).join("");
    const edit = `<div class="bc-act"><button class="btn sm" type="button" data-bact="busta-edit" data-id="${esc(b.id)}">Modifica</button></div>`;
    const head = (v, sub) => `<div class="bc-top"><div class="bc-nm">${esc(b.nome)}<small>${esc(meta.join(" · "))}</small></div><div class="bc-v"><strong>${v}</strong>${sub ? `<small>${sub}</small>` : ""}</div></div>`;
    if (b.tipo === "accumulo") {
      return `<div class="card bcard acc">${head(hide ? MASK : eur(r.budget), "a fine mese nel fondo")}${mv}${edit}</div>`;
    }
    const pct = r.budget > 0 ? Math.min(100, (r.speso / r.budget) * 100) : r.speso > 0 ? 100 : 0;
    const foot = r.stato === "over"
      ? `<p class="bc-foot over">⚠ Superi il budget di ${eur(r.over)}: prendi budget da un'altra busta. <button type="button" class="btn sm danger" data-bact="copri" data-id="${esc(b.id)}">Copri</button></p>`
      : `<p class="bc-foot">${r.stato === "warn" ? "Quasi finito · " : ""}restano ${eur(r.residuo)}</p>`;
    return `<div class="card bcard st-${r.stato}">${head(eur(r.speso), `su ${eur(r.budget)}`)}
      <div class="bar" role="img" aria-label="${esc(b.nome)}: speso ${eur(r.speso)} su ${eur(r.budget)}"><i style="width:${pct.toFixed(1)}%"></i></div>${foot}${mv}${edit}</div>`;
  }

  $("#bud-view").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bact]"); if (!b) return;
    const a = b.dataset.bact, id = b.dataset.id, bud = state.budget;
    if (a === "prev") { state.bud.mese = shiftMese(budMese(), -1); renderBud(); }
    else if (a === "next") { state.bud.mese = shiftMese(budMese(), 1); renderBud(); }
    else if (a === "conto") { state.bud.conto = b.dataset.k; renderBud(); }
    else if (a === "busta-new") openBusta(null);
    else if (a === "busta-edit") openBusta(bud.buste.find((x) => x.id === id));
    else if (a === "fondo-new") openFondo(null);
    else if (a === "fondo-edit") openFondo(bud.fondi.find((x) => x.id === id));
    else if (a === "copri") openCopri(id);
    else if (a === "undo") {
      if (state.hide) { hiddenWarn("i budget"); return; }
      saveBudget((d) => { d.spostamenti = d.spostamenti.filter((x) => x.id !== id); }, "Spostamento annullato.").then((ok) => { if (ok) render(); });
    }
  });

  // ----- busta -----
  function buUi(fondoSel) {
    const old = state.editingBusta, tipo = $("#bu-tipo").value, sel = $("#bu-conto");
    sel.options[2].disabled = tipo === "accumulo";
    if (tipo === "accumulo" && sel.value === "comune") sel.value = "c1";
    const fondi = state.budget.fondi.filter((f) => f.conto === sel.value);
    const keep = fondoSel !== undefined ? fondoSel : $("#bu-fondo").value;
    // il fondo si sceglie solo per le buste di accumulo: una busta di spesa non è legata a nessun fondo
    $("#bu-fondo-wrap").hidden = tipo !== "accumulo";
    $("#bu-fondo").innerHTML = (fondi.length ? "" : `<option value="">Crea prima un fondo per questo conto</option>`) +
      fondi.map((f) => `<option value="${esc(f.id)}">${esc(f.nome)}</option>`).join("");
    $("#bu-fondo").value = fondi.some((f) => f.id === keep) ? keep : tipo === "accumulo" && fondi.length ? fondi[0].id : "";
    $("#bu-tipo").disabled = !!old; sel.disabled = !!old;
    $("#bu-hint").textContent = (tipo === "accumulo"
      ? "I soldi restano sul conto ma sono messi da parte: a fine mese vanno nel fondo. Non sono una spesa."
      : "Soldi che pensi di spendere nel mese. Quello che non spendi resta nel conto.") + (old ? " Tipo e conto non si cambiano dopo la creazione." : "");
  }
  function openBusta(b) {
    if (state.hide) { hiddenWarn("le buste"); return; }
    state.editingBusta = b || null; state.buDel = false;
    const sel = $("#bu-conto");
    sel.options[0].textContent = cname("c1"); sel.options[1].textContent = cname("c2");
    $("#bu-title").textContent = b ? "Modifica busta" : "Nuova busta";
    $("#bu-nome").value = b ? b.nome : "";
    $("#bu-tipo").value = b ? b.tipo : "spesa";
    sel.value = b ? b.conto : state.bud.conto === "c2" ? "c2" : "c1";
    $("#bu-importo").value = b ? String(Calc.bustaImporto(b, budMese())).replace(".", ",") : "";
    $("#bu-fine").value = b && b.fine ? b.fine : "";
    $("#bu-scope-wrap").hidden = !b; $("#bu-scope").value = "from";
    $("#bu-del").hidden = !b; $("#bu-del").textContent = "Elimina";
    $("#bu-msg").textContent = ""; $("#bu-save").disabled = false;
    buUi(b ? b.fondo || "" : "");
    $("#dlg-busta").showModal();
  }
  $("#bu-tipo").addEventListener("change", () => buUi());
  $("#bu-conto").addEventListener("change", () => buUi());
  $("#bu-cancel").addEventListener("click", () => $("#dlg-busta").close());
  $("#form-busta").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#bu-msg"); msg.textContent = "";
    const old = state.editingBusta, mese = budMese();
    const nome = $("#bu-nome").value.trim().slice(0, 60), tipo = old ? old.tipo : $("#bu-tipo").value, conto = old ? old.conto : $("#bu-conto").value;
    const fondo = tipo === "accumulo" ? $("#bu-fondo").value || null : null, imp = parseImporto($("#bu-importo").value), fine = $("#bu-fine").value || null;
    if (!nome) { msg.textContent = "Scrivi un nome."; return; }
    if (Number.isNaN(imp) || imp < 0) { msg.textContent = "Scrivi il budget del mese (anche 0)."; return; }
    if (tipo === "accumulo" && !fondo) { msg.textContent = "Scegli il fondo che riceve i soldi (creane uno con «+ Fondo»)."; return; }
    if (state.budget.buste.some((b) => b.conto === conto && b.nome.toLowerCase() === nome.toLowerCase() && (!old || b.id !== old.id))) { msg.textContent = "Esiste già una busta con questo nome su questo conto."; return; }
    const first = old ? (old.steps || []).reduce((m, s) => (m === null || s.da < m ? s.da : m), mese) : mese;
    if (fine && fine < first) { msg.textContent = "L'ultimo mese non può precedere il primo."; return; }
    $("#bu-save").disabled = true;
    const ok = await saveBudget((d) => {
      if (!old) { d.buste.push({ id: crypto.randomUUID(), nome, tipo, conto, fondo, steps: [{ da: mese, importo: r2(imp) }], fine }); return; }
      const b = d.buste.find((x) => x.id === old.id); if (!b) return;
      const before = Calc.bustaImporto(b, mese), nextM = shiftMese(mese, 1), atNext = Calc.bustaImporto(b, nextM);
      b.nome = nome; b.fondo = fondo; b.fine = fine;
      if (r2(imp) !== before) {
        if ($("#bu-scope").value === "only") {
          b.steps = (b.steps || []).filter((s) => s.da !== mese);
          b.steps.push({ da: mese, importo: r2(imp) });
          if (!b.steps.some((s) => s.da === nextM)) b.steps.push({ da: nextM, importo: atNext });
        } else b.steps = (b.steps || []).filter((s) => s.da < mese).concat({ da: mese, importo: r2(imp) });
      }
    }, old ? "Busta aggiornata." : "Busta creata.");
    $("#bu-save").disabled = false;
    if (ok) { $("#dlg-busta").close(); render(); }
  });
  $("#bu-del").addEventListener("click", async () => {
    const old = state.editingBusta, msg = $("#bu-msg");
    if (!old) return;
    if (state.ops.some((o) => o.busta_id === old.id) || state.rules.some((r) => r.busta_id === old.id)) { msg.textContent = "Ha operazioni o ricorrenze collegate: non si può eliminare. Imposta «Ultimo mese» per chiuderla."; return; }
    if (!state.buDel) { state.buDel = true; $("#bu-del").textContent = "Conferma eliminazione"; return; }
    const ok = await saveBudget((d) => { d.buste = d.buste.filter((b) => b.id !== old.id); d.spostamenti = d.spostamenti.filter((x) => x.da !== old.id && x.a !== old.id); }, "Busta eliminata.");
    if (ok) { $("#dlg-busta").close(); render(); }
  });

  // ----- fondo -----
  function openFondo(f) {
    if (state.hide) { hiddenWarn("i fondi"); return; }
    state.editingFondo = f || null; state.foDel = false;
    const sel = $("#fo-conto");
    sel.options[0].textContent = cname("c1"); sel.options[1].textContent = cname("c2");
    $("#fo-title").textContent = f ? "Modifica fondo" : "Nuovo fondo";
    $("#fo-nome").value = f ? f.nome : "";
    sel.value = f ? f.conto : state.bud.conto === "c2" ? "c2" : "c1"; sel.disabled = !!f;
    $("#fo-iniziale").value = f && Number(f.iniziale) ? String(f.iniziale).replace(".", ",") : "";
    $("#fo-del").hidden = !f; $("#fo-del").textContent = "Elimina";
    $("#fo-msg").textContent = ""; $("#fo-save").disabled = false;
    $("#dlg-fondo").showModal();
  }
  $("#fo-cancel").addEventListener("click", () => $("#dlg-fondo").close());
  $("#form-fondo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#fo-msg"); msg.textContent = "";
    const old = state.editingFondo, nome = $("#fo-nome").value.trim().slice(0, 60), conto = old ? old.conto : $("#fo-conto").value;
    const raw = $("#fo-iniziale").value.trim(), ini = raw === "" ? 0 : parseImporto(raw);
    if (!nome) { msg.textContent = "Scrivi un nome."; return; }
    if (Number.isNaN(ini) || ini < 0) { msg.textContent = "L'importo già accumulato deve essere zero o più."; return; }
    if (state.budget.fondi.some((f) => f.nome.toLowerCase() === nome.toLowerCase() && (!old || f.id !== old.id))) { msg.textContent = "Esiste già un fondo con questo nome."; return; }
    $("#fo-save").disabled = true;
    const ok = await saveBudget((d) => {
      if (!old) d.fondi.push({ id: crypto.randomUUID(), nome, conto, iniziale: r2(ini) });
      else { const f = d.fondi.find((x) => x.id === old.id); if (f) { f.nome = nome; f.iniziale = r2(ini); } }
    }, old ? "Fondo aggiornato." : "Fondo creato.");
    $("#fo-save").disabled = false;
    if (ok) { $("#dlg-fondo").close(); render(); }
  });
  $("#fo-del").addEventListener("click", async () => {
    const old = state.editingFondo, msg = $("#fo-msg");
    if (!old) return;
    if (state.budget.buste.some((b) => b.fondo === old.id)) { msg.textContent = "Ci sono buste collegate a questo fondo: cambiale o eliminale prima."; return; }
    if (!state.foDel) { state.foDel = true; $("#fo-del").textContent = "Conferma eliminazione"; return; }
    const ok = await saveBudget((d) => { d.fondi = d.fondi.filter((f) => f.id !== old.id); }, "Fondo eliminato.");
    if (ok) { $("#dlg-fondo").close(); render(); }
  });

  // ----- copri una busta con il budget di un'altra -----
  function openCopri(id) {
    if (state.hide) { hiddenWarn("i budget"); return; }
    const bud = state.budget, mese = budMese(), dest = bud.buste.find((b) => b.id === id);
    if (!dest) return;
    const st = Calc.statoBusta(bud, state.ops, dest, mese);
    const fonti = bud.buste.filter((b) => b.id !== dest.id && b.conto === dest.conto && (Calc.bustaAttiva(b, mese) || Calc.bustaBudget(bud, b, mese) > 0))
      .map((b) => ({ b, lib: Calc.statoBusta(bud, state.ops, b, mese).libero })).filter((x) => x.lib > 0);
    state.copri = { dest, mese, fonti };
    $("#cv-info").textContent = `«${dest.nome}» supera il budget di ${eur(st.over)} in ${fmtMese(mese)}. Prendi la differenza dal budget di un'altra busta dello stesso conto.`;
    $("#cv-da").innerHTML = fonti.length ? fonti.map((x) => `<option value="${esc(x.b.id)}">${esc(x.b.nome)} · disponibili ${eur(x.lib)}</option>`).join("") : `<option value="">Nessuna busta ha budget da cedere</option>`;
    $("#cv-importo").value = fonti.length ? String(Math.min(st.over, fonti[0].lib)).replace(".", ",") : "";
    $("#cv-msg").textContent = fonti.length ? "" : "Nessun'altra busta di questo conto ha budget disponibile in questo mese.";
    $("#cv-save").disabled = !fonti.length;
    $("#dlg-copri").showModal();
  }
  $("#cv-da").addEventListener("change", () => {
    const c = state.copri; if (!c) return;
    const x = c.fonti.find((y) => y.b.id === $("#cv-da").value);
    if (x) $("#cv-importo").value = String(Math.min(Calc.statoBusta(state.budget, state.ops, c.dest, c.mese).over, x.lib)).replace(".", ",");
  });
  $("#cv-cancel").addEventListener("click", () => $("#dlg-copri").close());
  $("#form-copri").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = state.copri, msg = $("#cv-msg"); msg.textContent = "";
    if (!c) return;
    const da = c.fonti.find((x) => x.b.id === $("#cv-da").value), imp = parseImporto($("#cv-importo").value);
    if (!da) { msg.textContent = "Scegli la busta da cui prendere il budget."; return; }
    if (!(imp > 0)) { msg.textContent = "Scrivi un importo maggiore di zero."; return; }
    if (imp > da.lib + 0.004) { msg.textContent = `Da «${da.b.nome}» puoi prendere al massimo ${eur(da.lib)}.`; return; }
    $("#cv-save").disabled = true;
    const ok = await saveBudget((d) => { d.spostamenti.push({ id: crypto.randomUUID(), mese: c.mese, da: da.b.id, a: c.dest.id, importo: r2(imp) }); }, "Budget spostato.");
    $("#cv-save").disabled = false;
    if (ok) { $("#dlg-copri").close(); render(); }
  });

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
    if (res.rows.length) h += donutCard(res, state.simChart || (res.goalDef ? res.goalDef.conto : "c1"));

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


  // Ciambella delle uscite di un mese dello scenario: operazioni reali (per categoria) + voci simulate.
  const simColor = (i) => `hsl(${(268 + i * 24) % 360} 78% ${i % 2 ? 62 : 54}%)`;
  function donutCard(res, conto) {
    const rows = res.rows;
    const has = (r) => r.voci.c1 !== 0 || r.voci.c2 !== 0;
    if (!rows.some((r) => r.mese === state.simMese)) state.simMese = (rows.find(has) || rows[rows.length - 1]).mese;
    const mese = state.simMese;
    const pills = [["c1", "Conto 1"], ["c2", "Conto 2"], ["tot", "Insieme"]]
      .map(([k, l]) => `<button type="button" class="seg-b" data-sact="chart" data-k="${k}" aria-pressed="${k === conto}">${l}</button>`).join("");
    const chips = rows.map((r) => `<button type="button" class="mchip${has(r) ? " has" : ""}" data-sact="mese" data-k="${r.mese}" aria-pressed="${r.mese === mese}">${esc(MESI[Number(r.mese.slice(5)) - 1].slice(0, 3))}<small>${r.mese.slice(2, 4)}</small></button>`).join("");
    const im = Calc.monthImpact(res, mese, conto);
    const usc = r2(im.uscite.real + im.uscite.sim), ent = r2(im.entrate.real + im.entrate.sim), net = r2(ent - usc);
    const segs = im.segs;
    let sel = state.simSeg !== null && segs[state.simSeg] ? state.simSeg : null;
    let nSim = 0;
    const cols = segs.map((s) => (s.kind === "sim" ? simColor(nSim++) : catColor(s.label)));
    let svg;
    if (usc > 0) {
      const R = 74, C = 2 * Math.PI * R, gap = segs.length > 1 ? 2.5 : 0;
      let at = 0;
      const arcs = segs.map((s, i) => {
        const len = (s.tot / usc) * C, start = at; at += len;
        const dim = sel !== null && sel !== i;
        return `<circle class="dn-seg${dim ? " dim" : ""}${sel === i ? " on" : ""}" cx="100" cy="100" r="${R}" fill="none" stroke="${cols[i]}" stroke-width="30"
          stroke-dasharray="${Math.max(len - gap, 0.5).toFixed(2)} ${(C - Math.max(len - gap, 0.5)).toFixed(2)}" stroke-dashoffset="${(-start).toFixed(2)}" transform="rotate(-90 100 100)"><title>${esc(s.label)}: ${eur(s.tot)}</title></circle>`;
      }).join("");
      const cLabel = sel !== null ? segs[sel].label : "Uscite", cVal = sel !== null ? segs[sel].tot : usc;
      const cSub = sel !== null ? `${((segs[sel].tot / usc) * 100).toFixed(0)}% del mese` : (im.uscite.sim > 0 ? `di cui scenario ${eur(im.uscite.sim)}` : "nessuna voce simulata");
      svg = `<svg class="dn" viewBox="0 0 200 200" role="img" aria-label="Uscite di ${esc(fmtMese(mese))}: ${eur(usc)}"><circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--tag)" stroke-width="30"/>${arcs}
        <text x="100" y="86" text-anchor="middle" class="dn-l">${esc(cLabel.length > 16 ? cLabel.slice(0, 15) + "…" : cLabel)}</text>
        <text x="100" y="108" text-anchor="middle" class="dn-v">${eur(cVal)}</text>
        <text x="100" y="125" text-anchor="middle" class="dn-s">${esc(cSub.length > 26 ? cSub.slice(0, 25) + "…" : cSub)}</text></svg>`;
    } else {
      svg = `<svg class="dn" viewBox="0 0 200 200" role="img" aria-label="Nessuna uscita"><circle cx="100" cy="100" r="74" fill="none" stroke="var(--tag)" stroke-width="30"/>
        <text x="100" y="105" text-anchor="middle" class="dn-s">Nessuna uscita</text></svg>`;
    }
    const sub = (a, b) => (state.hide ? "" : `<small>reali ${eur(a)} · scenario ${eur(b)}</small>`);
    const tiles = `<div class="dn-tiles">
      <div class="dn-t pos"><span>Entrate</span><strong>${mEur(ent)}</strong>${state.hide ? "" : `<small>reali ${eur(im.entrate.real)} · scenario ${eur(im.entrate.sim)}</small>`}</div>
      <div class="dn-t neg"><span>Uscite</span><strong>${eur(usc)}</strong>${sub(im.uscite.real, im.uscite.sim)}</div>
      <div class="dn-t net ${net < 0 && !state.hide ? "neg" : "pos"}"><span>Netto del mese</span><strong>${state.hide ? MASK : sgn(net)}</strong>${state.hide ? "" : `<small>${net < 0 ? "escono più soldi di quanti entrano" : "entra più di quanto esce"}</small>`}</div></div>`;
    const pct = (s) => `${((s.tot / usc) * 100).toFixed(s.tot / usc < .1 ? 1 : 0).replace(".", ",")}%`;
    const lrow = (s, i) => `<button type="button" class="lg-row${sel === i ? " on" : ""}" data-sact="seg" data-k="${i}" aria-pressed="${sel === i}">
        <i class="lg-dot" style="background:${cols[i]}"></i>
        <span class="lg-nm">${s.kind === "real" ? catIcon(s.label, "🏷️") + " " : ""}${esc(s.label)}<small>${s.n} ${s.n === 1 ? "operazione" : "operazioni"} · ${pct(s)}</small></span>
        <span class="lg-v">${eur(s.tot)}</span></button>`;
    const realIdx = segs.map((s, i) => i).filter((i) => segs[i].kind === "real");
    const simIdx = segs.map((s, i) => i).filter((i) => segs[i].kind === "sim");
    const legend = (realIdx.length ? `<div class="lg-grp"><div class="lg-h"><span>Spese registrate</span><strong>${eur(im.uscite.real)}</strong></div>${realIdx.map((i) => lrow(segs[i], i)).join("")}</div>` : "")
      + (simIdx.length ? `<div class="lg-grp sim"><div class="lg-h"><span>🧪 Voci dello scenario</span><strong>${eur(im.uscite.sim)}</strong></div>${simIdx.map((i) => lrow(segs[i], i)).join("")}
        <div class="lg-f"><span>Totale scenario</span><strong>${eur(im.uscite.sim)}</strong></div></div>` : "");
    return `<div class="sim-h"><h3>Impatto del mese</h3></div>
      <section class="card donut-card"><div class="seg">${pills}</div>
      <div class="mchips" role="group" aria-label="Mese">${chips}</div>
      <div class="dn-wrap">${svg}<div class="dn-legend">${legend || `<p class="empty" style="margin:8px 0">Nessuna uscita in ${esc(fmtMese(mese))}.</p>`}</div></div>${tiles}
      <p class="note" style="margin-top:8px">${esc(fmtMese(mese))}: operazioni registrate (per categoria) e voci dello scenario. Tocca una voce per isolarla nel centro. I mesi con un puntino hanno movimenti dello scenario.</p></section>`;
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
    if (a === "chart") { state.simChart = b.dataset.k; state.simSeg = null; renderSim(); return; }
    if (a === "mese") { state.simMese = b.dataset.k; state.simSeg = null; renderSim(); return; }
    if (a === "seg") { state.simSeg = state.simSeg === Number(b.dataset.k) ? null : Number(b.dataset.k); renderSim(); return; }
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
      return `<div class="catrow"><div class="top2"><div class="av2" aria-hidden="true">${catIcon(r.cat, "🏷️")}</div>
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
