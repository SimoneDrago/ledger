// Test della geometria dei grafici: node test-grafici.js (dati generici)
const assert = require("assert");
const C = require("./calc.js");

// giorni
assert.strictEqual(C.dayNum("2026-03-01") - C.dayNum("2026-02-01"), 28);
assert.strictEqual(C.dayNum("2028-03-01") - C.dayNum("2028-02-01"), 29);

// serie mensile: inizio, fine mese di ogni mese, oggi
const pts = C.monthlySeries("2026-01-15", "2026-04-10", "2026-03-20", (d) => d.length);
assert.deepStrictEqual(pts.map((p) => p.d), ["2026-01-15", "2026-01-31", "2026-02-28", "2026-03-20", "2026-03-31", "2026-04-30"]);
assert.deepStrictEqual(pts.filter((p) => p.today).map((p) => p.d), ["2026-03-20"]);
// oggi fuori dall'intervallo: nessun punto "oggi"
assert.strictEqual(C.monthlySeries("2026-01-01", "2026-02-10", "2030-01-01", () => 1).some((p) => p.today), false);
// oggi coincide con una fine mese: un solo punto, segnato oggi
const same = C.monthlySeries("2026-01-01", "2026-02-10", "2026-01-31", () => 1);
assert.strictEqual(same.filter((p) => p.d === "2026-01-31").length, 1);
assert.strictEqual(same.find((p) => p.d === "2026-01-31").today, true);

// geometria: tutto dentro il riquadro, tratto passato e futuro si toccano in "oggi"
const vals = { "2026-01-01": 100, "2026-01-31": 400, "2026-02-28": 250, "2026-03-31": 900, "2026-04-30": 50 };
const series = C.monthlySeries("2026-01-01", "2026-04-10", "2026-02-10", (d) => (vals[d] !== undefined ? vals[d] : 300));
const g = C.sparkGeometry(series, 100, 34, 2, 4);
for (const p of g.pts) {
  assert.ok(p.x >= 2 - 1e-9 && p.x <= 98 + 1e-9, "x " + p.x);
  assert.ok(p.y >= 4 - 1e-9 && p.y <= 30 + 1e-9, "y " + p.y);
}
assert.ok(g.today && g.past.startsWith("M") && g.fut.startsWith("M") && g.area.endsWith("Z"));
assert.strictEqual(Math.min(...g.pts.map((p) => p.v)), 50);
assert.ok(g.pts.find((p) => p.v === 900).y < g.pts.find((p) => p.v === 50).y, "il valore più alto sta più in alto");
// serie piatta: nessuna divisione per zero
const flat = C.sparkGeometry(C.monthlySeries("2026-01-01", "2026-03-01", "2026-02-01", () => 500), 100, 34, 2, 4);
assert.ok(flat.pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
// oggi dopo l'ultimo punto: nessun tratto futuro
const allPast = C.sparkGeometry(C.monthlySeries("2026-01-01", "2026-02-01", "2026-02-28", (d) => d.length), 100, 34, 2, 4);
assert.strictEqual(allPast.fut, "");

// assi
for (const [lo, hi] of [[0, 9500], [-300, 12500], [7409.91, 7410.5], [5000, 5000], [-1000, -10]]) {
  const t = C.niceTicks(lo, hi, 4);
  assert.ok(t.min <= lo && t.max >= hi, `${lo}-${hi}`);
  assert.ok(t.ticks.length >= 2 && t.ticks.every((v, i, a) => i === 0 || v > a[i - 1]));
  assert.strictEqual(t.ticks[0], Math.round(t.min * 100) / 100);
}
console.log("ok: grafici");
