// test-remote-relay-protocol.mjs — logique pure du protocole de relai
// (encodage/décodage de l'enveloppe, détection de coup adverse).
// Usage : node tests/test-remote-relay-protocol.mjs
import {
    encodeEnvelope, decodeEnvelope, hasOpponentMoved,
    buildSaveBody, buildLoadBody, generateMatchId,
} from '../app/content/remote-relay-protocol.js';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── 1. Aller-retour encode/decode ────────────────────────────────────────────
{
    const json = encodeEnvelope({ nbTurns: 3, lastMove: { from: 'e2', to: 'e4' }, state: { fen: 'abc' } });
    const decoded = decodeEnvelope(json);
    assert(decoded.nbTurns === 3, 'aller-retour : nbTurns préservé');
    assert(decoded.lastMove.to === 'e4', 'aller-retour : lastMove préservé');
    assert(decoded.state.fen === 'abc', 'aller-retour : state préservé');
    assert(typeof decoded.updatedAt === 'number', 'aller-retour : updatedAt horodaté');
}

// ── 2. Valeurs par défaut ────────────────────────────────────────────────────
{
    const decoded = decodeEnvelope(encodeEnvelope({ nbTurns: 0 }));
    assert(decoded.lastMove === null && decoded.state === null,
        'lastMove/state par défaut = null quand omis');
}

// ── 3. decodeEnvelope robuste aux entrées invalides ──────────────────────────
assert(decodeEnvelope('') === null, 'decodeEnvelope("") -> null (partie pas encore créée)');
assert(decodeEnvelope('   ') === null, 'decodeEnvelope(blanc) -> null');
assert(decodeEnvelope('<html>erreur 404</html>') === null, 'decodeEnvelope(HTML/erreur) -> null, pas d’exception');
assert(decodeEnvelope('{"foo":"bar"}') === null, 'decodeEnvelope(JSON sans nbTurns) -> null');
assert(decodeEnvelope(null) === null, 'decodeEnvelope(null) -> null');

// ── 4. encodeEnvelope valide ses entrées ─────────────────────────────────────
{
    let threw = false;
    try { encodeEnvelope({ nbTurns: -1 }); } catch { threw = true; }
    assert(threw, 'encodeEnvelope rejette un nbTurns négatif');
}
{
    let threw = false;
    try { encodeEnvelope({ nbTurns: 1.5 }); } catch { threw = true; }
    assert(threw, 'encodeEnvelope rejette un nbTurns non entier');
}

// ── 5. hasOpponentMoved ───────────────────────────────────────────────────────
assert(hasOpponentMoved(2, { nbTurns: 3 }) === true, 'hasOpponentMoved : distant en avance -> true');
assert(hasOpponentMoved(3, { nbTurns: 3 }) === false, 'hasOpponentMoved : à jour -> false');
assert(hasOpponentMoved(3, { nbTurns: 2 }) === false, 'hasOpponentMoved : distant en retard -> false (jamais en arrière)');
assert(hasOpponentMoved(0, null) === false, 'hasOpponentMoved : rien côté relai -> false');

// ── 6. Corps de requête compatibles fileio.php ───────────────────────────────
{
    const save = buildSaveBody('abc-0', '{"nbTurns":1}');
    assert(save.get('gameioaction') === 'save', 'buildSaveBody : gameioaction=save');
    assert(save.get('gameid') === 'abc-0', 'buildSaveBody : gameid transmis');
    assert(save.get('gamedata') === '{"nbTurns":1}', 'buildSaveBody : gamedata = enveloppe JSON');

    const load = buildLoadBody('abc-0');
    assert(load.get('gameioaction') === 'load', 'buildLoadBody : gameioaction=load');
    assert(!load.has('gamedata'), 'buildLoadBody : pas de gamedata');
}
{
    let threw = false;
    try { buildSaveBody('', '{}'); } catch { threw = true; }
    assert(threw, 'buildSaveBody rejette un gameId vide');
}

// ── 7. Identifiants de partie non-devinables ─────────────────────────────────
{
    const a = generateMatchId();
    const b = generateMatchId();
    assert(a !== b, 'generateMatchId : deux appels donnent deux identifiants différents');
    assert(a.length >= 16, 'generateMatchId : longueur suffisante pour ne pas être devinable');
}

console.log(`\n${passed} assertions passées.`);
