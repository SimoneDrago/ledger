// Test dei calcoli del calendario. node test-planning.js
const assert = require("assert");
const P = require("./plan-calc.js");

// Pasqua: date note
assert.deepStrictEqual(P.pasqua(2024), [2, 31]); assert.deepStrictEqual(P.pasqua(2025), [3, 20]); assert.deepStrictEqual(P.pasqua(2026), [3, 5]);
const f26 = P.festivi(2026);
assert.strictEqual(f26["2026-04-06"], "Lunedì dell'Angelo");
assert.strictEqual(f26["2026-12-25"], "Natale"); assert.strictEqual(Object.keys(f26).length, 12);
console.log("ok: pasqua e festività");

// griglia: novembre 2026 inizia di domenica → 6 settimane? (1 nov = domenica)
const g = P.monthGrid(2026, 10);
assert.ok(g.every((w) => w.length === 7));
assert.strictEqual(g[0][6].iso, "2026-11-01"); assert.strictEqual(g[0][6].dentro, true); assert.strictEqual(g[0][0].dentro, false);
assert.ok(g[0][6].weekend && g[0][6].festivo === "Ognissanti" && !g[0][6].lavorativo);
const ult = g[g.length - 1]; assert.strictEqual(ult[ult.length - 1].iso >= "2026-11-30", true);
assert.strictEqual(g.flat().filter((c) => c.dentro).length, 30);
// febbraio 2027 (inizia lunedì, 28 giorni) = 4 settimane esatte
assert.strictEqual(P.monthGrid(2027, 1).length, 4);
// gennaio: le celle di dicembre dell'anno prima conoscono le proprie festività
const gen = P.monthGrid(2027, 0); assert.strictEqual(gen[0].find((c) => c.iso === "2026-12-31").dentro, false);
assert.ok(P.monthGrid(2026, 11).flat().find((c) => c.iso === "2027-01-01").festivo === "Capodanno");
console.log("ok: griglia mese");

assert.ok(P.lavorativo("2026-11-03")); assert.ok(!P.lavorativo("2026-11-01")); assert.ok(!P.lavorativo("2026-11-07")); assert.ok(!P.lavorativo("2026-12-08"));
assert.strictEqual(P.parseOre("1,5"), 1.5); assert.ok(Number.isNaN(P.parseOre("abc"))); assert.ok(Number.isNaN(P.parseOre("-1"))); assert.strictEqual(P.parseOre(""), 0);
assert.strictEqual(P.fmtOre(7.5), "7,5 h"); assert.strictEqual(P.fmtGiorni(16, 8), "2 giorni"); assert.strictEqual(P.fmtGiorni(8, 8), "1 giorno");
console.log("ok: giorni lavorativi e formati");

// riepilogo banca
const pers = { id: "p1", ore_giorno: 8 };
const voci = [
  { persona_id: "p1", data: "2026-03-02", tipo: "ferie", ore: 8 }, { persona_id: "p1", data: "2026-03-03", tipo: "ferie", ore: 4 },
  { persona_id: "p1", data: "2026-03-04", tipo: "permessi", ore: 2.5 }, { persona_id: "p1", data: "2025-03-04", tipo: "ferie", ore: 8 },
  { persona_id: "p2", data: "2026-03-04", tipo: "ferie", ore: 8 },
];
const r = P.riepilogo({ ferie_ore: 160, permessi_ore: 2 }, voci, pers, 2026);
assert.strictEqual(r.ferie.usate, 12); assert.strictEqual(r.ferie.residuo, 148); assert.strictEqual(r.ferie.giorniUsati, 1.5); assert.strictEqual(r.ferie.oltre, false);
assert.strictEqual(r.permessi.usate, 2.5); assert.strictEqual(r.permessi.residuo, -0.5); assert.strictEqual(r.permessi.oltre, true); assert.strictEqual(r.permessi.perc, 100);
assert.strictEqual(P.riepilogo(null, voci, pers, 2026).configurata, false);
assert.strictEqual(P.riepilogo(null, [], pers, 2026).ferie.perc, 0);
console.log("ok: banca ore");

// strumenti
const gg = P.perGiorno(voci, "p1"); assert.deepStrictEqual(gg["2026-03-03"], { ferie: 4 });
assert.deepStrictEqual(P.applica({}, { tipo: "ferie", ore: 8 }, 8, "2026-11-03"), { op: "set", data: "2026-11-03", tipo: "ferie", ore: 8 });
assert.strictEqual(P.applica({ ferie: 8 }, { tipo: "ferie", ore: 8 }, 8, "2026-11-03").op, "del");           // stesso valore: toglie
assert.strictEqual(P.applica({ ferie: 4 }, { tipo: "ferie", ore: 8 }, 8, "2026-11-03").op, "set");           // valore diverso: sostituisce
assert.ok(P.applica({}, { tipo: "ferie", ore: 8 }, 8, "2026-11-01").errore);                                   // domenica
assert.ok(P.applica({}, { tipo: "ferie", ore: 8 }, 8, "2026-12-08").errore);                                   // festivo
assert.ok(P.applica({}, { tipo: "permessi", ore: 9 }, 8, "2026-11-03").errore);                                // più delle ore del giorno
assert.ok(P.applica({}, { tipo: "permessi", ore: 0 }, 8, "2026-11-03").errore);
assert.ok(P.applica({ ferie: 4 }, { tipo: "permessi", ore: 5 }, 8, "2026-11-03").errore);                      // 4+5 > 8
assert.strictEqual(P.applica({ ferie: 4 }, { tipo: "permessi", ore: 4 }, 8, "2026-11-03").op, "set");          // 4+4 = 8 ok
const gom = P.applica({ ferie: 4, permessi: 2 }, { tipo: "gomma" }, 8, "2026-11-03"); assert.strictEqual(gom.azioni.length, 2);
assert.strictEqual(P.applica({}, { tipo: "gomma" }, 8, "2026-11-03").op, "none");
assert.strictEqual(P.applica({ ferie: 8 }, { tipo: "gomma" }, 8, "2026-11-01").op, "multi");                   // la gomma funziona anche su giorni non lavorativi
console.log("ok: strumenti del calendario");
