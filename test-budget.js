// Test di buste e fondi: node test-budget.js (importi inventati, nessun dato personale)
const assert = require("assert");
const C = require("./calc.js");

const cfg = { c1: { iniziale: 3000 }, c2: { iniziale: 1000 }, dataInizio: "2026-11-01" };
const today = "2026-11-15";
const mk = (id, data, conto, tipo, importo, extra) => ({ id, data, voce: id, conto, tipo, importo, ordine: 0, annullata: false, ...(extra || {}) });
const bud = C.normBudget({
  fondi: [{ id: "f1", nome: "Fondo A", conto: "c1", iniziale: 0 }],
  buste: [
    { id: "bs", nome: "Busta spesa", tipo: "spesa", conto: "c1", steps: [{ da: "2026-11", importo: 500 }] },
    { id: "ba", nome: "Busta accumulo", tipo: "accumulo", conto: "c1", fondo: "f1", steps: [{ da: "2026-09", importo: 150 }] },
  ],
});
// una busta sul conto comune, provata a parte (pesa per metà su ciascun conto)
const budC = C.normBudget({ buste: [{ id: "bc", nome: "Busta comune", tipo: "spesa", conto: "comune", steps: [{ da: "2026-11", importo: 301 }] }] });
const ops0 = [
  mk("stip", "2026-11-03", "c1", "entrata", 2000),
  mk("fissa", "2026-11-05", "c1", "uscita", 700, { busta_id: "bx" }), // busta inesistente = come senza busta
  mk("s1", "2026-11-08", "c1", "uscita", 120, { busta_id: "bs" }),
  mk("s2", "2026-11-12", "c1", "uscita", 80, { busta_id: "bs" }),
];
const calc = (ops) => C.compute(cfg, ops);

// normalizzazione e importi base
assert.deepStrictEqual(C.normBudget(null), C.emptyBudget());
assert.strictEqual(C.bustaImporto(bud.buste[0], "2026-10"), 0);
assert.strictEqual(C.bustaImporto(bud.buste[0], "2026-11"), 500);
assert.strictEqual(C.bustaAttiva(bud.buste[0], "2026-10"), false);
assert.strictEqual(C.bustaAttiva(bud.buste[0], "2027-03"), true);
// "da questo mese in poi" e fine
const b2 = { id: "b2", tipo: "spesa", conto: "c1", steps: [{ da: "2026-12", importo: 400 }, { da: "2026-11", importo: 300 }, { da: "2027-02", importo: 450 }], fine: "2027-04" };
assert.deepStrictEqual(["2026-11", "2026-12", "2027-01", "2027-02", "2027-04", "2027-05"].map((m) => C.bustaImporto(b2, m)), [300, 400, 400, 450, 450, 0]);
assert.strictEqual(C.bustaAttiva(b2, "2027-05"), false);

