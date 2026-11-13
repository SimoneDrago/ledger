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

  // Saldi progressivi (spec §4.3)
  function compute(cfg, ops) {
    let b1 = Number(cfg.c1.iniziale), b2 = Number(cfg.c2.iniziale);
    const min = { c1: b1, c2: b2 };
    const entries = [...ops].sort(cmp).map((o) => {
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

  const api = { r2, parts, cmp, compute, parseImporto };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
