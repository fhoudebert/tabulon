// tests/test-chushogi-pgn.mjs — lire un PGN de ChuShogiLite.
//
// La fixture est un fichier RÉEL exporté par l'applet (tests/fixtures-
// chushogilite.pgn). Ça compte : une reconstitution écrite d'après la
// documentation s'était trompée sur les trois points ci-dessous, et chacun
// aurait produit une partie fausse plutôt qu'une erreur.
//
// 1. LE [FEN] A CINQ CHAMPS — plateau, trait, case de la dernière prise de
//    Lion, puis « 0 1 » ajoutés. jocly n'y reconnaît ni un FEN (six champs) ni
//    un SFEN (trois ou quatre, qu'il sait lire seul) et refuse la position.
//
// 2. LE TRAIT NE BOUGE PAS. Deux inversions se compensent : le SFEN note « b »
//    le trait de sente, jocly note ce même trait « w », et ChuShogiLite écrit
//    « w » dans son [FEN] là où son SFEN porte « b ». Le retoucher, comme le
//    laissait croire une lecture trop rapide, charge la position à l'envers.
//
// 3. LES COUPS NE SONT PAS EN USI mais dans la notation « occidentale » de
//    l'applet : lettre FEN de la pièce (« +H » et non « +DH »), case de départ
//    omise, deux pas du Lion séparés par une virgule. Donnés à pickMove — qui
//    choisit par distance d'édition et ne peut pas échouer — ces jetons
//    auraient été joués comme le coup le plus ressemblant, en silence.
//
// Usage : npm test  (ou node tests/test-chushogi-pgn.mjs)
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { ExtractMoves, BookFen, BookVariant, VariantGame, MoveFormat, PgnFenToJocly,
         ParseWesternMove, ParseNaturalMove, WesternMatches, ReplayBookMoves, ParseSolution, BuildPJN, SideWithoutKing, IsTsume,
         BuildWesternMove, SfenToPgnFen, BuildPGN, PgnFenToShogiSfen, IsChuKif, ParseKif }
    from '../../app/content/book-format.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const Jocly = require(path.join(root, 'dist/node/jocly.core.js'));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const pgn = readFileSync(path.join(root, 'tests', 'fixtures/chushogilite/chushogilite.pgn'), 'utf-8');
const tags = {};
for (const line of pgn.split('\n')) {
    const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
    if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
}

// La lettre portée par chaque case du plateau : l'abréviation FEN, celle
// qu'emploie la notation de l'applet. Copie de BoardLetters (play.js), qui ne
// peut pas être importée — play.js touche au DOM.
function boardLetters(fen) {
    const rows = String(fen || '').split(' ')[0].split('/');
    const map = {};
    rows.forEach((row, index) => {
        const rank = rows.length - index;
        let file = 0;
        for (let k = 0; k < row.length; ) {
            const c = row[k];
            if (c >= '0' && c <= '9') {
                let n = c;
                while (row[k + 1] >= '0' && row[k + 1] <= '9') n += row[++k];
                file += parseInt(n, 10); k++; continue;
            }
            let piece = c; k++;
            if (c === '+') { piece += row[k]; k++; }
            map[String.fromCharCode(97 + file) + rank] = piece;
            file++;
        }
    });
    return (square) => map[square] || null;
}
// jocly n'écrit pas la case de départ sur un coup à deux pas ; l'USI, lui,
// commence toujours par elle. La conversion est celle de cslSqToPgn : le
// numéro de colonne se compte depuis la droite, la lettre de rangée depuis le
// haut — l'exact inverse des coordonnées de jocly.
function usiToJocly(square) {
    const m = /^(\d+)([a-l])$/.exec(square || '');
    if (!m) return null;
    return String.fromCharCode(109 - parseInt(m[1], 10)) + (12 - (m[2].charCodeAt(0) - 97));
}
async function fromSquare(match, move, natural) {
    const parsed = ParseNaturalMove(natural);
    if (parsed && parsed.from) return parsed.from;
    const usi = await match.getMoveString(move, 'usi').catch(() => null);
    const first = /^(\d+[a-l])/.exec(usi || '');
    return first ? usiToJocly(first[1]) : null;
}

const westernResolver = (match) => async (token) => {
    const parsed = ParseWesternMove(token);
    if (!parsed) return null;
    const moves = await match.getPossibleMoves();
    if (!moves?.length) return null;
    const natural = await match.getMoveString(moves);
    const letterAt = boardLetters(await match.getBoardState());
    let found = null;
    for (let i = 0; i < moves.length; i++) {
        if (!WesternMatches(parsed, natural[i], letterAt)) continue;
        if (found) return null;
        found = moves[i];
    }
    return found;
};

