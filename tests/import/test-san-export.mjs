// tests/import/test-san-export.mjs — reecrire en PGN ce qu'on a lu.
//
// L'epreuve est l'ALLER-RETOUR : lire une partie de PyChess, la rejouer dans
// le moteur, la reecrire coup par coup, et retomber sur le fichier d'origine
// jeton pour jeton. Comparer a des valeurs choisies a la main ne prouverait
// que mon interpretation ; comparer a ce que PyChess a produit prouve
// l'interoperabilite.
//
// Huit jeux « echiqueens » : leur notation naturelle porte deja tout ce dont
// le SAN a besoin -- depart, arrivee, prise, promotion, roque -- et l'ecriture
// est plus simple que la lecture, les tables d'alias etant un-vers-un dans ce
// sens.
//
// Usage : npm test  (ou node tests/import/test-san-export.mjs)
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { VariantFen, VariantGame, BookFen, BookVariant, ExtractMoves,
         FairyVariantAlias, FairyGameIndex, ParseSanMove, SanMatches,
         ParseNaturalMove, BuildSanMove, ReplayBookMoves, PgnFenToShogiSfen } from '../../app/content/book-format.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const J = require(path.join(root, 'dist/node/jocly.core.js'));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const names = Object.keys(await J.listGames());
const cfg = {}; for (const n of names) cfg[n] = await J.getGameConfig(n).catch(() => null);
const idx = FairyGameIndex(cfg);

// Douze parties, dix jeux. Les huit « echiqueens » d'abord, puis la famille
// shogi (promotions et parachutages) et le Kyoto (faces).
const FILES = ['shatranj.pgn','grand.pgn','khans.pgn','capablanca.pgn','shako.pgn',
               'spartan.pgn','makruk.pgn','janggi.pgn',
               'shogi-promotions.pgn','mini.pgn','shoshogi.pgn','kyoto.pgn'];
