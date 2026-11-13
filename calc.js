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

  const api = { r2, parts, cmp, compute, parseImporto, monthEndPlus, occurrences, horizon, generationDates, nextDates, ruleRow, freqText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
