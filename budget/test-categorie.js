// Test del riepilogo per categoria e del saldo di oggi: node test-categorie.js (dati generici)
const assert = require("assert");
const C = require("./calc.js");
const cfg = { c1: { iniziale: 1000 }, c2: { iniziale: 500 }, dataInizio: "2026-01-01" };
const op = (id, data, conto, tipo, importo, categoria) => ({ id, data, voce: id, conto, tipo, importo, categoria, ordine: 0 });
const { entries } = C.compute(cfg, [
  op("a", "2026-03-01", "c1", "entrata", 2000, "Stipendio"),
  op("b", "2026-03-05", "c1", "uscita", 100, "Spesa"),
  op("c", "2026-03-06", "c2", "uscita", 40, "Spesa"),
  op("d", "2026-03-10", "comune", "uscita", 3.75, "Abbonamenti"),
  op("e", "2026-03-11", "comune", "uscita", 200, null),
  op("f", "2026-04-02", "c1", "uscita", 60, "Spesa"),
  { ...op("g", "2026-03-12", "c1", "uscita", 999, "Auto"), annullata: true },
]);
const mar = ["2026-03-01", "2026-03-31"];
// conto 1: spesa 100, abbonamenti 1,88 (metà arrotondata), senza categoria 100
const c1 = C.categorySummary(entries, "c1", ...mar);
assert.deepStrictEqual(c1.rows.map((r) => [r.cat, r.tot, r.n]), [["Senza categoria", 100, 1], ["Spesa", 100, 1], ["Abbonamenti", 1.88, 1]].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "it")));
assert.strictEqual(c1.uscite, 201.88);
assert.strictEqual(c1.entrate, 2000);
// conto 2: quota 1,87 e 100 della comune
const c2 = C.categorySummary(entries, "c2", ...mar);
assert.strictEqual(c2.uscite, 40 + 1.87 + 100);
// entrambi: la comune pesa per intero
const tot = C.categorySummary(entries, "tot", ...mar);
assert.strictEqual(tot.uscite, 100 + 40 + 3.75 + 200);
assert.strictEqual(tot.rows.find((r) => r.cat === "Abbonamenti").tot, 3.75);
// le annullate non compaiono (non sono in entries) e il periodo filtra
assert.ok(!tot.rows.some((r) => r.cat === "Auto"));
assert.strictEqual(C.categorySummary(entries, "tot", "2026-04-01", "2026-04-30").uscite, 60);
assert.strictEqual(C.categorySummary(entries, "tot", "0000-01-01", "9999-12-31").uscite, 343.75 + 60);
assert.deepStrictEqual(C.categorySummary(entries, "tot", "2027-01-01", "2027-01-31").rows, []);
// saldo di oggi: solo le operazioni fino a quella data
const at = (d) => C.balanceAt(entries, cfg, d);
assert.deepStrictEqual(at("2026-02-01"), { c1: 1000, c2: 500 });
assert.strictEqual(at("2026-03-05").c1, 1000 + 2000 - 100);
assert.strictEqual(at("2026-03-31").c1, 1000 + 2000 - 100 - 1.88 - 100);
assert.strictEqual(at("2026-12-31").c1, 1000 + 2000 - 100 - 1.88 - 100 - 60);
console.log("ok: categorie e saldo di oggi");
