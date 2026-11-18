// Calcoli puri del calendario di pianificazione (nessun accesso a DOM o rete: si testa con Node).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Plan = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m: 0-11
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];

  // Pasqua (algoritmo gregoriano anonimo): restituisce [mese 0-11, giorno]
  function pasqua(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mese = Math.floor((h + l - 7 * m + 114) / 31), giorno = ((h + l - 7 * m + 114) % 31) + 1;
    return [mese - 1, giorno];
  }
  // Festività nazionali italiane dell'anno: { "YYYY-MM-DD": nome }
  function festivi(y) {
    const out = {};
    const add = (m, d, nome) => { out[iso(y, m, d)] = nome; };
    add(0, 1, "Capodanno"); add(0, 6, "Epifania"); add(3, 25, "Liberazione"); add(4, 1, "Festa del lavoro");
    add(5, 2, "Festa della Repubblica"); add(7, 15, "Ferragosto"); add(10, 1, "Ognissanti");
    add(11, 8, "Immacolata"); add(11, 25, "Natale"); add(11, 26, "Santo Stefano");
    const [pm, pd] = pasqua(y);
    const lun = new Date(Date.UTC(y, pm, pd + 1));
    out[iso(lun.getUTCFullYear(), lun.getUTCMonth(), lun.getUTCDate())] = "Lunedì dell'Angelo";
    out[iso(y, pm, pd)] = "Pasqua";
    return out;
  }
  // 0 = lunedì … 6 = domenica
  const dowLun = (y, m, d) => (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
  const giorniNelMese = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  // Settimane del mese (si parte dal lunedì). Ogni cella: { iso, d, dentro, dow, weekend, festivo, lavorativo }
  function monthGrid(y, m) {
    const fest = Object.assign({}, festivi(y - 1), festivi(y), festivi(y + 1));
    const first = dowLun(y, m, 1), n = giorniNelMese(y, m), cells = [];
    for (let i = 0; i < Math.ceil((first + n) / 7) * 7; i++) {
      const dt = new Date(Date.UTC(y, m, 1 - first + i));
      const yy = dt.getUTCFullYear(), mm = dt.getUTCMonth(), dd = dt.getUTCDate(), s = iso(yy, mm, dd);
      const dow = i % 7, weekend = dow >= 5, festivo = fest[s] || null;
      cells.push({ iso: s, d: dd, dentro: mm === m && yy === y, dow, weekend, festivo, lavorativo: !weekend && !festivo });
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }
  const lavorativo = (s) => {
    const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)) - 1, d = Number(s.slice(8, 10));
    return dowLun(y, m, d) < 5 && !festivi(y)[s];
  };

  const ORE_MAX = 24;
  const parseOre = (v) => {
    const n = Number(String(v ?? "").trim().replace(",", "."));
    return Number.isFinite(n) && n >= 0 && n <= 8760 ? r2(n) : NaN;
  };
  const fmtNum = (n) => String(r2(n)).replace(".", ",");
  const fmtOre = (n) => `${fmtNum(n)} h`;
  const fmtGiorni = (ore, oreGiorno) => { const g = oreGiorno > 0 ? r2(ore / oreGiorno) : 0; return `${fmtNum(g)} ${g === 1 ? "giorno" : "giorni"}`; };

  // Ore usate nell'anno da una persona, per tipo
  function usate(voci, personaId, anno) {
    const out = { ferie: 0, permessi: 0 };
    for (const v of voci) if (v.persona_id === personaId && String(v.data).slice(0, 4) === String(anno) && out[v.tipo] !== undefined) out[v.tipo] = r2(out[v.tipo] + Number(v.ore));
    return out;
  }
  // Riepilogo banca ore: totale, pianificate, residuo (può diventare negativo = oltre la banca)
  function riepilogo(banca, voci, persona, anno) {
    const u = usate(voci, persona.id, anno), og = Number(persona.ore_giorno) || 8;
    const mk = (tot, us) => ({ totale: r2(tot), usate: us, residuo: r2(tot - us), oltre: us > tot, perc: tot > 0 ? Math.min(100, Math.round((us / tot) * 100)) : (us > 0 ? 100 : 0), giorniTot: r2(tot / og), giorniUsati: r2(us / og), giorniResiduo: r2((tot - us) / og) });
    return { ferie: mk(banca ? Number(banca.ferie_ore) : 0, u.ferie), permessi: mk(banca ? Number(banca.permessi_ore) : 0, u.permessi), configurata: !!banca };
  }
  // Riepilogo per giorno: { iso: { ferie, permessi } } della persona
  function perGiorno(voci, personaId) {
    const out = {};
    for (const v of voci) if (v.persona_id === personaId) { const k = String(v.data).slice(0, 10); (out[k] = out[k] || {})[v.tipo] = Number(v.ore); }
    return out;
  }

  // Applica lo strumento a un giorno. Restituisce { op: "set"|"del"|"none", ... }:
  //  - set: salva (data, tipo, ore) · del: elimina la voce di quel tipo · none: niente da fare, con eventuale `errore`
  // strumento: { tipo: "ferie"|"permessi"|"gomma", ore }
  function applica(giorno, strumento, oreGiorno, dataIso) {
    const g = giorno || {}, og = Number(oreGiorno) || 8;
    if (strumento.tipo === "gomma") {
      const dels = ["ferie", "permessi"].filter((t) => g[t] !== undefined).map((t) => ({ op: "del", data: dataIso, tipo: t }));
      return dels.length ? { op: "multi", azioni: dels } : { op: "none" };
    }
    if (!lavorativo(dataIso)) return { op: "none", errore: "Non è un giorno lavorativo." };
    const t = strumento.tipo, ore = r2(Number(strumento.ore));
    if (!(ore > 0) || ore > og) return { op: "none", errore: `Le ore devono essere tra 0,5 e ${fmtNum(og)}.` };
    if (g[t] !== undefined && r2(g[t]) === ore) return { op: "del", data: dataIso, tipo: t }; // stesso valore: toglie
    const altro = t === "ferie" ? "permessi" : "ferie";
    const gia = g[altro] !== undefined ? g[altro] : 0;
    if (r2(ore + gia) > og) return { op: "none", errore: `Superi le ${fmtNum(og)} ore del giorno (c'è già ${fmtNum(gia)} h di ${altro}).` };
    return { op: "set", data: dataIso, tipo: t, ore };
  }

  return { pad, iso, r2, MESI, GIORNI, pasqua, festivi, monthGrid, lavorativo, giorniNelMese, dowLun, parseOre, fmtOre, fmtNum, fmtGiorni, usate, riepilogo, perGiorno, applica, ORE_MAX };
});