for (const file of FILES) {
  const text = readFileSync(path.join(root, 'tests/fixtures/pychess', file), 'utf8');
  const tags = {};
  for (const l of text.split('\n')) { const m=/^\s*\[(\S+)\s+(.*)\]\s*$/.exec(l.trim()); if(m) tags[m[1]]=m[2].replace(/^"|"$/g,''); }
  const game = VariantGame(BookVariant(tags)) || idx[FairyVariantAlias(BookVariant(tags))];
  const tokens = ExtractMoves(text);
  const m = await J.createMatch(game);
  await m.load({ game, initialBoard: (PgnFenToShogiSfen(BookFen(tags)) || VariantFen(BookFen(tags), game)) || undefined, playedMoves: [] });
  // prelude
  for (let d=0; d<4; d++) {
    const pm = await m.getPossibleMoves(); const pn = await m.getMoveString(pm);
    if (!/^(#\d+|--)$/.test(pn[0]||'')) break;
    if (pm.length === 1) { await m.playMove(pm[0]); continue; }
    let done=false;
    for (let i=0;i<pm.length;i++){ await m.playMove(pm[i]);
      const q=await m.getPossibleMoves(); const qn=await m.getMoveString(q);
      if(/^--$/.test(qn[0]||'')) await m.playMove(q[0]);
      const p=ParseSanMove(tokens[0]); const mv=await m.getPossibleMoves(); const nt=await m.getMoveString(mv);
      if(mv.some((_,k)=>SanMatches(p,nt[k],null,{game}))){ done=true; break; }
      await m.rollback(d); }
    if(!done) await m.playMove(pm[0]);
  }
  const written = [];
  const exact = async (token) => {
    const p = ParseSanMove(token); if (!p) return null;
    const mv = await m.getPossibleMoves(); const nat = await m.getMoveString(mv);
    const usi = await m.getMoveString(mv,'usi').catch(()=>null);
    let found = null, idxFound = -1;
    for (let i=0;i<mv.length;i++){
      const o={game};
      if(usi && typeof usi[i]==='string' && usi[i]!=='??') o.promoted=usi[i].endsWith('+');
      if(!SanMatches(p,nat[i],null,o)) continue; if(found) return null; found=mv[i]; idxFound=i; }
    if (!found) return null;
    // Reecriture : les rivales sont les autres coups de la MEME piece vers la
    // MEME case.
    const mine = ParseNaturalMove(nat[idxFound]);
    // La lettre du plateau n'est fiable que si le FEN et les NOMS de cases
    // ont la meme largeur. Les jeux a reserve (shogi, crazyhouse) ont des
    // colonnes de main dans leur FEN qui ne portent pas de nom : tout y est
    // decale, et il vaut mieux ne pas s'en servir du tout.
    const state = await m.getBoardState();
    const fenWidth = (state.split(' ')[0].split('/')[0].match(/\d+|\+?[A-Za-z]/g)||[])
        .reduce((n,t2)=>n+(/^\d+$/.test(t2)?parseInt(t2,10):1),0);
    const named = Math.max(...nat.map(x=>{ const mm=/([a-o])[0-9]/.exec(x); return mm?mm[1].charCodeAt(0)-96:0; }));
    const at = fenWidth === named ? letters(state) : null;
    const rivals = [];
    for (let i=0;i<mv.length;i++){
      if (i===idxFound) continue;
      const o = ParseNaturalMove(nat[i]);
      if (!o || !o.from || !mine || !mine.from) continue;
      const lo = at ? (at(o.from)||'').toUpperCase() : o.piece;
      const lm = at ? (at(mine.from)||'').toUpperCase() : mine.piece;
      if (lo !== lm) continue;
      if (o.steps.length !== mine.steps.length) continue;
      if (o.steps[o.steps.length-1].square !== mine.steps[mine.steps.length-1].square) continue;
      if (o.from === mine.from) continue;   // la meme piece, promue ou non
      rivals.push(o.from);
    }
    const promoted = usi && typeof usi[idxFound]==='string' && usi[idxFound]!=='??'
      ? usi[idxFound].endsWith('+') : false;
    written.push({ natural: nat[idxFound], rivals, at, promoted });
    return found;
  };
  const letters = (fen) => { const rows=fen.split(' ')[0].replace(/\[[^\]]*\]/g,'').split('/'); const map={};
    rows.forEach((row,i)=>{ const rank=rows.length-i; let f=0;
      for(let k=0;k<row.length;){ const c=row[k];
        if(c>='0'&&c<='9'){ let n=c; while(row[k+1]>='0'&&row[k+1]<='9') n+=row[++k]; f+=parseInt(n,10); k++; continue; }
        let pc=c; k++; if(c==='+'){ pc+=row[k]; k++; } map[String.fromCharCode(97+f)+rank]=pc; f++; }});
    return s=>map[s]||null; };
  const r = await ReplayBookMoves(tokens,{pick:s=>m.pickMove(s).catch(()=>null),exact,play:x=>m.playMove(x)});
  const out = written.map((w,i)=>BuildSanMove(w.natural,w.rivals,game,{letterAt:w.at||undefined, promoted:w.promoted, mate: i===written.length-1 && /[#]/.test(tokens[i]||'')}));
  // Au shogi, jocly ecrit UN seul « + » pour un coup qui promeut ET donne
  // echec : la decoration d'echec y est irrecuperable, et on ne l'invente pas.
  // La comparaison l'ignore donc sur ces coups-la, et sur eux seuls.
  // Au shogi, le « + » de jocly marque la PROMOTION : l'echec n'apparait nulle
  // part dans sa notation, et on ne l'invente pas. La comparaison l'ignore
  // donc pour ces jeux -- c'est une decoration, que tout lecteur de PGN saute.
  const shogiLike = /shogi$/.test(game);
  const bare = (t2) => shogiLike ? t2.replace(/\+$/, '') : t2;
  const eq = (a,b) => a === b || bare(a) === bare(b);
  const same = out.length === tokens.length && out.every((w,i)=>eq(w,tokens[i]));
  const diff = out.findIndex((w,i)=>!eq(w,tokens[i]));
  ok(r.unresolved === null && r.played === tokens.length,
     file.padEnd(20) + ' rejoue ' + r.played + '/' + tokens.length);
  ok(same, file.padEnd(20) + ' reecrit a l\'identique'
     + (same ? '' : ' — coup ' + (diff + 1) + ' : ' + out[diff] + ' au lieu de ' + tokens[diff]));
}

console.log('');
console.log(`RESULTAT san-export: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
