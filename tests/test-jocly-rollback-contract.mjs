// tests/test-jocly-rollback-contract.mjs
//
// CONTRAT DE DEPENDANCE, pas test de Tabulon. Cette suite verifie ce que
// Tabulon attend de `Match.rollback()` cote jocly2. Elle n'exerce aucun
// fichier de app/content/ : son role est de faire echouer `npm test` le jour
// ou une mise a jour du dist/ change la semantique sous nos pieds.
//
// Pourquoi ce filet. La fenetre Historique navigue EN AVANT autant qu'en
// arriere : « coup suivant », « fin » et la lecture automatique appellent tous
// `rollback(index)` avec un index SUPERIEUR a la position courante. Cela ne
// marche que parce que l'index est borne contre `mFullPlayedMoves` (la ligne
// enregistree) et non `mPlayedMoves` (les coups jusqu'a la position courante).
// C'est un detail d'implementation de jocly dont depend une fonctionnalite
// visible, et une correction bien intentionnee cote moteur -- par exemple
// rendre les index negatifs relatifs a la position courante -- pourrait le
// remettre en cause sans que rien d'autre ne le signale : la fenetre
// Historique se figerait a nouveau sur « precedent » sans erreur en console.
//
// Tabulon n'appelle JAMAIS rollback() sans argument ni avec un index negatif
// (verifie par la derniere assertion). Les points 1 et 2 de la note envoyee a
// jocly ne l'exposent donc pas ; ce qui l'expose, c'est le referentiel de
// l'index, teste ici.
//
// Usage : npm test  (ou node tests/test-jocly-rollback-contract.mjs)
import { createRequire } from 'module';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const Jocly = require(path.join(root, 'dist/node/jocly.core.js'));

const match = await Jocly.createMatch('classic-chess');
await match.load({ game: 'classic-chess', playedMoves: [] });
const plies = async () => (await match.getPlayedMoves()).length;
async function play(san) {
    for (const mv of await match.getPossibleMoves())
        if (await match.getMoveString(mv) === san) return match.playMove(mv);
    throw new Error('coup introuvable : ' + san);
}

for (const san of ['e2-e4', 'e7-e5', 'Ng1-f3', 'Nb8-c6']) await play(san);
ok(await plies() === 4, '4 coups joues');

console.log('Index absolu, dans les deux sens');
{
    await match.rollback(2);
    ok(await plies() === 2, 'rollback(2) recule a 2 coups');

    // LE point sensible : index superieur a la position courante.
    await match.rollback(3);
    ok(await plies() === 3, 'rollback(3) AVANCE — bouton « coup suivant » de l\'Historique');
    await match.rollback(4);
    ok(await plies() === 4, 'rollback(4) va jusqu\'au bout — bouton « fin »');

    await match.rollback(0);
    ok(await plies() === 0, 'rollback(0) revient au debut — bouton « recommencer »');
    await match.rollback(4);
    ok(await plies() === 4, 'et on peut re-avancer depuis le debut — lecture automatique');
}

console.log('Bornes et divergence');
{
    await match.rollback(99);
    ok(await plies() === 4, 'un index au-dela de la fin est borne, sans exception');
    await match.rollback(-99);
    ok(await plies() === 0, 'un index tres negatif est borne a 0, sans exception');

    // Reprendre la partie a partir d'un coup anterieur doit tronquer la ligne
    // enregistree : c'est le bouton « Reprendre » de l'Historique.
    await match.rollback(4);
    await match.rollback(2);
    await play('d2-d4');
    ok(await plies() === 3, 'jouer autre chose depuis le milieu donne bien 3 coups');
    await match.rollback(99);
    ok(await plies() === 3,
       'et tronque la suite enregistree : on ne peut plus re-avancer vers l\'ancienne ligne');
}

console.log('Etat utilisable apres rollback');
{
    // Ce qui avait ete pris a tort pour une corruption d'etat : verifions que
    // la position rejouee est bien celle attendue et qu'on peut continuer.
    await match.rollback(0);
    const start = await match.getBoardState();
    await play('e2-e4');
    await match.rollback(0);
    ok(await match.getBoardState() === start,
       'rollback(0) restaure exactement la position de depart');
    const moves = await match.getPossibleMoves();
    ok(moves.length === 20, `20 coups legaux a la position initiale (${moves.length})`);
    await match.playMove(moves[0]);
    ok(await plies() === 1, 'et un coup genere apres rollback s\'applique sans erreur');
}

console.log('Coup ayant transite par JSON');
{
    // Tabulon applique des coups qu'il n'a pas produits lui-meme : le coup
    // recu du relai distant (gameLoop, tour `level.remote`) et celui choisi
    // dans la fenetre « Possible moves » (`input-move`). Les deux ont ete
    // serialises en JSON entre-temps, donc ce ne sont plus les objets rendus
    // par getPossibleMoves() mais des copies nues, sans prototype.
    //
    // jocly refuse desormais un coup produit pour une AUTRE position (ajout
    // demande dans la note sur rollback). Ce controle passe par Equals() : il
    // ne doit pas rejeter au passage un coup legitime qui a simplement fait
    // l'aller-retour JSON, sinon le jeu en reseau et la fenetre des coups
    // possibles cassent tous les deux, sans que rien d'autre ne le signale.
    await match.rollback(0);
    const fresh = await match.getPossibleMoves();
    const wire  = JSON.parse(JSON.stringify(fresh[0]));
    let err = null;
    try { await match.playMove(wire); } catch (e) { err = e; }
    ok(!err, 'un coup serialise en JSON reste jouable' + (err ? ' — ' + err.message : ''));
    ok(await plies() === 1, 'et il compte bien comme un coup joue');

    // Le relai ajoute ses propres champs autour du coup ; ils ne doivent pas
    // le rendre meconnaissable.
    await match.rollback(0);
    const tagged = { ...JSON.parse(JSON.stringify((await match.getPossibleMoves())[1])), sentAt: 1, from: 'peer' };
    let err2 = null;
    try { await match.playMove(tagged); } catch (e) { err2 = e; }
    ok(!err2, 'des champs supplementaires ne le disqualifient pas' + (err2 ? ' — ' + err2.message : ''));
    await match.rollback(0);
}

console.log('Usage reel dans le code de Tabulon');
{
    // Si un appel sans argument ou a index negatif apparaissait un jour dans
    // app/content/, les points 1 et 2 de la note deviendraient nos problemes.
    // Mieux vaut l'apprendre ici que par un bug de navigation.
    const content = path.join(root, 'app', 'content');
    const calls = [];
    for (const file of readdirSync(content).filter(f => f.endsWith('.js'))) {
        const src = readFileSync(path.join(content, file), 'utf-8');
        for (const m of src.matchAll(/\.rollback\s*\(([^)]*)\)/g))
            calls.push({ file, arg: m[1].trim() });
    }
    ok(calls.length > 0, `${calls.length} appel(s) a rollback() dans app/content/`);
    const bare = calls.filter(c => c.arg === '');
    ok(bare.length === 0,
       'aucun rollback() sans argument — il reviendrait au DEBUT de la partie, en silence'
       + (bare.length ? ' : ' + bare.map(c => c.file).join(', ') : ''));
    const neg = calls.filter(c => /^-\d/.test(c.arg));
    ok(neg.length === 0,
       'aucun index negatif en dur — il est relatif a la ligne enregistree, pas a la position'
       + (neg.length ? ' : ' + neg.map(c => c.file + ' (' + c.arg + ')').join(', ') : ''));
}

console.log('');
console.log(`RESULTAT jocly-rollback-contract: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
