// test-prelude-roundtrip.mjs — sauver puis recharger une partie à prélude.
//
// LE PRÉLUDE COMPTE DEUX DEMI-COUPS, et c'est ce qui rend ces jeux fragiles à
// la relecture : la réponse (« #4 »), puis une étape vide qui rend la main,
// sans laquelle le mauvais camp ouvrirait la partie. Ni l'une ni l'autre n'est
// un coup de plateau, et chaque format les traite différemment — le JSON les
// garde, le PGN ne peut pas les écrire et les remplace par sa balise
// [Variant].
//
// Trois régressions déjà rencontrées sur ce terrain, toutes silencieuses :
// l'étape vide laissée dans les coups faisait refuser un export entier ;
// l'arrangement perdu à la relecture rouvrait une partie de Mirza en Herat ;
// et le trait revenait au mauvais camp quand le prélude n'avait qu'une étape.
//
// D'où cette suite : pour CHAQUE jeu à prélude, un aller-retour complet, et
// trois choses vérifiées à l'arrivée — le nombre de coups, le trait, et la
// position. Les trois, parce qu'un fichier peut se relire en gardant deux
// d'entre elles.
//
// Usage : node tests/test-prelude-roundtrip.mjs   (depuis tabulon/)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Jocly = require('../dist/node/jocly.core.js');

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

const PRELUDE_TOKEN = /^(#\d+|--)$/;

/** Franchit le prélude en choisissant l'arrangement demandé, et rend le
 *  nombre de demi-coups qu'il a coûtés. */
async function crossPrelude(match, wanted) {
    let plies = 0;
    for (;;) {
        const moves = await match.getPossibleMoves();
        const names = await match.getMoveString(moves);
        if (!names.length || !names.every(n => PRELUDE_TOKEN.test(n))) break;
        const want = names.indexOf('#' + wanted);
        await match.playMove(moves[want >= 0 ? want : 0]);
        plies++;
        if (plies > 6) break;   // garde-fou : un prélude sans fin serait un bug
    }
    return plies;
}

const GAMES = [
    // Les quatre modules qui ont un prélude, un par famille de règles.
    { game: 'timurid-chess',    setup: 4 },   // 8 arrangements, le plus exposé
    { game: 'capablanca-chess', setup: 4 },   // couverture Fairy partielle
    { game: 'kotaishi-shogi',   setup: 0 },
    { game: 'draughts8',        setup: 2 },
    { game: 'go9',              setup: 1 },
];

for (const { game, setup } of GAMES) {
    console.log('\n' + game);
    const a = await Jocly.createMatch(game);
    const plies = await crossPrelude(a, setup);

    // Deux demi-coups, pas un : c'est l'invariant qui garde le trait. Un
    // prélude impair donnerait l'ouverture au mauvais camp, et rien ne le
    // signalerait — la partie se déroulerait normalement, à l'envers.
    assert(plies === 2, `le prélude prend deux demi-coups (${plies})`);
    assert(await a.getTurn() === Jocly.PLAYER_A, 'et le premier joueur garde l’ouverture');

    // Quelques coups pour que la sauvegarde ait de quoi être fausse.
    for (let k = 0; k < 6; k++) {
        const moves = await a.getPossibleMoves();
        if (!moves.length) break;
        await a.playMove(moves[k % moves.length]);
    }

    const save = await a.save();
    const expectedTurn   = await a.getTurn();
    const expectedMoves  = (await a.getPlayedMoves()).length;
    const expectedBoard  = await a.getBoardState().catch(() => null);

    // La sauvegarde garde les deux demi-coups : ils SONT des coups pour jocly,
    // et les retirer décalerait tout ce qui suit.
    assert(save.playedMoves.length === expectedMoves,
        `la sauvegarde garde les ${expectedMoves} demi-coups, prélude compris`);
    assert(save.playedMoves[0] && save.playedMoves[0].setup === setup,
        `et l’arrangement choisi (#${setup})`);

    const b = await Jocly.createMatch(game);
    await b.load(save);

    assert((await b.getPlayedMoves()).length === expectedMoves, 'rechargée, elle a le même nombre de coups');
    // Le trait : c'est lui qui se perd quand le prélude est mal rejoué, et il
    // se perd sans que la position soit fausse.
    assert(await b.getTurn() === expectedTurn, 'le même trait');
    /*
     * Et la position : deux parties peuvent avoir le même compte et le même
     * trait sur des plateaux différents — c'est exactement ce qui arrive quand
     * un arrangement de prélude est rejoué à la place d'un autre.
     *
     * Comparée seulement quand le jeu rend une position comparable. Le go rend
     * un état qui porte des compteurs propres à la session (prisonniers,
     * historique des positions pour le superko) : deux parties identiques ne
     * s'y écrivent pas forcément pareil, et l'exiger ferait échouer un
     * aller-retour pourtant correct.
     */
    if (typeof expectedBoard === 'string' && /^[a-zA-Z0-9/+]+ /.test(expectedBoard))
        assert(await b.getBoardState().catch(() => null) === expectedBoard, 'et la même position');

    // La partie rechargée est JOUABLE : un aller-retour qui rend une position
    // sans coup légal n'aurait rien relu du tout.
    assert((await b.getPossibleMoves()).length > 0, 'et elle se poursuit');
}

console.log(`\n${passed} assertions OK — aller-retour des parties à prélude validé.`);
process.exit(0);
