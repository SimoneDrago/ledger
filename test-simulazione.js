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