// ESEMPIO DELLA DISCUSSIONE: saldo inizio 3000, entrate 2000, busta spesa 500 (speso 200), accumulo 150, uscita senza busta 700
const e0 = calc(ops0).entries;
let pv = C.previsto(bud, ops0, e0, cfg, "2026-11", "c1", today);
assert.strictEqual(pv.inizio, 3000);
assert.strictEqual(pv.finale, 3000 + 2000 - 700 - 200); // 4100 = saldo di oggi
assert.strictEqual(pv.residuo, 300);
assert.strictEqual(pv.previsto, 3800); // = 3000 + 2000 - 500 - 700, il budget intero, senza contare due volte i 200
// il previsto non cambia mentre si spende dentro il budget
const ops1 = ops0.concat([mk("s3", "2026-11-14", "c1", "uscita", 100, { busta_id: "bs" })]);
assert.strictEqual(C.previsto(bud, ops1, calc(ops1).entries, cfg, "2026-11", "c1", today).previsto, 3800);
// ... e scende solo se si supera: speso 560 -> 3740
const ops2 = ops0.concat([mk("s4", "2026-11-14", "c1", "uscita", 360, { busta_id: "bs" })]);
pv = C.previsto(bud, ops2, calc(ops2).entries, cfg, "2026-11", "c1", today);
assert.deepStrictEqual([pv.residuo, pv.previsto], [0, 3740]);
// l'accumulo non è un'uscita: il previsto non scende di 150
assert.strictEqual(C.previsto(C.normBudget({ ...bud, buste: bud.buste.filter((b) => b.id !== "ba") }), ops0, e0, cfg, "2026-11", "c1", today).previsto, 3800);
// senza buste il previsto è quello di sempre (saldo dopo tutte le operazioni)
const nessuna = C.previsto(C.emptyBudget(), ops0, e0, cfg, "2026-11", "c1", today);
assert.deepStrictEqual([nessuna.residuo, nessuna.previsto], [0, 4100]);
// mesi futuri: budget intero; mesi chiusi: nessun residuo
const bud2 = C.normBudget({ ...bud, buste: [{ ...bud.buste[0], steps: [{ da: "2026-10", importo: 500 }] }, bud.buste[1]] });
// il residuo si accumula: quello che resta da spendere a novembre (300) riduce anche dicembre (+ 500 di dicembre)
const pvNov = C.previsto(bud2, ops0, e0, cfg, "2026-11", "c1", today), pvDic = C.previsto(bud2, ops0, e0, cfg, "2026-12", "c1", today);
assert.deepStrictEqual([pvNov.residuo, pvDic.residuo, pvDic.residuoMese], [300, 800, 500]);
assert.strictEqual(pvDic.previsto, 4100 - 800);
assert.strictEqual(pvDic.previsto, pvNov.previsto - 500); // senza altre operazioni, ogni mese scende del suo budget
const pvGen = C.previsto(bud2, ops0, e0, cfg, "2027-01", "c1", today);
assert.strictEqual(pvGen.previsto, pvDic.previsto - 500);
assert.strictEqual(C.previsto(bud2, ops0, e0, cfg, "2026-10", "c1", today).residuo, 0);

// DA ASSEGNARE: 2000 - 500 (spesa) - 150 (accumulo) - 700 (senza busta)
let plan = C.monthPlan(bud, ops0, "2026-11", "c1");
assert.deepStrictEqual([plan.entrate, plan.assegnato, plan.senza, plan.daAssegnare], [2000, 650, 700, 650]);
// coerenza: previsto = inizio + da assegnare + accumulo
assert.strictEqual(C.previsto(bud, ops0, e0, cfg, "2026-11", "c1", today).previsto, 3000 + plan.daAssegnare + 150);
// superare il budget aumenta l'assegnato e riduce il da assegnare
assert.strictEqual(C.monthPlan(bud, ops2, "2026-11", "c1").daAssegnare, 2000 - 560 - 150 - 700);
// nessun riporto: il mese dopo riparte dalle sue entrate
assert.deepStrictEqual([C.monthPlan(bud, ops0, "2026-12", "c1").entrate, C.monthPlan(bud, ops0, "2026-12", "c1").senza], [0, 0]);

// STATO delle buste: ok / warn (dal 90%) / over
const st = (speso) => C.statoBusta(bud, [mk("x", "2026-11-02", "c1", "uscita", speso, { busta_id: "bs" })], bud.buste[0], "2026-11");
assert.strictEqual(st(200).stato, "ok");
assert.strictEqual(st(449.99).stato, "ok");
assert.strictEqual(st(450).stato, "warn");
assert.strictEqual(st(500).stato, "warn");
assert.deepStrictEqual([st(560).stato, st(560).over, st(560).residuo], ["over", 60, 0]);
// le annullate non contano
assert.strictEqual(C.bustaSpeso([mk("a", "2026-11-02", "c1", "uscita", 50, { busta_id: "bs", annullata: true })], bud.buste[0], "2026-11"), 0);