console.log('Le fichier désigne son jeu');
{
    ok(VariantGame(BookVariant(tags)) === 'chu-shogi',
       '[Variant "chu"] → chu-shogi (aucune variante Fairy-Stockfish ne joue le chu shogi)');
}

console.log('Le [FEN] à cinq champs');
{
    const raw = BookFen(tags);
    ok(raw.trim().split(/\s+/).length === 5,
       'le fichier réel en porte cinq — ni six comme un FEN jocly, ni quatre comme un SFEN');

    const jocly = PgnFenToJocly(raw);
    ok(jocly && jocly.split(' ').length === 6, 'recomposé en six champs');
    ok(jocly.split(' ')[0] === raw.split(' ')[0], 'le plateau est repris octet pour octet');
    ok(jocly.split(' ')[1] === raw.split(' ')[1],
       'et le TRAIT est repris tel quel : les deux inversions se compensent');

    // Ce qui arrive si on ne recompose pas, et si on inverse le trait.
    let refused = false;
    try { await (await Jocly.createMatch('chu-shogi')).load({ game: 'chu-shogi', initialBoard: raw, playedMoves: [] }); }
    catch { refused = true; }
    ok(refused, 'sans recomposition, jocly refuse la position (« FEN should have 6 parts »)');

    ok(PgnFenToJocly('board w - - 0 1') === null, 'un FEN jocly à six champs n\'est pas retouché');
    ok(PgnFenToJocly('board b - 1') === null, 'un SFEN à quatre champs non plus : jocly le lit seul');
}

console.log('Les coups sont en notation « occidentale »');
{
    const tokens = ExtractMoves(pgn);
    ok(tokens.length === 17, `${tokens.length} demi-coups extraits`);
    ok(MoveFormat(tokens) === 'western', 'reconnus comme occidentaux, et non comme de l\'USI');
    ok(tokens.includes('+Oxc7,b8'), 'dont un coup à deux pas du Lion, séparé par une virgule');

    const lion = ParseWesternMove('+Oxc7,b8');
    ok(lion.piece === '+O' && lion.steps.length === 2 && lion.steps[0].square === 'c7'
       && lion.steps[1].square === 'b8', 'la virgule est lue comme deux pas');
    ok(ParseWesternMove('+Hxe11').piece === '+H',
       'la lettre est l\'abréviation FEN (« +H »), pas la naturelle (« +DH »)');
    ok(ParseNaturalMove('+DHh8xe11+').from === 'h8',
       'côté jocly, la case de départ est présente — l\'applet l\'omet');

    // Le point qui n'était devinable que sur un fichier réel : l'applet
    // n'écrit le « x » que devant la PREMIÈRE case d'un coup à deux pas, alors
    // que les deux sont des prises.
    ok(WesternMatches(lion, '+KNxc7xb8', () => '+O'),
       '« +Oxc7,b8 » désigne bien « +KNxc7xb8 », dont les DEUX pas prennent');
    ok(!WesternMatches(ParseWesternMove('+Hxe11'), '+DHh8-e11', () => '+H'),
       'mais la prise du premier pas, elle, doit correspondre');
    ok(!WesternMatches(ParseWesternMove('+Hxe11'), '+DHh8xe11+', () => 'Q'),
       'et la lettre du plateau tranche entre deux pièces sur la même case');
}

