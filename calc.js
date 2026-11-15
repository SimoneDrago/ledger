/* Logica di calcolo pura (nessun accesso a DOM o rete): testabile con Node. */
(function (root) {
  "use strict";

  const r2 = (n) => Math.round(n * 100) / 100;

  // Effetto con segno di un'operazione su c1 e c2 (spec §4.1)
  function parts(o) {
    const imp = Number(o.importo);
    if (o.conto === "comune") {
      const a = r2(imp / 2);
      return { c1: -a, c2: -r2(imp - a) };
    }
    const s = (o.tipo === "entrata" ? 1 : -1) * imp;
    return o.conto === "c2" ? { c1: 0, c2: s } : { c1: s, c2: 0 };
  }

  const rank = (o) => (o.conto !== "comune" && o.tipo === "entrata" ? 0 : 1);

  // Ordinamento cronologico (spec §4.2)
  function cmp(a, b) {
    if (a.data !== b.data) return a.data < b.data ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const oa = Number(a.ordine) || 0, ob = Number(b.ordine) || 0;
    if (oa !== ob) return oa - ob;
    return String(a.id).localeCompare(String(b.id));
  }

  // Saldi progressivi (spec §4.3). Le operazioni annullate non contano.
  function compute(cfg, ops) {
    let b1 = Number(cfg.c1.iniziale), b2 = Number(cfg.c2.iniziale);
    const min = { c1: b1, c2: b2 };
    const entries = ops.filter((o) => !o.annullata).sort(cmp).map((o) => {
      const p = parts(o);
      b1 = r2(b1 + p.c1);
      b2 = r2(b2 + p.c2);
      if (b1 < min.c1) min.c1 = b1;
      if (b2 < min.c2) min.c2 = b2;
      return { o, p, b: { c1: b1, c2: b2 } };
    });
    return { entries, cur: { c1: b1, c2: b2 }, min };
  }

  // Accetta 89,50  89.50  1.234,50  € 20  -> numero, oppure NaN
  function parseImporto(s) {
    let t = String(s).replace(/[€\s]/g, "");
    if (!/^\d[\d.,]*$/.test(t)) return NaN;
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
    const n = Number(t);
    return Number.isFinite(n) ? r2(n) : NaN;
  }

  // ---------- Operazioni ricorrenti (date come stringhe YYYY-MM-DD, nessun fuso) ----------
  const pad2 = (n) => String(n).padStart(2, "0");
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = (y, m) => (m === 2 ? (leap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
  const ymd = (s) => [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
  const fmtYMD = (y, m, d) => `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
  const NOMI_MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

  // Ultimo giorno del mese che cade `n` mesi dopo quello di `s`
  function monthEndPlus(s, n) {
    const [y, m] = ymd(s);
    const idx = y * 12 + (m - 1) + n;
    const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
    return fmtYMD(ny, nm, dim(ny, nm));
  }

  // Date di una regola comprese tra `from` e `to` (inclusi). Se il mese è più
  // corto del giorno richiesto si usa l'ultimo giorno del mese.
  function occurrences(rule, from, to, limit) {
    const [y0, m0] = ymd(rule.data_inizio);
    const step = Math.max(1, Number(rule.ogni_mesi));
    const g = Number(rule.giorno);
    const out = [];
    for (let n = 0; n < 5000; n++) {
      const idx = y0 * 12 + (m0 - 1) + n * step;
      const y = Math.floor(idx / 12), m = (idx % 12) + 1;
      const s = fmtYMD(y, m, Math.min(g, dim(y, m)));
      if (s > to) break;
      if (s >= rule.data_inizio && s >= from) {
        out.push(s);
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }

  // Orizzonte: la data più vicina tra data_fine e la fine del 12° mese dopo oggi
  function horizon(rule, today) {
    const h = monthEndPlus(today, 12);
    return rule.data_fine && rule.data_fine < h ? rule.data_fine : h;
  }

  // Date da generare. Se la regola ha già operazioni si genera solo da oggi in poi
  // (così un cambio di giorno/frequenza non ricrea il passato).
  function generationDates(rule, today, hasExisting) {
    return occurrences(rule, hasExisting ? today : rule.data_inizio, horizon(rule, today));
  }

  function nextDates(rule, today, k) {
    return occurrences(rule, today, rule.data_fine || "9999-12-31", k);
  }

  // Riga di `ops` generata da una regola
  function ruleRow(rule, d) {
    return {
      id: `${rule.id}_${d}`,
      ricorrenza_id: rule.id,
      data_prevista: d,
      data: d,
      voce: rule.voce,
      conto: rule.conto,
      tipo: rule.conto === "comune" ? "uscita" : rule.tipo,
      importo: Number(rule.importo),
      categoria: rule.categoria || null,
      ordine: 0,
      modificata: false,
      annullata: false,
    };
  }

  function freqText(rule) {
    const n = Number(rule.ogni_mesi), g = rule.giorno;
    if (n === 1) return `ogni mese il ${g}`;
    if (n % 12 === 0) {
      const a = n / 12, mese = NOMI_MESI[ymd(rule.data_inizio)[1] - 1];
      return `${a === 1 ? "ogni anno" : `ogni ${a} anni`} il ${g} ${mese}`;
    }
    return `ogni ${n} mesi il ${g}`;
  }

  // ---------- Simulazione (scenari) ----------
  // Una voce di scenario: { id, voce, conto, tipo, importo, data, ogni_mesi (0 = una volta sola), volte, attiva }
  function expandVoce(v) {
    const periodic = Number(v.ogni_mesi) > 0;
    const dates = periodic
      ? occurrences({ data_inizio: v.data, ogni_mesi: Number(v.ogni_mesi), giorno: Number(v.data.slice(8, 10)) }, "0000-01-01", "9999-12-31", Math.max(1, Number(v.volte) || 1))
      : [v.data];
    return dates.map((d) => ({
      id: `sim_${v.id}_${d}`, voce: v.voce, data: d, conto: v.conto, tipo: v.conto === "comune" ? "uscita" : v.tipo,
      importo: Number(v.importo), categoria: null, ordine: 0, annullata: false, sim: true,
    }));
  }

  // Saldo dopo l'ultima operazione con data <= date (altrimenti il saldo iniziale)
  function balanceAt(entries, cfg, date) {
    let b = { c1: Number(cfg.c1.iniziale), c2: Number(cfg.c2.iniziale) };
    for (const e of entries) { if (e.o.data > date) break; b = e.b; }
    return b;
  }
  const pick = (conto, b) => (conto === "tot" ? r2(b.c1 + b.c2) : b[conto]);

  function minPoint(entries, cfg, upTo) {
    const m = { c1: { v: Number(cfg.c1.iniziale), d: cfg.dataInizio }, c2: { v: Number(cfg.c2.iniziale), d: cfg.dataInizio } };
    for (const e of entries) {
      if (e.o.data > upTo) break;
      for (const k of ["c1", "c2"]) if (e.b[k] < m[k].v) m[k] = { v: e.b[k], d: e.o.data };
    }
    return m;
  }

  // Confronta i dati reali con i dati + le voci attive dello scenario. Non scrive nulla.
  function simulate(cfg, ops, sc) {
    const voci = (sc.voci || []).filter((v) => v.attiva !== false && /^\d{4}-\d\d-\d\d$/.test(v.data || ""));
    const simOps = voci.flatMap(expandVoce);
    const real = compute(cfg, ops), sim = compute(cfg, ops.concat(simOps));
    const g0 = sc.obiettivo;
    const goal = g0 && ["c1", "c2", "tot"].includes(g0.conto) && /^\d{4}-\d\d-\d\d$/.test(g0.data || "") && Number.isFinite(Number(g0.minimo)) && g0.minimo !== "" && g0.minimo !== null
      ? { conto: g0.conto, data: g0.data, minimo: Number(g0.minimo) } : null;
    if (!simOps.length) return { rows: [], goal: null, simCount: 0, goalDef: goal, real, sim, simOps: [] };
    // orizzonte: ultima data reale, obiettivo, voci una tantum, e 12 mesi dalla prima data delle voci periodiche
    const cand = [];
    if (real.entries.length) cand.push(real.entries[real.entries.length - 1].o.data);
    if (goal) cand.push(goal.data);
    for (const v of voci) cand.push(Number(v.ogni_mesi) > 0 ? monthEndPlus(v.data, 11) : v.data);
    const endDate = monthEndPlus(cand.reduce((a, b) => (a > b ? a : b)), 0);
    const first = simOps.reduce((a, o) => (o.data < a ? o.data : a), simOps[0].data);
    const rows = [];
    for (let cur = monthEndPlus(first, -1); cur <= endDate; cur = monthEndPlus(cur, 1)) {
      const mese = cur.slice(0, 7);
      // movimento del mese: uscite reali registrate (solo quelle in negativo) e effetto netto delle voci dello scenario
      const spese = { c1: 0, c2: 0 }, vs = { c1: 0, c2: 0 };
      for (const e of real.entries) if (e.o.data.slice(0, 7) === mese) for (const k of ["c1", "c2"]) if (e.p[k] < 0) spese[k] = r2(spese[k] + e.p[k]);
      for (const o of simOps) if (o.data.slice(0, 7) === mese) { const p = parts(o); vs.c1 = r2(vs.c1 + p.c1); vs.c2 = r2(vs.c2 + p.c2); }
      rows.push({ mese, real: balanceAt(real.entries, cfg, cur), sim: balanceAt(sim.entries, cfg, cur), spese, voci: vs });
    }
    let res = null;
    if (goal) {
      const s = pick(goal.conto, balanceAt(sim.entries, cfg, goal.data)), r = pick(goal.conto, balanceAt(real.entries, cfg, goal.data));
      const margine = r2(s - goal.minimo);
      res = { saldoSim: s, saldoReale: r, margine, ok: margine >= 0 };
    }
    return { rows, goal: res, goalDef: goal, simOps, simCount: simOps.length, endDate, minSim: minPoint(sim.entries, cfg, endDate), minReal: minPoint(real.entries, cfg, endDate), real, sim };
  }

  // Entrate e uscite di un mese, divise tra operazioni reali (per categoria) e voci dello scenario.
  // res: risultato di simulate(); conto: "c1" | "c2" | "tot". Le uscite comuni pesano per la quota del conto.
  function monthImpact(res, mese, conto) {
    const eff = (p) => (conto === "tot" ? p.c1 + p.c2 : p[conto]);
    const out = { entrate: { real: 0, sim: 0 }, uscite: { real: 0, sim: 0 }, segs: [] };
    const real = new Map(), sim = new Map();
    const add = (map, key, v, kind) => { const m = map.get(key) || { label: key, kind, tot: 0, n: 0 }; m.tot = r2(m.tot - v); m.n += 1; map.set(key, m); };
    const scan = (list, kind, map) => {
      for (const x of list) {
        if (x.o.data.slice(0, 7) !== mese) continue;
        const v = r2(eff(x.p));
        if (v === 0) continue;
        if (v > 0) out.entrate[kind] = r2(out.entrate[kind] + v);
        else { out.uscite[kind] = r2(out.uscite[kind] - v); add(map, kind === "real" ? (x.o.categoria || "Senza categoria") : (x.o.voce || "Voce"), v, kind); }
      }
    };
    scan(res.real.entries, "real", real);
    scan((res.simOps || []).map((o) => ({ o, p: parts(o) })), "sim", sim);
    const order = (a, b) => b.tot - a.tot || a.label.localeCompare(b.label, "it");
    out.segs = [...real.values()].sort(order).concat([...sim.values()].sort(order));
    return out;
  }

  // ---------- Buste e fondi ----------
  // Dati (riga `config` id = 'budget'):
  //   fondi: [{ id, nome, conto: "c1"|"c2", iniziale, obiettivo }]
  //   buste: [{ id, nome, tipo: "spesa"|"accumulo", conto: "c1"|"c2"|"comune", fondo, steps: [{ da: "AAAA-MM", importo }], fine }]
  //   spostamenti: [{ id, mese, da: bustaId, a: bustaId, importo }]   (copertura di una busta con il budget di un'altra)
  // `fondo`: per un accumulo è il fondo che riceve i soldi; per una spesa (facoltativo) è il fondo da cui si pagano.
  // Ogni uscita appartiene a una busta tramite `busta_id`. Non c'è riporto tra mesi: ogni mese riparte dal suo budget.
  const monthOf = (d) => String(d).slice(0, 7);
  const addMonth = (m, n) => monthEndPlus(`${m}-01`, n).slice(0, 7);
  const lastDay = (m) => monthEndPlus(`${m}-01`, 0);
  const emptyBudget = () => ({ fondi: [], buste: [], spostamenti: [] });
  const normBudget = (d) => ({
    fondi: Array.isArray(d && d.fondi) ? d.fondi : [],
    buste: Array.isArray(d && d.buste) ? d.buste : [],
    spostamenti: Array.isArray(d && d.spostamenti) ? d.spostamenti : [],
  });
  // quota di un importo di una busta (o di un'operazione) che pesa sul conto k ("tot" = tutto)
  function share(imp, bustaConto, k) {
    if (k === "tot") return r2(imp);
    if (bustaConto === "comune") { const a = r2(imp / 2); return k === "c1" ? a : r2(imp - a); }
    return bustaConto === k ? r2(imp) : 0;
  }

  // Importo base della busta nel mese: l'ultimo "da questo mese in poi" che vale, 0 dopo la fine.
  function bustaImporto(b, mese) {
    if (b.fine && mese > b.fine) return 0;
    let imp = 0, da = "";
    for (const s of b.steps || []) if (s.da <= mese && s.da >= da) { imp = Number(s.importo) || 0; da = s.da; }
    return imp;
  }
  // La busta si può scegliere per una spesa di questo mese: è iniziata e non è finita.
  function bustaAttiva(b, mese) {
    if (b.fine && mese > b.fine) return false;
    return (b.steps || []).some((s) => s.da <= mese);
  }
  // Budget del mese dopo le coperture (il totale tra le buste non cambia).
  function bustaBudget(bud, b, mese) {
    let v = bustaImporto(b, mese);
    for (const x of bud.spostamenti) {
      if (x.mese !== mese) continue;
      if (x.a === b.id) v += Number(x.importo);
      if (x.da === b.id) v -= Number(x.importo);
    }
    return r2(v);
  }
  const isUscita = (o) => o.conto === "comune" || o.tipo === "uscita";
  // Speso nella busta nel mese (importo intero dell'operazione, annullate escluse).
  function bustaSpeso(ops, b, mese) {
    let s = 0;
    for (const o of ops) if (!o.annullata && o.busta_id === b.id && isUscita(o) && monthOf(o.data) === mese) s = r2(s + Number(o.importo));
    return s;
  }
  // Stato di una busta di spesa: ok / warn (dal 90%) / over (oltre il budget).
  function statoBusta(bud, ops, b, mese) {
    const budget = bustaBudget(bud, b, mese), speso = b.tipo === "spesa" ? bustaSpeso(ops, b, mese) : 0;
    const over = r2(Math.max(0, speso - budget)), residuo = r2(Math.max(0, budget - speso));
    const stato = over > 0 ? "over" : budget > 0 && speso >= budget * 0.9 ? "warn" : "ok";
    return { budget, speso, residuo, over, effettivo: r2(Math.max(budget, speso)), stato, libero: r2(budget - speso) };
  }
  // Questa spesa (nuova, o la modifica di editId) manderebbe la busta oltre il budget?
  function checkSpesa(bud, ops, bustaId, mese, importo, editId) {
    const b = bud.buste.find((x) => x.id === bustaId);
    if (!b || b.tipo !== "spesa") return { over: 0, budget: 0, speso: 0 };
    const rest = ops.filter((o) => o.id !== editId);
    const budget = bustaBudget(bud, b, mese), speso = r2(bustaSpeso(rest, b, mese) + Number(importo));
    return { budget, speso, over: r2(Math.max(0, speso - budget)) };
  }

  // Pianificazione di un mese per un conto ("c1" | "c2" | "tot").
  // Da assegnare = entrate del mese - buste (spesa al massimo tra budget e speso, accumulo) - uscite senza busta.
  function monthPlan(bud, ops, mese, conto) {
    const eff = (o) => { const p = parts(o); return conto === "tot" ? p.c1 + p.c2 : p[conto]; };
    const byId = new Map(bud.buste.map((b) => [b.id, b]));
    let entrate = 0, senza = 0;
    for (const o of ops) {
      if (o.annullata || monthOf(o.data) !== mese) continue;
      const v = r2(eff(o));
      if (v > 0) entrate = r2(entrate + v);
      else if (v < 0 && !byId.has(o.busta_id)) senza = r2(senza - v);
    }
    const righe = [];
    for (const b of bud.buste) {
      const st = statoBusta(bud, ops, b, mese);
      if (!bustaAttiva(b, mese) && st.budget === 0 && st.speso === 0) continue;
      const peso = b.tipo === "spesa" ? st.effettivo : st.budget;
      righe.push({ busta: b, ...st, quota: share(peso, b.conto, conto), quotaResiduo: b.tipo === "spesa" ? share(st.residuo, b.conto, conto) : 0 });
    }
    const assegnato = r2(righe.reduce((s, r) => s + r.quota, 0));
    const residuo = r2(righe.reduce((s, r) => s + r.quotaResiduo, 0));
    return { mese, conto, entrate, senza, righe, assegnato, residuo, daAssegnare: r2(entrate - assegnato - senza) };
  }

  // Saldo previsto a fine mese: saldo dopo tutte le operazioni del mese, meno quanto resta da spendere nelle buste
  // di spesa (equivale a "saldo a inizio mese + entrate - budget interi", senza contare due volte il già speso).
  // I mesi già chiusi non hanno residui. Le buste di accumulo non sono uscite: i soldi restano nel conto.
  function previsto(bud, ops, entries, cfg, mese, conto, today) {
    const pk = (b) => (conto === "tot" ? r2(b.c1 + b.c2) : b[conto]);
    const finale = pk(balanceAt(entries, cfg, lastDay(mese)));
    const inizio = pk(balanceAt(entries, cfg, lastDay(addMonth(mese, -1))));
    const plan = monthPlan(bud, ops, mese, conto);
    const residuo = mese >= monthOf(today) ? plan.residuo : 0;
    return { inizio, finale, residuo, previsto: r2(finale - residuo), plan };
  }

  // Saldo di un fondo: iniziale + accumuli dei mesi chiusi - spese pagate dal fondo (fino a oggi).
  // `inArrivo` è l'accumulo del mese in corso, già messo da parte ma non ancora versato.
  function fondoSaldo(bud, fondo, ops, today) {
    const cur = monthOf(today);
    let versato = 0, inArrivo = 0;
    for (const b of bud.buste) {
      if (b.tipo !== "accumulo" || b.fondo !== fondo.id) continue;
      const first = (b.steps || []).reduce((m, s) => (m === null || s.da < m ? s.da : m), null);
      if (first === null) continue;
      for (let m = first, n = 0; m < cur && n < 240; m = addMonth(m, 1), n++) versato = r2(versato + bustaBudget(bud, b, m));
      if (bustaAttiva(b, cur)) inArrivo = r2(inArrivo + bustaBudget(bud, b, cur));
    }
    let prelevato = 0;
    const fromFondo = new Set(bud.buste.filter((b) => b.tipo === "spesa" && b.fondo === fondo.id).map((b) => b.id));
    for (const o of ops) if (!o.annullata && fromFondo.has(o.busta_id) && isUscita(o) && o.data <= today) prelevato = r2(prelevato + Number(o.importo));
    return { saldo: r2(Number(fondo.iniziale || 0) + versato - prelevato), versato, prelevato, inArrivo };
  }
  // Soldi del conto non vincolati: saldo di oggi - fondi - accumulo del mese già messo da parte.
  function libero(bud, ops, entries, cfg, conto, today) {
    const now = balanceAt(entries, cfg, today);
    const reale = conto === "tot" ? r2(now.c1 + now.c2) : now[conto];
    let vincolato = 0;
    for (const f of bud.fondi) {
      if (conto !== "tot" && f.conto !== conto) continue;
      const s = fondoSaldo(bud, f, ops, today);
      vincolato = r2(vincolato + s.saldo + s.inArrivo);
    }
    return { reale, vincolato, libero: r2(reale - vincolato) };
  }

  // ---------- Riconciliazione col saldo della banca ----------
  // Confronta il saldo che la banca mostra (banca) con quello calcolato dall'app alla data indicata.
  // diff > 0: alla banca c'è di più (manca un'entrata o c'è un'uscita in più); diff < 0: il contrario.
  function reconcile(entries, cfg, conto, data, banca) {
    const calcolato = balanceAt(entries, cfg, data)[conto];
    const diff = r2(Number(banca) - calcolato);
    return { calcolato, diff, tipo: diff > 0 ? "entrata" : "uscita", importo: Math.abs(diff) };
  }
  // Stato dell'ultima verifica di un conto: null se mai fatta. "vecchia" dopo 14 giorni o se restava una differenza.
  function verifyStatus(list, today) {
    if (!Array.isArray(list) || !list.length) return null;
    const last = list[list.length - 1];
    const days = Math.max(0, dayNum(today) - dayNum(last.data));
    const aperta = Number(last.diff) !== 0 && !last.rettifica;
    return { data: last.data, days, aperta, stale: aperta || days > 14 };
  }

  // ---------- Spese per categoria ----------
  // entries: righe di compute().entries (annullate escluse). conto: "c1" | "c2" | "tot".
  // Le uscite comuni pesano per la quota del conto (metà), come nei saldi.
  function categorySummary(entries, conto, from, to) {
    const eff = (e) => (conto === "tot" ? e.p.c1 + e.p.c2 : e.p[conto]);
    const map = new Map();
    let uscite = 0, entrate = 0;
    for (const e of entries) {
      if (e.o.data < from || e.o.data > to) continue;
      const v = r2(eff(e));
      if (v === 0) continue;
      if (v > 0) { entrate = r2(entrate + v); continue; }
      const k = e.o.categoria || "Senza categoria";
      const m = map.get(k) || { cat: k, tot: 0, n: 0 };
      m.tot = r2(m.tot - v); m.n += 1; map.set(k, m);
      uscite = r2(uscite - v);
    }
    const rows = [...map.values()].sort((a, b) => b.tot - a.tot || a.cat.localeCompare(b.cat, "it"));
    return { uscite, entrate, rows };
  }

  // ---------- Grafici (geometria pura, nessun DOM) ----------
  const dayNum = (s) => { const [y, m, d] = ymd(s); return Date.UTC(y, m - 1, d) / 86400000; };

  // Serie a fine mese (più il punto di oggi) di una grandezza f(data) -> numero
  function monthlySeries(startDate, endDate, today, f) {
    const dates = new Set([startDate]);
    const lastEnd = monthEndPlus(endDate, 0);
    for (let cur = monthEndPlus(startDate, 0); cur <= lastEnd; cur = monthEndPlus(cur, 1)) dates.add(cur);
    if (today >= startDate && today <= lastEnd) dates.add(today);
    return [...dates].sort().map((d) => ({ d, v: f(d), today: d === today }));
  }

  // Percorsi SVG di una mini-linea: tratto passato (fino a oggi), tratto futuro, area sotto il passato
  function sparkGeometry(points, w, h, padX, padY) {
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi === lo) { hi += 1; lo -= 1; }
    const x0 = dayNum(points[0].d), x1 = dayNum(points[points.length - 1].d);
    const X = (d) => padX + ((dayNum(d) - x0) / ((x1 - x0) || 1)) * (w - 2 * padX);
    const Y = (v) => h - padY - ((v - lo) / (hi - lo)) * (h - 2 * padY);
    const P = points.map((p) => ({ x: X(p.d), y: Y(p.v), d: p.d, v: p.v, today: !!p.today }));
    const ti = P.findIndex((p) => p.today);
    const past = ti < 0 ? P : P.slice(0, ti + 1), fut = ti < 0 ? [] : P.slice(ti);
    const path = (arr) => arr.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const base = (h - padY).toFixed(1);
    const area = past.length > 1 ? `${path(past)} L${past[past.length - 1].x.toFixed(1)} ${base} L${past[0].x.toFixed(1)} ${base} Z` : "";
    return { past: path(past), fut: fut.length > 1 ? path(fut) : "", area, today: ti >= 0 ? P[ti] : null, pts: P, lo, hi };
  }

  // Valori "tondi" per gli assi
  function niceTicks(lo, hi, n) {
    n = n || 4;
    if (hi === lo) { hi += 1; lo -= 1; }
    const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = a; v <= b + step / 2; v += step) ticks.push(r2(v));
    return { ticks, min: a, max: b, step };
  }

  const api = { r2, parts, cmp, compute, parseImporto, monthEndPlus, occurrences, horizon, generationDates, nextDates, ruleRow, freqText, expandVoce, balanceAt, simulate, monthImpact, reconcile, verifyStatus, emptyBudget, normBudget, share, bustaImporto, bustaAttiva, bustaBudget, bustaSpeso, statoBusta, checkSpesa, monthPlan, previsto, fondoSaldo, libero, categorySummary, dayNum, monthlySeries, sparkGeometry, niceTicks };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