// AVVISO prima di salvare: la nuova spesa supera il budget? (modifica: esclude la spesa stessa)
let ck = C.checkSpesa(bud, ops0, "bs", "2026-11", 350);
assert.deepStrictEqual([ck.over, ck.speso, ck.budget], [50, 550, 500]);
assert.strictEqual(C.checkSpesa(bud, ops0, "bs", "2026-11", 300).over, 0);
assert.strictEqual(C.checkSpesa(bud, ops0, "bs", "2026-11", 380, "s2").over, 0); // modifica s2 (80) -> 380: 120+380 = 500
assert.strictEqual(C.checkSpesa(bud, ops0, "bs", "2026-11", 381, "s2").over, 1);
assert.strictEqual(C.checkSpesa(bud, ops0, "ba", "2026-11", 9999).over, 0); // l'accumulo non ha un tetto di spesa

// COPRI da un'altra busta: il totale assegnato non cambia, la busta rossa torna a posto
const budCopri = C.normBudget({ ...bud, spostamenti: [{ id: "m1", mese: "2026-11", da: "ba", a: "bs", importo: 60 }] });
assert.strictEqual(C.bustaBudget(budCopri, budCopri.buste[0], "2026-11"), 560);
assert.strictEqual(C.bustaBudget(budCopri, budCopri.buste[1], "2026-11"), 90);
assert.strictEqual(C.statoBusta(budCopri, ops2, budCopri.buste[0], "2026-11").over, 0);
assert.strictEqual(C.statoBusta(budCopri, ops2, budCopri.buste[0], "2026-11").stato, "warn");
assert.strictEqual(C.monthPlan(budCopri, ops2, "2026-11", "c1").assegnato, 560 + 90); // come prima di coprire (500+150) più lo sforamento già pagato
assert.strictEqual(C.monthPlan(budCopri, ops2, "2026-11", "c1").daAssegnare, C.monthPlan(bud, ops0, "2026-11", "c1").daAssegnare);
// la copertura vale solo per quel mese
assert.strictEqual(C.bustaBudget(budCopri, budCopri.buste[0], "2026-12"), 500);

// CONTO COMUNE: l'importo è totale, a ciascun conto la metà (c1 = metà arrotondata, c2 = resto)
assert.deepStrictEqual([C.share(301, "comune", "c1"), C.share(301, "comune", "c2"), C.share(301, "comune", "tot")], [150.5, 150.5, 301]);
assert.deepStrictEqual([C.share(5.01, "comune", "c1"), C.share(5.01, "comune", "c2")], [2.51, 2.5]);
assert.strictEqual(C.share(100, "c1", "c2"), 0);
const opsC = [mk("c", "2026-11-10", "comune", "uscita", 100, { busta_id: "bc" })];
const pc1 = C.monthPlan(budC, opsC, "2026-11", "c1"), pc2 = C.monthPlan(budC, opsC, "2026-11", "c2");
assert.deepStrictEqual([pc1.righe.find((r) => r.busta.id === "bc").quotaResiduo, pc2.righe.find((r) => r.busta.id === "bc").quotaResiduo], [100.5, 100.5]); // residuo 301 - 100 = 201, diviso a metà
assert.strictEqual(pc1.righe.find((r) => r.busta.id === "bc").quota + pc2.righe.find((r) => r.busta.id === "bc").quota, 301);