console.log('Rejeu intégral');
{
    const raw = BookFen(tags);
    const fen = PgnFenToJocly(raw);
    const tokens = ExtractMoves(pgn);

    // C'est un TSUME : le camp attaquant n'a pas de roi, et le modèle
    // chu-shogi de jocly déclare perdant un camp sans roi. La position du
    // fichier ne peut donc pas être jouée telle quelle — c'est une limite
    // côté moteur, pas côté lecture, et le test la constate au lieu de la
    // contourner en silence.
    const asIs = await Jocly.createMatch('chu-shogi');
    await asIs.load({ game: 'chu-shogi', initialBoard: fen, playedMoves: [] });
    ok((await asIs.getPossibleMoves()).length === 0,
       'position de tsume : aucun coup légal, le camp attaquant n\'ayant pas de roi');
    ok(!/K/.test(fen.split(' ')[0]) && /k/.test(fen.split(' ')[0]),
       'le plateau confirme le diagnostic : un roi noir, aucun roi blanc');

    // On ajoute un roi blanc dans un coin vide pour valider la LECTURE, qui
    // est ce que cette suite couvre. Le jour où jocly saura jouer un tsume,
    // ces deux lignes sautent et le reste tient tel quel.
    const playable = fen.replace('/12 w', '/11K w');
    const match = await Jocly.createMatch('chu-shogi');
    await match.load({ game: 'chu-shogi', initialBoard: playable, playedMoves: [] });

    const r = await ReplayBookMoves(tokens, {
        pick: (s) => match.pickMove(s).catch(() => null),
        exact: westernResolver(match),
        play: (m) => match.playMove(m),
    });
    ok(r.unresolved === null && r.played === tokens.length,
       `${r.played}/${tokens.length} demi-coups rejoués exactement`
       + (r.unresolved ? ` — bloqué sur « ${r.unresolved} »` : ''));

    const played = await match.getPlayedMoves();
    const natural = await match.getMoveString(played);
    ok(natural[0] === '+DHh8xe11+' && natural[6] === '+KNxc7xb8',
       'traduits dans la notation de jocly — ' + natural.slice(0, 3).join(' ') + ' …');

    // Ce que la fenêtre Historique reçoit, et ce qu'elle en fait : la liste
    // complète, puis la navigation dans les deux sens. Sans le mode tsume rien
    // de tout cela n'existe, la partie étant finie avant son premier coup —
    // c'est donc ici que l'option se voit vraiment.
    ok(natural.length === tokens.length && natural.every(x => x && x !== '?'),
       `${natural.length} coups libellés pour l'Historique`);
    await match.rollback(3);
    ok((await match.getPlayedMoves()).length === 3, 'reculer au 3e coup');
    await match.rollback(played.length);
    ok((await match.getPlayedMoves()).length === played.length, 'ré-avancer jusqu\'au bout');
    await match.rollback(0);
    ok((await match.getPossibleMoves()).length > 0,
       'revenu au départ, la position reste jouable — l\'option survit au rechargement');
}

