// Test della logica delle ricorrenze: node test-ricorrenze.js (dati generici, nessun dato personale)
const assert = require("assert");
const C = require("./calc.js");
const rule = (o) => ({ id: "r1", voce: "Abbonamento", conto: "comune", tipo: "uscita", importo: 13, categoria: "Abbonamenti", ogni_mesi: 1, giorno: 31, data_inizio: "2026-11-30", data_fine: null, attiva: true, ...o });
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

// mensile il 31 dal 30/11/2026 (mese corto -> ultimo giorno)
eq(C.occurrences(rule({}), "0000-01-01", "2027-03-31"),
  ["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"]);
// anno bisestile
eq(C.occurrences(rule({ data_inizio: "2028-01-31" }), "0000-01-01", "2028-03-31"), ["2028-01-31", "2028-02-29", "2028-03-31"]);
// aprile = 30
eq(C.occurrences(rule({ data_inizio: "2027-03-31" }), "0000-01-01", "2027-05-31"), ["2027-03-31", "2027-04-30", "2027-05-31"]);
// semestrale il 15 dal 15/02/2027
eq(C.occurrences(rule({ ogni_mesi: 6, giorno: 15, data_inizio: "2027-02-15" }), "0000-01-01", "2028-03-01"),
  ["2027-02-15", "2027-08-15", "2028-02-15"]);
// annuale a cavallo d'anno
eq(C.occurrences(rule({ ogni_mesi: 12, giorno: 31, data_inizio: "2026-12-31" }), "0000-01-01", "2029-01-01"),
  ["2026-12-31", "2027-12-31", "2028-12-31"]);
// il giorno è prima della data_inizio nello stesso mese: la prima occorrenza è il mese dopo
eq(C.occurrences(rule({ giorno: 5, data_inizio: "2026-11-20" }), "0000-01-01", "2027-01-31"), ["2026-12-05", "2027-01-05"]);
// data_fine rispettata dall'orizzonte
eq(C.horizon(rule({ data_fine: "2027-01-10" }), "2026-11-13"), "2027-01-10");
eq(C.horizon(rule({}), "2026-11-13"), "2027-11-30"); // fine del 12° mese dopo oggi
eq(C.horizon(rule({}), "2026-12-20"), "2027-12-31");
// generazione: da data_inizio se non esistono righe, da oggi se esistono
const g1 = C.generationDates(rule({ data_inizio: "2026-09-30", giorno: 30 }), "2026-11-13", false);
assert.strictEqual(g1[0], "2026-09-30");
const g2 = C.generationDates(rule({ data_inizio: "2026-09-30", giorno: 30 }), "2026-11-13", true);
assert.strictEqual(g2[0], "2026-11-30");
assert.strictEqual(g2[g2.length - 1], "2027-11-30");
// prossime date
eq(C.nextDates(rule({}), "2026-12-01", 3), ["2026-12-31", "2027-01-31", "2027-02-28"]);
eq(C.nextDates(rule({ data_fine: "2027-01-31" }), "2026-12-01", 5), ["2026-12-31", "2027-01-31"]);
// riga generata: id deterministico
const row = C.ruleRow(rule({}), "2026-12-31");
assert.strictEqual(row.id, "r1_2026-12-31");
assert.strictEqual(row.data, row.data_prevista);
assert.strictEqual(row.modificata, false);
assert.strictEqual(row.annullata, false);
// uscita comune da 3,75 €: -1,88 su c1 e -1,87 su c2 ogni mese
const cfg = { c1: { iniziale: 0 }, c2: { iniziale: 0 } };
const ops = C.occurrences(rule({ importo: 3.75 }), "0000-01-01", "2027-02-28").map((d) => C.ruleRow(rule({ importo: 3.75 }), d));
const res = C.compute(cfg, ops);
eq(res.entries.map((e) => [e.p.c1, e.p.c2]), [[-1.88, -1.87], [-1.88, -1.87], [-1.88, -1.87], [-1.88, -1.87]]);
// un'operazione annullata non pesa sui saldi
ops[1].annullata = true;
const res2 = C.compute(cfg, ops);
assert.strictEqual(res2.entries.length, 3);
assert.strictEqual(res2.cur.c1, -5.64);
assert.strictEqual(res2.cur.c2, -5.61);
// frequenza in parole
eq(C.freqText(rule({})), "ogni mese il 31");
eq(C.freqText(rule({ ogni_mesi: 6, giorno: 15 })), "ogni 6 mesi il 15");
eq(C.freqText(rule({ ogni_mesi: 12, giorno: 31, data_inizio: "2026-12-31" })), "ogni anno il 31 dicembre");
eq(C.freqText(rule({ ogni_mesi: 24, giorno: 1, data_inizio: "2027-03-01" })), "ogni 2 anni il 1 marzo");
console.log("ok: ricorrenze");
