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
    if (!simOps.length) return { rows: [], goal: null, simCount: 0, goalDef: goal, real, sim };
    // orizzonte: ultima data reale, obiettivo, voci una tantum, e 12 mesi dalla prima data delle voci periodiche
    const cand = [];
    if (real.entries.length) cand.push(real.entries[real.entries.length - 1].o.data);
    if (goal) cand.push(goal.data);
    for (const v of voci) cand.push(Number(v.ogni_mesi) > 0 ? monthEndPlus(v.data, 11) : v.data);
    const endDate = monthEndPlus(cand.reduce((a, b) => (a > b ? a : b)), 0);
    const first = simOps.reduce((a, o) => (o.data < a ? o.data : a), simOps[0].data);
    const rows = [];
    for (let cur = monthEndPlus(first, -1); cur <= endDate; cur = monthEndPlus(cur, 1)) {
      rows.push({ mese: cur.slice(0, 7), real: balanceAt(real.entries, cfg, cur), sim: balanceAt(sim.entries, cfg, cur) });
    }
    let res = null;
    if (goal) {
      const s = pick(goal.conto, balanceAt(sim.entries, cfg, goal.data)), r = pick(goal.conto, balanceAt(real.entries, cfg, goal.data));
      const margine = r2(s - goal.minimo);
      res = { saldoSim: s, saldoReale: r, margine, ok: margine >= 0 };
    }
    return { rows, goal: res, goalDef: goal, simCount: simOps.length, endDate, minSim: minPoint(sim.entries, cfg, endDate), minReal: minPoint(real.entries, cfg, endDate), real, sim };
  }

  const api = { r2, parts, cmp, compute, parseImporto, monthEndPlus, occurrences, horizon, generationDates, nextDates, ruleRow, freqText, expandVoce, balanceAt, simulate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
