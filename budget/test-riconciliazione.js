// Test della riconciliazione col saldo della banca: node test-riconciliazione.js (importi inventati)
const assert = require("assert");
const C = require("./calc.js");
const cfg = { c1: { iniziale: 1000 }, c2: { iniziale: 500 }, dataInizio: "2026-01-01" };
const op = (id, data, conto, tipo, importo) => ({ id, data, voce: id, conto, tipo, importo, ordine: 0 });
const ops = [op("a", "2026-01-10", "c1", "entrata", 200), op("b", "2026-01-20", "c1", "uscita", 50), op("c", "2026-02-05", "comune", "uscita", 100), { ...op("x", "2026-01-15", "c1", "uscita", 999), annullata: true }];
const { entries } = C.compute(cfg, ops);

// saldo calcolato e differenza
let r = C.reconcile(entries, cfg, "c1", "2026-01-31", 1150);
assert.deepStrictEqual([r.calcolato, r.diff], [1150, 0]);
r = C.reconcile(entries, cfg, "c1", "2026-01-31", 1127.5);
assert.deepStrictEqual([r.calcolato, r.diff, r.tipo, r.importo], [1150, -22.5, "uscita", 22.5]);
r = C.reconcile(entries, cfg, "c1", "2026-01-31", 1200);
assert.deepStrictEqual([r.diff, r.tipo, r.importo], [50, "entrata", 50]);
// la data conta: il 5 febbraio entra la metà della spesa comune
assert.strictEqual(C.reconcile(entries, cfg, "c1", "2026-02-05", 1100).diff, 0);
assert.strictEqual(C.reconcile(entries, cfg, "c2", "2026-02-05", 450).diff, 0);
// prima della data di partenza vale il saldo iniziale; le operazioni annullate non contano
assert.strictEqual(C.reconcile(entries, cfg, "c2", "2025-12-31", 500).diff, 0);
assert.strictEqual(C.reconcile(entries, cfg, "c1", "2026-01-31", 1150 - 999).diff, -999); // calcolato 1150: la spesa annullata non entra
// saldo negativo alla banca
assert.strictEqual(C.reconcile(entries, cfg, "c2", "2026-01-31", -20).diff, -520);
// centesimi senza errori di virgola mobile
assert.strictEqual(C.reconcile(entries, { ...cfg, c1: { iniziale: 0.1 } }, "c1", "2026-01-01", 0.3).diff, 0.2);

// una rettifica registrata allinea il conto alla banca nello stesso giorno
const diff = C.reconcile(entries, cfg, "c1", "2026-01-31", 1127.5);
const dopo = C.compute(cfg, ops.concat([op("r", "2026-01-31", "c1", diff.tipo, diff.importo)])).entries;
assert.strictEqual(C.reconcile(dopo, cfg, "c1", "2026-01-31", 1127.5).diff, 0);

// stato dell'ultima verifica
assert.strictEqual(C.verifyStatus([], "2026-03-01"), null);
assert.strictEqual(C.verifyStatus(undefined, "2026-03-01"), null);
let s = C.verifyStatus([{ data: "2026-02-20", diff: 0 }], "2026-03-01");
assert.deepStrictEqual([s.days, s.aperta, s.stale], [9, false, false]);
s = C.verifyStatus([{ data: "2026-01-20", diff: 0 }], "2026-03-01");
assert.deepStrictEqual([s.days, s.stale], [40, true]); // oltre 14 giorni
s = C.verifyStatus([{ data: "2026-02-28", diff: -5, rettifica: false }], "2026-03-01");
assert.deepStrictEqual([s.aperta, s.stale], [true, true]); // differenza non registrata
s = C.verifyStatus([{ data: "2026-02-28", diff: -5, rettifica: true }], "2026-03-01");
assert.deepStrictEqual([s.aperta, s.stale], [false, false]); // rettificata
s = C.verifyStatus([{ data: "2026-01-01", diff: 3, rettifica: false }, { data: "2026-03-01", diff: 0 }], "2026-03-01");
assert.deepStrictEqual([s.days, s.aperta], [0, false]); // conta l'ultima
console.log("ok: riconciliazione");

// nessun id ripetuto in index.html (un id doppio fa leggere all'app l'elemento sbagliato)
{
  const html = require("fs").readFileSync(__dirname + "/index.html", "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepStrictEqual(dup, [], "id ripetuti: " + dup.join(", "));
}
console.log("ok: id unici");
