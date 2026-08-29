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
// Dix-sept parties, onze jeux : les huit « echiqueens », la famille shogi
// (promotions et parachutages), le Kyoto (faces) et le xiangqi (rangees
// decalees, notation sans separateur).
const FILES = ['shatranj.pgn','grand.pgn','khans.pgn','capablanca.pgn','shako.pgn',
               'spartan.pgn','makruk.pgn','janggi.pgn',
               'shogi-promotions.pgn','mini.pgn','shoshogi.pgn','kyoto.pgn',
               'xiangqi-pychess-1.pgn','xiangqi-pychess-2.pgn',
               'xiangqi-ltlswqlc.pgn','xiangqi-LULQPutT.pgn','xiangqi-NrmGxFe1.pgn'];
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
  // Le xiangqi est le seul a numeroter ses rangees a partir de 0 : le janggi,
  // sur le meme plateau, ecrit « a4-a5 » avec separateur et rangees a partir
  // de 1. La geometrie ne dit rien de la notation.
  const zero = (game === 'xiangqi');
  const exact = async (token) => {
    const p = ParseSanMove(token); if (!p) return null;
    const mv = await m.getPossibleMoves(); const nat = await m.getMoveString(mv);
    const usi = await m.getMoveString(mv,'usi').catch(()=>null);
    const readAt = zero ? zeroLetters(await m.getBoardState()) : null;
    let found = null, idxFound = -1;
    for (let i=0;i<mv.length;i++){
      const o={game, rankOffset: zero?1:0};
      if(usi && typeof usi[i]==='string' && usi[i]!=='??') o.promoted=usi[i].endsWith('+');
      if(!SanMatches(p,nat[i],readAt,o)) continue; if(found) return null; found=mv[i]; idxFound=i; }
    if (!found) return null;
    // Reecriture : les rivales sont les autres coups de la MEME piece vers la
    // MEME case.
    // Le xiangqi ecrit « a3a4 », sans separateur : ParseNaturalMove ne le lit
    // pas, et sans case de depart il n'y a pas de rivales -- donc pas de
    // desambiguisation, alors que deux canons peuvent viser la meme case.
    const parseAny = (t2) => {
      const flat = /^([a-l][0-9]{1,2})([a-l][0-9]{1,2})$/.exec(t2);
      if (flat) return { piece: '', from: flat[1], steps: [{ capture: false, square: flat[2] }] };
      return ParseNaturalMove(t2);
    };
    const mine = parseAny(nat[idxFound]);
    // La lettre du plateau n'est fiable que si le FEN et les NOMS de cases
    // ont la meme largeur. Les jeux a reserve (shogi, crazyhouse) ont des
    // colonnes de main dans leur FEN qui ne portent pas de nom : tout y est
    // decale, et il vaut mieux ne pas s'en servir du tout.
    const state = await m.getBoardState();
    const capture = found && found.c !== null && found.c !== undefined;
    const fenWidth = (state.split(' ')[0].split('/')[0].match(/\d+|\+?[A-Za-z]/g)||[])
        .reduce((n,t2)=>n+(/^\d+$/.test(t2)?parseInt(t2,10):1),0);
    const named = Math.max(...nat.map(x=>{ const mm=/([a-o])[0-9]/.exec(x); return mm?mm[1].charCodeAt(0)-96:0; }));
    const at = fenWidth === named ? letters(state) : null;
    const rivals = [];
    for (let i=0;i<mv.length;i++){
      if (i===idxFound) continue;
      const o = parseAny(nat[i]);
      if (!o || !o.from || !mine || !mine.from) continue;
      const board = zero ? readAt : at;
      const lo = board ? (board(o.from)||'').toUpperCase() : o.piece;
      const lm = board ? (board(mine.from)||'').toUpperCase() : mine.piece;
      if (lo !== lm) continue;
      if (o.steps.length !== mine.steps.length) continue;
      if (o.steps[o.steps.length-1].square !== mine.steps[mine.steps.length-1].square) continue;
      if (o.from === mine.from) continue;   // la meme piece, promue ou non
      rivals.push(o.from);
    }
    const promoted = usi && typeof usi[idxFound]==='string' && usi[idxFound]!=='??'
      ? usi[idxFound].endsWith('+') : false;
    written.push({ natural: nat[idxFound], rivals, at: zero ? readAt : at, promoted,
                   capture, rankOffset: zero ? 1 : 0 });
    return found;
  };
  const zeroLetters = (fen) => { const rows=fen.split(' ')[0].split('/'); const map={};
    rows.forEach((row,i)=>{ const rank=rows.length-1-i; let f=0;
      for(const c of row){ if(/[0-9]/.test(c)) f+=+c; else { map[String.fromCharCode(97+f)+rank]=c; f++; } }});
    return s2=>map[s2]||null; };
  const letters = (fen) => { const rows=fen.split(' ')[0].replace(/\[[^\]]*\]/g,'').split('/'); const map={};
    rows.forEach((row,i)=>{ const rank=rows.length-i; let f=0;
      for(let k=0;k<row.length;){ const c=row[k];
        if(c>='0'&&c<='9'){ let n=c; while(row[k+1]>='0'&&row[k+1]<='9') n+=row[++k]; f+=parseInt(n,10); k++; continue; }
        let pc=c; k++; if(c==='+'){ pc+=row[k]; k++; } map[String.fromCharCode(97+f)+rank]=pc; f++; }});
    return s=>map[s]||null; };
  const r = await ReplayBookMoves(tokens,{pick:s=>m.pickMove(s).catch(()=>null),exact,play:x=>m.playMove(x)});
  const out = written.map((w,i)=>BuildSanMove(w.natural,w.rivals,game,{letterAt:w.at||undefined, promoted:w.promoted, capture:w.capture, rankOffset:w.rankOffset, mate: i===written.length-1 && /[#]/.test(tokens[i]||'')}));
  // Au shogi, jocly ecrit UN seul « + » pour un coup qui promeut ET donne
  // echec : la decoration d'echec y est irrecuperable, et on ne l'invente pas.
  // La comparaison l'ignore donc sur ces coups-la, et sur eux seuls.
  // Au shogi, le « + » de jocly marque la PROMOTION : l'echec n'apparait nulle
  // part dans sa notation, et on ne l'invente pas. La comparaison l'ignore
  // donc pour ces jeux -- c'est une decoration, que tout lecteur de PGN saute.
  // jocly n'ecrit l'echec ni au shogi (le « + » y marque la promotion) ni au
  // xiangqi (sa notation n'a aucune decoration). On ne l'invente pas.
  const shogiLike = /shogi$/.test(game) || game === 'xiangqi';
  const bare = (t2) => shogiLike ? t2.replace(/\+$/, '') : t2;
  const eq = (a,b) => a === b || bare(a) === bare(b);
  const same = out.length === tokens.length && out.every((w,i)=>eq(w,tokens[i]));
  const diff = out.findIndex((w,i)=>!eq(w,tokens[i]));
  ok(r.unresolved === null && r.played === tokens.length,
     file.padEnd(22) + ' rejoue ' + r.played + '/' + tokens.length);
  ok(same, file.padEnd(22) + ' reecrit a l\'identique'
     + (same ? '' : ' — coup ' + (diff + 1) + ' : ' + out[diff] + ' au lieu de ' + tokens[diff]));
}

// L'ALLER-RETOUR STRICT : reecrire, puis relire ce qu'on vient d'ecrire, en
// refusant toute ambiguite. Comparer au fichier d'origine ne suffit pas --
// un export sous-specifie peut coincider avec un fichier lui-meme
// sous-specifie. Ici on exige que notre propre sortie se recharge.
//
// C'est le cas qui a echappe : au xiangqi, jocly ecrit « c9e7 » sans
// separateur, ParseNaturalMove n'y lisait pas de case de depart, donc aucune
// rivale, donc aucune desambiguisation. L'export produisait « Ee8 » la ou
// DEUX elephants visaient la meme case, et le fichier ne se rechargeait pas.
{
    // Une position OU DEUX ELEPHANTS visent la meme case : c'est exactement
    // ce que la partie signalee contenait.
    const TWO_ELEPHANTS = '2e1k1e2/9/9/9/9/9/9/9/9/4K4 b - - 0 1';
    const flat = ParseNaturalMove('c9e7');
    ok(flat && flat.from === 'c9' && flat.steps[0].square === 'e7',
       'la notation sans separateur porte bien une case de depart');

    const match = await J.createMatch('xiangqi');
    await match.load({ game: 'xiangqi', initialBoard: TWO_ELEPHANTS, playedMoves: [] });
    const at = (fen) => { const rows = fen.split(' ')[0].split('/'); const map = {};
        rows.forEach((row, i2) => { const rank = rows.length - 1 - i2; let f = 0;
            for (const c of row) { if (/[0-9]/.test(c)) f += +c;
                else { map[String.fromCharCode(97 + f) + rank] = c; f++; } } });
        return (sq) => map[sq] || null; };

    const legal = await match.getPossibleMoves();
    const nat = await match.getMoveString(legal);
    const board = at(await match.getBoardState());
    const k = nat.indexOf('c9e7');
    ok(k >= 0 && nat.indexOf('g9e7') >= 0, 'les deux elephants visent e7');
    const rivals = [];
    for (let i2 = 0; i2 < legal.length; i2++) {
        if (i2 === k) continue;
        const other = ParseNaturalMove(nat[i2]);
        if (!other || !other.from || other.from === 'c9') continue;
        if (other.steps[other.steps.length - 1].square !== 'e7') continue;
        if (board(other.from) === board('c9')) rivals.push(other.from);
    }
    ok(rivals.length === 1 && rivals[0] === 'g9', 'l\'autre elephant est vu comme rival');
    const token = BuildSanMove('c9e7', rivals, 'xiangqi', { letterAt: board, rankOffset: 1 });
    ok(token === 'Ece8', 'le coup s\'ecrit donc « Ece8 » et non « Ee8 » — ' + token);
}

console.log('');
console.log(`RESULTAT san-export: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