// FONDI: partono da 0, ricevono l'accumulo dei mesi chiusi; il mese in corso è "in arrivo"
let fs = C.fondoSaldo(bud, bud.fondi[0], ops0, today);
assert.deepStrictEqual([fs.saldo, fs.versato, fs.inArrivo, fs.prelevato], [300, 300, 150, 0]); // settembre e ottobre versati
assert.strictEqual(C.fondoSaldo(bud, bud.fondi[0], ops0, "2026-12-01").saldo, 450); // chiuso anche novembre
assert.strictEqual(C.fondoSaldo(bud, { ...bud.fondi[0], iniziale: 40 }, ops0, today).saldo, 340);
// spese pagate dal fondo: scendono sia il conto sia il fondo (qui solo il fondo)
const budPrel = C.normBudget({ ...bud, buste: bud.buste.concat([{ id: "bv", nome: "Viaggio", tipo: "spesa", conto: "c1", fondo: "f1", steps: [{ da: "2026-11", importo: 100 }] }]) });
const opsV = ops0.concat([mk("v1", "2026-11-10", "c1", "uscita", 90, { busta_id: "bv" }), mk("v2", "2026-11-20", "c1", "uscita", 40, { busta_id: "bv" })]);
fs = C.fondoSaldo(budPrel, budPrel.fondi[0], opsV, today);
assert.deepStrictEqual([fs.saldo, fs.prelevato], [210, 90]); // la spesa del 20 non è ancora avvenuta
// fondo senza buste: resta al saldo iniziale
assert.strictEqual(C.fondoSaldo(C.normBudget({ fondi: bud.fondi }), bud.fondi[0], ops0, today).saldo, 0);
// buste sospese: dopo "fine" non versano più
const budFine = C.normBudget({ ...bud, buste: [{ ...bud.buste[1], fine: "2026-09" }] });
assert.deepStrictEqual([C.fondoSaldo(budFine, bud.fondi[0], ops0, today).saldo, C.fondoSaldo(budFine, bud.fondi[0], ops0, today).inArrivo], [150, 0]);

// LIBERO: saldo di oggi - fondi - accumulo già messo da parte questo mese
const lb = C.libero(bud, ops0, e0, cfg, "c1", today);
assert.deepStrictEqual([lb.reale, lb.vincolato, lb.libero], [4100, 450, 3650]);
assert.strictEqual(C.libero(bud, ops0, e0, cfg, "c2", today).libero, 1000); // il fondo è del Conto 1
assert.strictEqual(C.libero(C.emptyBudget(), ops0, e0, cfg, "c1", today).libero, 4100);

// i dati di ingresso non vengono modificati
const copia = JSON.stringify([bud, ops0]);
C.monthPlan(bud, ops0, "2026-11", "c1"); C.previsto(bud, ops0, e0, cfg, "2026-11", "c1", today); C.fondoSaldo(bud, bud.fondi[0], ops0, today);
assert.strictEqual(JSON.stringify([bud, ops0]), copia);

// BUSTA TOLTA DA UN MESE (escluse): in quel mese non esiste, negli altri sì
const budEsc = C.normBudget({ ...bud, buste: [{ ...bud.buste[0], steps: [{ da: "2026-11", importo: 500 }], escluse: ["2026-12"] }, { ...bud.buste[1], escluse: ["2026-11"] }] });
assert.deepStrictEqual(["2026-11", "2026-12", "2027-01"].map((m) => C.bustaImporto(budEsc.buste[0], m)), [500, 0, 500]);
assert.deepStrictEqual(["2026-11", "2026-12", "2027-01"].map((m) => C.bustaAttiva(budEsc.buste[0], m)), [true, false, true]);
assert.strictEqual(C.monthPlan(budEsc, ops0, "2026-12", "c1").righe.some((r) => r.busta.id === "bs"), false);
assert.strictEqual(C.monthPlan(budEsc, ops0, "2026-11", "c1").righe.some((r) => r.busta.id === "bs"), true);
// un accumulo tolto da un mese non versa nulla nel fondo per quel mese
const fe = C.fondoSaldo(budEsc, bud.fondi[0], ops0, "2027-01-01");
assert.strictEqual(fe.versato, 150 * 3); // da settembre a dicembre senza novembre: settembre, ottobre, dicembre
assert.strictEqual(C.fondoSaldo(bud, bud.fondi[0], ops0, "2027-01-01").versato, 150 * 4); // senza esclusioni: anche novembre
console.log("ok: budget");