console.log('Enregistrer puis rouvrir un tsume');
{
    // Le mode tsume est une OPTION passée à load(), pas un fait du plateau :
    // une position sans roi ne dit pas d'elle-même si elle est un problème ou
    // une erreur de saisie. joclyMatch.save() ne peut donc pas le connaître,
    // et Tabulon l'ajoute à côté des coups (SaveMatch, play.js).
    const raw = readFileSync(path.join(root, 'tests', 'fixtures/chushogilite/chushogilite.pgn'), 'utf-8');
    const tags2 = {};
    for (const line of raw.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) tags2[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    const match = await Jocly.createMatch('chu-shogi');
    await match.load({ game: 'chu-shogi', initialBoard: PgnFenToJocly(BookFen(tags2)),
                       playedMoves: [], tsume: true });
    const tokens = ExtractMoves(raw);
    await ReplayBookMoves(tokens, {
        pick: (s) => match.pickMove(s).catch(() => null),
        exact: westernResolver(match),
        play: (m) => match.playMove(m),
    });

    const saved = await match.save();
    saved.tsume = true;                       // ce que fait SaveMatch()
    const json = JSON.stringify(saved);
    ok(ParseSolution(json)?.tsume === true,
       'le drapeau traverse la sauvegarde JSON et sa relecture');

    // Sans lui, rouvrir la partie enregistrée échoue : les coups sont rejoués
    // depuis une position que jocly tient pour perdue, donc sans coup légal.
    const sol = ParseSolution(json);
    let refused = null;
    try {
        const bare = await Jocly.createMatch('chu-shogi');
        await bare.load({ ...sol, tsume: undefined });
    } catch (e) { refused = e; }
    ok(refused, 'sans le drapeau, la partie enregistrée ne se recharge pas — ' + (refused?.message || ''));

    const back = await Jocly.createMatch('chu-shogi');
    await back.load({ ...sol, tsume: !!sol.tsume });
    ok((await back.getPlayedMoves()).length === tokens.length,
       `avec le drapeau, les ${tokens.length} coups reviennent et l'Historique est de nouveau navigable`);
}

console.log('La promotion, marquée par un « + » final');
{
    // Au shogi la promotion est FACULTATIVE : jocly produit les deux versions
    // du même déplacement. Sans lire le « + » du fichier, les deux
    // correspondent au même jeton et la lecture s'arrête sur une ambiguïté —
    // c'est ce qui bloquait « Ok9+ » au 13e demi-coup de C22.
    const promote = ParseWesternMove('Ok9+');
    ok(promote.promote === true, 'le « + » final est lu comme une promotion');
    ok(ParseWesternMove('Ok9').promote === false, 'et son absence comme un refus de promouvoir');
    ok(ParseNaturalMove('KNk7-k9=+KN+').promote === true, 'côté jocly, « =+KN » promeut');
    ok(ParseNaturalMove('KNk7-k9=KN').promote === false, 'et « =KN » décline');
    ok(ParseNaturalMove('BTd12-c11').promote === null,
       'aucun choix ne se posait : rien à comparer');
    ok(WesternMatches(promote, 'KNk7-k9=+KN+', () => 'O')
       && !WesternMatches(promote, 'KNk7-k9=KN', () => 'O'),
       'les deux versions se distinguent');

    // Le fichier C22, 33 demi-coups, dont deux coups de Lion à deux pas.
    const c22 = readFileSync(path.join(root, 'tests', 'fixtures/chushogilite/chushogilite-c22.pgn'), 'utf-8');
    const t22 = {};
    for (const line of c22.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) t22[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    const tk = ExtractMoves(c22);
    const match = await Jocly.createMatch('chu-shogi');
    await match.load({ game: 'chu-shogi', initialBoard: PgnFenToJocly(BookFen(t22)),
                       playedMoves: [], tsume: IsTsume(c22, t22) });
    const r = await ReplayBookMoves(tk, {
        pick: (s) => match.pickMove(s).catch(() => null),
        exact: westernResolver(match),
        play: (m) => match.playMove(m),
    });
    ok(r.unresolved === null && r.played === tk.length,
       `${r.played}/${tk.length} demi-coups rejoués` + (r.unresolved ? ` — bloqué sur « ${r.unresolved} »` : ''));
}

console.log('Enregistrer un tsume en PJN');
{
    // La marque va en COMMENTAIRE, pas dans un tag : c'est la forme qu'écrit
    // ChuShogiLite et celle que IsTsume relit. Un tag de notre invention
    // obligerait l'autre bout à apprendre notre convention pour rien.
    const pjn = BuildPJN('chu-shogi', ['a', 'b'], 'X w - - 0 1', new Date(2026, 0, 1), { tsume: true });
    ok(/\{Tsume\}/.test(pjn), 'la marque est écrite');
    ok(IsTsume(pjn, {}), 'et se relit — le fichier enregistré rouvre en mode tsume');
    ok(!IsTsume(BuildPJN('x', ['a'], null, new Date(2026, 0, 1), {}), {}),
       'une partie ordinaire n\'en porte pas');
}

console.log('Une position sans roi est signalée');
{
    const fen = PgnFenToJocly(BookFen(tags)).split(' ')[0];
    ok(SideWithoutKing(fen) === 'white',
       'le camp attaquant du tsume est repéré comme sans roi');
    ok(SideWithoutKing('rnbqkbnr/8/8/8/8/8/8/RNBQKBNR w - - 0 1') === null,
       'une position ordinaire ne déclenche rien');
    ok(SideWithoutKing('8/8/8/8/8/8/8/8 w - - 0 1') === 'both', 'plateau vide : les deux');
    ok(SideWithoutKing('') === null && SideWithoutKing(null) === null,
       'entrée vide : rien, pas d\'exception');
}

console.log('Le découpage en parties, sur lequel tout repose');
{
    // Reproduction du découpage de parse_pjn (fs_cmds.rs). C'est ce que la
    // fenêtre livre reçoit — et NON le fichier entier, sur lequel portaient
    // jusqu'ici toutes les assertions de rejeu de cette suite. Le décalage
    // entre les deux est ce qui a laissé passer le défaut : les coups étaient
    // trouvés dans le fichier complet et perdus par le chemin réel.
    const SplitPjn = (txt) => {
        const b = txt.replace(/\r\n?/g, '\n').split('\n\n').map(x => x.trim()).filter(Boolean);
        const out = [];
        for (let i = 0; i < b.length; ) {
            if (!b[i].startsWith('[')) { i++; continue; }
            let j = i + 1;
            while (j < b.length && !b[j].startsWith('[')) j++;
            out.push([b[i], ...b.slice(i + 1, j)].join('\n\n'));
            i = j;
        }
        return out;
    };

    // ChuShogiLite intercale un diagramme du plateau entre l'en-tête et les
    // coups, séparé par des lignes vides. S'arrêter au bloc suivant donnait
    // une partie faite des tags et du diagramme, sans un seul coup : la
    // fenêtre Historique restait vide et rien ne le signalait.
    for (const [name, count] of [['fixtures/chushogilite/chushogilite.pgn', 17],
                                 ['fixtures/chushogilite/chushogilite-c22.pgn', 33]]) {
        const txt = readFileSync(path.join(root, 'tests', name), 'utf-8');
        const parts = SplitPjn(txt);
        ok(parts.length === 1, `${name} : une seule partie (${parts.length})`);
        ok(/\{-+/.test(parts[0]), 'le diagramme est entre les tags et les coups');
        ok(ExtractMoves(parts[0]).length === count,
           `${count} coups par le chemin réel (${ExtractMoves(parts[0]).length})`);
    }

    // Le témoin : un PGN sans diagramme, dont les coups suivent les tags.
    // C'est lui qui s'affichait correctement dans l'Historique, et il doit
    // continuer — la correction élargit l'appariement, elle ne le déplace pas.
    const cz = readFileSync(path.join(root, 'tests', 'fixtures/jocly/crazyhouse.pgn'), 'utf-8');
    const czParts = SplitPjn(cz);
    ok(czParts.length === 1, 'crazyhouse : une partie');
    const czMoves = ExtractMoves(czParts[0]);
    ok(czMoves.length === 112, `56 coups entiers, soit 112 demi-coups (${czMoves.length})`);
    ok(czMoves.includes('N@h5') && czMoves.includes('O-O'),
       'parachutages et roque figurent parmi les coups');

    // Ce fichier porte du texte libre APRÈS la partie — un résumé, puis un
    // extrait de format CSA — et sans ligne vide pour l'en séparer. Le
    // découpage ne peut pas savoir où une partie s'arrête : un commentaire
    // peut aussi PRÉCÉDER les coups, c'est tout le cas du chu shogi. C'est
    // donc ExtractMoves qui tranche, sur le jeton de résultat, comme la
    // spécification PGN le prescrit.
    ok(cz.includes('csaV2.2'), 'le fichier porte bien du texte libre après la partie');
    ok(czMoves[czMoves.length - 1] === 'R@g1#',
       'l\'extraction s\'arrête au mat, pas dans le texte qui suit — ' + czMoves.slice(-1));
    ok(!czMoves.some(m => /csa|Classé|ans/i.test(m)),
       'aucun mot du texte libre ne se retrouve pris pour un coup');
}

console.log('Écrire la notation occidentale : l\'aller-retour');
{
    // L'épreuve : rejouer chaque fichier réel et RÉÉCRIRE chaque coup dans la
    // notation de ChuShogiLite. Le résultat doit être le fichier de départ,
    // jeton pour jeton. Comparer à une valeur écrite à la main ne prouverait
    // que mon interprétation ; comparer à ce que l'applet a produit prouve
    // l'interopérabilité.
    for (const [name, expected] of [['fixtures/chushogilite/chushogilite.pgn', 17],
                                    ['fixtures/chushogilite/chushogilite-c22.pgn', 33]]) {
        const txt = readFileSync(path.join(root, 'tests', name), 'utf-8');
        const tg = {};
        for (const line of txt.split('\n')) {
            const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
            if (m) tg[m[1]] = m[2].replace(/^"|"$/g, '');
        }
        const tokens = ExtractMoves(txt);
        const match = await Jocly.createMatch('chu-shogi');
        await match.load({ game: 'chu-shogi', initialBoard: PgnFenToJocly(BookFen(tg)),
                           playedMoves: [], tsume: IsTsume(txt, tg) });

        const written = [];
        for (const token of tokens) {
            // État AVANT le coup : c'est lui qui donne la lettre de la pièce
            // et les rivales, exactement comme getSANDisambiguation les lit.
            const legal = await match.getPossibleMoves();
            const naturals = await match.getMoveString(legal);
            const letterAt = boardLetters(await match.getBoardState());
            const chosen = await westernResolver(match)(token);
            const idx = legal.findIndex(m => m === chosen);
            const mine = { ...ParseNaturalMove(naturals[idx]), from: await fromSquare(match, chosen, naturals[idx]) };
            const letter = mine.from ? letterAt(mine.from) : null;

            // Rivales : les autres coups légaux de la MÊME pièce menant aux
            // mêmes cases. C'est ce que CSL appelle « rivals ».
            const rivals = [];
            for (let i = 0; i < legal.length; i++) {
                if (i === idx) continue;
                const other = ParseNaturalMove(naturals[i]);
                if (!other || other.steps.length !== mine.steps.length) continue;
                if (!other.steps.every((st, k) => st.square === mine.steps[k].square)) continue;
                const f = other.from;
                // La MÊME pièce n'est pas sa propre rivale : elle offre deux
                // coups pour un seul déplacement, promouvoir ou non. CSL
                // écarte sa propre case de la même façon.
                if (f && f !== mine.from && letterAt(f) === letter) rivals.push(f);
            }
            written.push(BuildWesternMove(mine, letter, rivals));
            await match.playMove(chosen);
        }
        ok(written.length === expected, `${name} : ${written.length} coups réécrits`);
        ok(written.join(' ') === tokens.join(' '),
           'réécrits À L\'IDENTIQUE de ce qu\'a produit l\'applet'
           + (written.join(' ') === tokens.join(' ') ? ''
              : ' — ' + written.find((w, i) => w !== tokens[i]) + ' au lieu de '
                + tokens[written.findIndex((w, i) => w !== tokens[i])]));
    }

    // Le tag [FEN] : cinq champs, trait inchangé.
    const sfen = 'board w 6f 2';
    ok(SfenToPgnFen(sfen) === 'board b 6f 0 1',
       '[FEN] à cinq champs, « 0 1 » ajoutés, trait inversé depuis le SFEN');
    // Trois conventions : SFEN « b » = sente, jocly note ce trait « w », et le
    // PGN de l'applet écrit l'inverse de son SFEN — donc PGN == jocly.
    ok(PgnFenToJocly(SfenToPgnFen(sfen)).split(' ')[1] === 'b',
       'et l\'aller-retour redonne le trait de jocly');
    ok(SfenToPgnFen('board w - - 0 1') === null, 'un FEN jocly à six champs n\'est pas converti');
}

console.log('Le fichier exporté se relit — par Tabulon, et comme l\'applet l\'écrit');
{
    // Boucle complète : lire le fichier de l'applet, le rejouer, le RÉÉCRIRE
    // entièrement, puis relire le résultat. Le tour de force n'est pas d'y
    // arriver mais de tomber sur le fichier de départ : c'est ce qui prouve
    // que l'export est lisible par le destinataire et pas seulement par nous.
    const src = readFileSync(path.join(root, 'tests', 'fixtures/chushogilite/chushogilite-c22.pgn'), 'utf-8');
    const tg = {};
    for (const line of src.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) tg[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    const tokens = ExtractMoves(src);
    const match = await Jocly.createMatch('chu-shogi');
    const sfen0 = BookFen(tg);
    await match.load({ game: 'chu-shogi', initialBoard: PgnFenToJocly(sfen0),
                       playedMoves: [], tsume: true });

    const written = [];
    for (const token of tokens) {
        const legal = await match.getPossibleMoves();
        const naturals = await match.getMoveString(legal);
        const letterAt = boardLetters(await match.getBoardState());
        const chosen = await westernResolver(match)(token);
        const idx = legal.findIndex(m => m === chosen);
        const mine = { ...ParseNaturalMove(naturals[idx]),
                       from: await fromSquare(match, chosen, naturals[idx]) };
        const letter = mine.from ? letterAt(mine.from) : null;
        const rivals = [];
        for (let i = 0; i < legal.length; i++) {
            if (i === idx) continue;
            const other = ParseNaturalMove(naturals[i]);
            if (!other || other.steps.length !== mine.steps.length) continue;
            if (!other.steps.every((st, k) => st.square === mine.steps[k].square)) continue;
            if (other.from && other.from !== mine.from && letterAt(other.from) === letter)
                rivals.push(other.from);
        }
        written.push(BuildWesternMove(mine, letter, rivals));
        await match.playMove(chosen);
    }

    const out = BuildPGN(written, await (async () => {
        const m2 = await Jocly.createMatch('chu-shogi');
        await m2.load({ game: 'chu-shogi', initialBoard: PgnFenToJocly(sfen0), playedMoves: [], tsume: true });
        return m2.getBoardState('sfen');
    })(), { event: 'C22', variant: 'chu', tsume: true });

    // 1. Les tags que l'applet attend.
    for (const tag of ['[Variant "chu"]', '[SetUp "1"]', '[FEN "'])
        ok(out.includes(tag), 'tag présent : ' + tag);
    ok(/\[FEN "[^"]+ [bw] \S+ 0 1"\]/.test(out), '[FEN] à cinq champs, comme l\'applet l\'écrit');
    ok(out.trimEnd().endsWith('*'), 'le texte des coups se termine par le marqueur de partie inachevée');

    // 2. Le [FEN] écrit est celui du fichier d'origine.
    const outTags = {};
    for (const line of out.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) outTags[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    ok(BookFen(outTags) === BookFen(tg),
       'la position exportée est exactement celle du fichier lu');

    // 3. Les coups aussi, jeton pour jeton.
    ok(ExtractMoves(out).join(' ') === tokens.join(' '),
       `${ExtractMoves(out).length} coups identiques à l'original`);
    ok(MoveFormat(ExtractMoves(out)) === 'western', 'et reconnus comme occidentaux à la relecture');
    ok(IsTsume(out, outTags), 'la marque {Tsume} survit à l\'aller-retour');

    // 4. Numérotation : le numéro sur le coup des Blancs, « 1... » si les
    //    Noirs commencent. Ici les Blancs commencent.
    ok(/\{Tsume\} 1\. \S+ \S+ 2\. /.test(out),
       'numérotation par paires — ' + out.split('\n\n')[1].slice(0, 34));
    // SFEN « w » -> PGN « b » : ce sont les Noirs qui ouvrent, et leur
    // premier coup porte « 1... », seule occurrence de cette forme.
    const black = BuildPGN(['a1', 'b2'], 'board w - 1', {});
    ok(black.includes('[FEN "board b - 0 1"]') && black.includes('1... a1'),
       'et « 1... » quand les Noirs ouvrent — ' + black.split('\n\n')[1].trim());
}

console.log('Une partie ordinaire, sans position de départ');
{
    // Le cas signalé : une partie de chu shogi jouée depuis le début, donc
    // sans tag [FEN]. L'export la refusait, parce qu'il exigeait une position
    // de départ — or ChuShogiLite n'écrit [FEN] que pour une position NON
    // standard. La position est facultative ; les coups sont l'essentiel.
    const pjn = readFileSync(path.join(root, 'tests', 'fixtures/chushogilite/chu-ordinaire.pjn'), 'utf-8');
    const tokens = ExtractMoves(pjn);
    ok(tokens.length === 6, `${tokens.length} coups en notation jocly`);
    ok(BookFen({}) === null, 'et aucune position de départ dans le fichier');

    const match = await Jocly.createMatch('chu-shogi');
    await match.load({ game: 'chu-shogi', playedMoves: [] });
    const r = await ReplayBookMoves(tokens, {
        pick: (s) => match.pickMove(s).catch(() => null),
        play: (m) => match.playMove(m),
    });
    ok(r.played === tokens.length, 'rejoués depuis la position standard');

    // Réécriture, sans SFEN : le PGN doit sortir sans [FEN] ni [SetUp], et
    // rester relisible.
    const played = await match.getPlayedMoves();
    await match.rollback(0);
    const written = [];
    for (let ply = 0; ply < played.length; ply++) {
        const legal = await match.getPossibleMoves();
        const naturals = await match.getMoveString(legal);
        const letterAt = boardLetters(await match.getBoardState());
        const idx = legal.findIndex(m => m.f === played[ply].f && m.t === played[ply].t);
        const mine = { ...ParseNaturalMove(naturals[idx]),
                       from: await fromSquare(match, legal[idx], naturals[idx]) };
        written.push(BuildWesternMove(mine, mine.from ? letterAt(mine.from) : null, []));
        await match.rollback(ply + 1);
    }
    ok(written.every(w => w && w !== '?'), 'tous les coups se traduisent — ' + written.join(' '));
    ok(written[0] === 'Pe5' && written[1] === 'Nf8',
       'la lettre vient du plateau, en majuscules quel que soit le camp');

    const pgn = BuildPGN(written, null, { event: 'ordinaire', variant: 'chu' });
    ok(!/\[FEN /.test(pgn) && !/\[SetUp /.test(pgn),
       'sans position de départ, ni [FEN] ni [SetUp] — comme l\'applet');
    ok(ExtractMoves(pgn).join(' ') === written.join(' '), 'et le fichier se relit');
    ok(/^1\. Pe5 Nf8 2\./.test(ExtractMoves(pgn).length ? pgn.split('\n\n')[1] : ''),
       'numérotation depuis les Blancs, faute de [FEN] pour dire le contraire');
}

console.log('Le [FEN] d\'un PGN de shogi (PyChess)');
{
    // PyChess écrit la réserve à la manière du crazyhouse — entre crochets,
    // collée au plateau — là où le SFEN standard en fait un champ séparé.
    // Sans conversion, jocly compte les crochets comme des cases : « rank 9
    // covers 12 files, expected 9 », puis le chargement casse plus loin sur un
    // plateau à moitié construit.
    const pgnFen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL[-] w 0 1';
    const sfen = PgnFenToShogiSfen(pgnFen);
    ok(sfen === 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
       'réserve extraite en champ, « 0 1 » ramenés au numéro de coup — ' + sfen);
    ok(PgnFenToShogiSfen('board[2Pl] b 0 12') === 'board w 2Pl 12',
       'une réserve non vide passe telle quelle');
    ok(PgnFenToShogiSfen('board w - 0 1') === null,
       'un [FEN] sans crochets n\'est pas concerné — c\'est le dialecte du chu');

    // Le trait s'inverse, comme au chu shogi : le [FEN] du PGN est dans la
    // convention de jocly, le SFEN dans l'inverse, et ImportSFEN rééchange.
    const match = await Jocly.createMatch('shogi');
    await match.load({ game: 'shogi', initialBoard: sfen, playedMoves: [] });
    ok((await match.getBoardState()).split(' ')[1] === 'w',
       'chargé avec le trait aux Blancs, celui qu\'annonce le PGN');
    const legal = await match.getMoveString(await match.getPossibleMoves());
    ok(legal.length === 30, `${legal.length} coups légaux à la position de départ`);
    ok(legal.includes('a3-a4'), 'et ce sont bien ceux des Blancs — ' + legal.slice(0, 3).join(' '));
}

console.log('KIF : lecture et rejeu');
{
    // Résolution par les CASES : le KIF donne la case de départ de chaque
    // coup, ce qui suffit à le désigner — c'est même plus simple que le PGN,
    // où l'origine est omise et où il faut la déduire.
    const bySquares = (match) => async (token) => {
        const m = /^([a-l]\d{1,2}(?:-[a-l]\d{1,2})+)([+=]?)$/.exec(String(token || '').trim());
        if (!m) return null;
        const want = m[1].split('-');
        const promote = m[2] === '+' ? true : (m[2] === '=' ? false : null);
        const moves = await match.getPossibleMoves();
        const naturals = await match.getMoveString(moves);
        let found = null;
        for (let i = 0; i < moves.length; i++) {
            const p = ParseNaturalMove(naturals[i]);
            if (!p) continue;
            const sq = [p.from, ...p.steps.map(st => st.square)].filter(Boolean);
            const target = sq.length === want.length ? want : want.slice(want.length - sq.length);
            if (sq.length !== target.length || !sq.every((x, k) => x === target[k])) continue;
            if (promote !== null && p.promote !== null && p.promote !== promote) continue;
            if (found) return null;
            found = moves[i];
        }
        return found;
    };

    for (const [name, count] of [['fixtures/kif/chushogilite-d22.kif', 17],
                                 ['fixtures/kif/chushogilite-c22.kif', 33]]) {
        const text = readFileSync(path.join(root, 'tests', name), 'utf-8');
        ok(IsChuKif(text), `${name} : reconnu comme KIF de chu shogi`);
        const kif = ParseKif(text);
        ok(kif && kif.moves.length === count, `${count} coups lus (${kif?.moves.length})`);
        ok(kif.tsume, 'le commentaire « * Tsume … » active le mode tsume');

        const match = await Jocly.createMatch('chu-shogi');
        await match.load({ game: 'chu-shogi', initialBoard: `${kif.board} ${kif.turn} -`,
                           playedMoves: [], tsume: kif.tsume });
        const r = await ReplayBookMoves(kif.moves, {
            pick: (s) => match.pickMove(s).catch(() => null),
            exact: bySquares(match),
            play: (m) => match.playMove(m),
        });
        ok(r.unresolved === null && r.played === count,
           `${r.played}/${count} coups rejoués` + (r.unresolved ? ` — bloqué sur « ${r.unresolved} »` : ''));
    }

    // Le plateau lu dans le KIF est celui du PGN de la MÊME partie : deux
    // formats, deux chemins de lecture indépendants, un seul résultat.
    const kif = ParseKif(readFileSync(path.join(root, 'tests', 'fixtures/kif/chushogilite-c22.kif'), 'utf-8'));
    const twin = readFileSync(path.join(root, 'tests', 'fixtures/chushogilite/chushogilite-c22.pgn'), 'utf-8');
    const twinTags = {};
    for (const line of twin.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) twinTags[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    ok(kif.board === BookFen(twinTags).split(' ')[0],
       'plateau identique à celui du PGN jumeau, octet pour octet');
    ok(kif.moves.length === ExtractMoves(twin).length,
       `et le même nombre de coups (${kif.moves.length})`);

    // Les coups à deux pas du Lion occupent DEUX lignes sous un même numéro.
    ok(kif.moves.filter(m => m.split('-').length === 3).length === 2,
       'les deux coups à deux pas sont recollés, pas comptés double');
    // La promotion est un suffixe « 成 » sur le nom de pièce ; sans elle, les
    // deux versions du déplacement correspondent et la lecture s'arrête.
    ok(kif.moves.some(m => m.endsWith('+')), 'la promotion est lue');

    // Le KIF du shogi orthodoxe est un AUTRE dialecte — position standard
    // déclarée par « 手合割 », coordonnées pleine largeur, parachutages,
    // « même case ». Il doit être refusé plutôt que lu de travers.
    const shogi = readFileSync(path.join(root, 'tests', 'fixtures/kif/shogi-lishogi.kif'), 'utf-8');
    ok(!IsChuKif(shogi), 'un KIF de shogi orthodoxe n\'est pas pris pour du chu');
}

console.log('');
console.log(`RESULTAT chushogi-pgn: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
