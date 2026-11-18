// Test della simulazione: node test-simulazione.js (dati generici, nessun dato personale)
const assert = require("assert");
const C = require("./calc.js");
const cfg = { c1: { iniziale: 10000 }, c2: { iniziale: 5000 }, dataInizio: "2026-01-01" };
const op = (id, data, conto, tipo, importo) => ({ id, data, voce: id, conto, tipo, importo, ordine: 0 });
const ops = [op("a", "2026-01-31", "c1", "entrata", 2000), op("b", "2026-02-28", "c2", "entrata", 1500), op("c", "2026-02-28", "comune", "uscita", 100)];
const v = (o) => ({ id: "v1", voce: "X", conto: "comune", tipo: "uscita", importo: 1000, data: "2026-03-10", ogni_mesi: 0, volte: 1, attiva: true, ...o });

// espansione
assert.deepStrictEqual(C.expandVoce(v({})).map((o) => o.data), ["2026-03-10"]);
assert.deepStrictEqual(C.expandVoce(v({ ogni_mesi: 1, volte: 4, data: "2026-01-31" })).map((o) => o.data), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
assert.deepStrictEqual(C.expandVoce(v({ ogni_mesi: 6, volte: 3 })).map((o) => o.data), ["2026-03-10", "2026-09-10", "2027-03-10"]);
assert.strictEqual(C.expandVoce(v({ ogni_mesi: 1, volte: 240 })).length, 240);
assert.strictEqual(C.expandVoce(v({ conto: "comune", tipo: "entrata" }))[0].tipo, "uscita"); // comune: sempre uscita

// la simulazione non modifica i dati reali
const before = JSON.stringify(ops);
const sc = { voci: [v({})], obiettivo: { conto: "c1", data: "2026-03-31", minimo: 9000 } };
const r = C.simulate(cfg, ops, sc);
assert.strictEqual(JSON.stringify(ops), before);
// reale c1: 10000 + 2000 - 50 = 11950; scenario: -500 -> 11450
assert.strictEqual(r.goal.saldoReale, 11950);
assert.strictEqual(r.goal.saldoSim, 11450);
assert.strictEqual(r.goal.margine, 2450);
assert.strictEqual(r.goal.ok, true);
// obiettivo non raggiunto
const r2_ = C.simulate(cfg, ops, { ...sc, obiettivo: { conto: "c1", data: "2026-03-31", minimo: 12000 } });
assert.strictEqual(r2_.goal.ok, false);
assert.strictEqual(r2_.goal.margine, -550);
// conti insieme
const rt = C.simulate(cfg, ops, { ...sc, obiettivo: { conto: "tot", data: "2026-03-31", minimo: 0 } });
assert.strictEqual(rt.goal.saldoSim, 11450 + (5000 + 1500 - 50 - 500));
// voce spenta = come il reale
const off = C.simulate(cfg, ops, { voci: [v({ attiva: false })], obiettivo: sc.obiettivo });
assert.strictEqual(off.simCount, 0);
assert.strictEqual(off.rows.length, 0);
// righe mensili: partono dal mese prima della prima voce, il reale non cambia mai
assert.strictEqual(r.rows[0].mese, "2026-02");
assert.deepStrictEqual(r.rows[0].real, r.rows[0].sim);
const m3 = r.rows.find((x) => x.mese === "2026-03");
assert.strictEqual(m3.real.c1, 11950); assert.strictEqual(m3.sim.c1, 11450);
// punto più basso
assert.strictEqual(r.minSim.c1.v, 10000);
const neg = C.simulate(cfg, ops, { voci: [v({ importo: 40000 })] });
assert.strictEqual(neg.minSim.c1.v, 11950 - 20000 + 0);
assert.strictEqual(neg.minSim.c1.d, "2026-03-10");
// mutuo lungo: l'orizzonte della tabella resta limitato (12 mesi dalla prima rata)
const mu = C.simulate(cfg, ops, { voci: [v({ importo: 850, ogni_mesi: 1, volte: 240, data: "2026-04-05" })] });
assert.ok(mu.rows.length <= 14, "righe: " + mu.rows.length);
assert.strictEqual(mu.simCount, 240);
// entrata una tantum su un conto
const en = C.simulate(cfg, ops, { voci: [v({ conto: "c2", tipo: "entrata", importo: 300 })], obiettivo: { conto: "c2", data: "2026-03-31", minimo: 0 } });
assert.strictEqual(en.goal.saldoSim, 5000 + 1500 - 50 + 300);
// obiettivo incompleto = ignorato
assert.strictEqual(C.simulate(cfg, ops, { voci: [v({})], obiettivo: { conto: "c1", data: "", minimo: 100 } }).goal, null);
assert.strictEqual(C.simulate(cfg, ops, { voci: [v({})] }).goal, null);
console.log("ok: simulazione");

// movimento mensile: spese reali registrate e voci dello scenario (importi inventati)
{
  const o2 = [op("e", "2026-03-02", "c1", "uscita", 40), op("f", "2026-03-20", "comune", "uscita", 100), op("g", "2026-03-25", "c1", "entrata", 500), { ...op("h", "2026-03-26", "c1", "uscita", 999), annullata: true }];
  const s2 = C.simulate(cfg, o2, { voci: [v({ conto: "c1", importo: 5000 })], obiettivo: { conto: "c1", data: "2026-05-31", minimo: 0 } });
  const mar = s2.rows.find((x) => x.mese === "2026-03");
  assert.deepStrictEqual(mar.spese, { c1: -90, c2: -50 }); // 40 + metà di 100; entrate e annullate escluse
  assert.deepStrictEqual(mar.voci, { c1: -5000, c2: 0 });
  const apr = s2.rows.find((x) => x.mese === "2026-04");
  assert.deepStrictEqual(apr.spese, { c1: 0, c2: 0 });
  assert.deepStrictEqual(apr.voci, { c1: 0, c2: 0 }); // la caparra non si ripete nei mesi dopo
  assert.strictEqual(apr.sim.c1, mar.sim.c1); // il saldo invece resta più basso
}
console.log("movimento mensile OK");

// ciambella: entrate e uscite del mese, reali e di scenario (importi inventati)
{
  const o3 = [
    { ...op("a1", "2026-03-02", "c1", "uscita", 40), categoria: "Spesa" }, { ...op("a2", "2026-03-09", "c1", "uscita", 10), categoria: "Spesa" },
    { ...op("a3", "2026-03-20", "comune", "uscita", 100), categoria: "Casa" }, op("a4", "2026-03-25", "c1", "entrata", 500),
    { ...op("a5", "2026-03-26", "c1", "uscita", 999), categoria: "Auto", annullata: true }, { ...op("a6", "2026-04-01", "c1", "uscita", 7), categoria: "Spesa" },
  ];
  const sc3 = { voci: [v({ voce: "Caparra", conto: "c1", importo: 5000 }), v({ id: "v2", voce: "Bonus", conto: "c1", tipo: "entrata", importo: 300 })], obiettivo: { conto: "c1", data: "2026-05-31", minimo: 0 } };
  const r3 = C.simulate(cfg, o3, sc3);
  const m = C.monthImpact(r3, "2026-03", "c1");
  assert.deepStrictEqual(m.uscite, { real: 100, sim: 5000 });
  assert.deepStrictEqual(m.entrate, { real: 500, sim: 300 });
  assert.deepStrictEqual(m.segs.map((s) => [s.label, s.kind, s.tot, s.n]), [["Casa", "real", 50, 1], ["Spesa", "real", 50, 2], ["Caparra", "sim", 5000, 1]]);
  const tot = C.monthImpact(r3, "2026-03", "tot");
  assert.strictEqual(tot.uscite.real, 150); // 40+10 + intera comune 100
  assert.deepStrictEqual(C.monthImpact(r3, "2026-04", "c1").uscite, { real: 7, sim: 0 });
  assert.deepStrictEqual(C.monthImpact(r3, "2026-12", "c1").segs, []);
  assert.strictEqual(JSON.stringify(o3).includes("sim_"), false);
}
console.log("ciambella OK");
