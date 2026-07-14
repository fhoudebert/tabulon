// test-remote-relay-protocol.mjs — logique pure du protocole de relai
// (encodage/décodage de l'enveloppe, détection de coup adverse).
// Usage : node tests/test-remote-relay-protocol.mjs
import {
    encodeEnvelope, decodeEnvelope, hasOpponentMoved,
    buildSaveBody, buildLoadBody, generateMatchId,
    encodeJoclySimpleMatchEnvelope, decodeJoclySimpleMatchEnvelope,
    parseInvitationUrl, buildInvitationUrl,
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

// ── 8. Codec compatible jocly-simple-match (interop réelle) ─────────────────
{
    const matchdata = { playedMoves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], board: 'xyz' };
    const json = encodeJoclySimpleMatchEnvelope({ matchId: 'm-1', gameName: 'classic-chess', nbTurns: 2, matchdata });
    const raw = JSON.parse(json);
    assert(raw.matchDetails.matchId === 'm-1', 'encodeJoclySimpleMatchEnvelope : matchId au bon endroit (matchDetails)');
    assert(raw.matchDetails.gameName === 'classic-chess', 'encodeJoclySimpleMatchEnvelope : gameName présent');
    assert(raw.matchDetails.nbTurns === 2, 'encodeJoclySimpleMatchEnvelope : nbTurns présent');
    assert(typeof raw.matchDetails.a?.pseudo === 'string' && typeof raw.matchDetails.b?.pseudo === 'string',
        'encodeJoclySimpleMatchEnvelope : champs a.pseudo/b.pseudo présents (forme exacte de control.js)');
    assert(JSON.stringify(raw.matchdata) === JSON.stringify(matchdata), 'encodeJoclySimpleMatchEnvelope : matchdata transmis tel quel');
    assert(raw.key === 'tabulon', 'encodeJoclySimpleMatchEnvelope : champ key présent (jamais vérifié par le relai, mais attendu par control.js)');

    const decoded = decodeJoclySimpleMatchEnvelope(json);
    assert(decoded.nbTurns === 2, 'decodeJoclySimpleMatchEnvelope : nbTurns lu depuis matchDetails.nbTurns');
    assert(decoded.lastMove.to === 'e5', 'decodeJoclySimpleMatchEnvelope : lastMove = dernier élément de matchdata.playedMoves');
    assert(JSON.stringify(decoded.state) === JSON.stringify(matchdata), 'decodeJoclySimpleMatchEnvelope : state = matchdata complet (pour un load() intégral)');
}
assert(decodeJoclySimpleMatchEnvelope('') === null, 'decodeJoclySimpleMatchEnvelope("") -> null');
assert(decodeJoclySimpleMatchEnvelope('{"matchDetails":{}}') === null,
    'decodeJoclySimpleMatchEnvelope sans nbTurns -> null');
{
    // matchdata sans playedMoves (partie tout juste créée, 0 coup) : ne doit
    // pas planter, lastMove reste null.
    const json = encodeJoclySimpleMatchEnvelope({ matchId: 'm-2', gameName: 'go', nbTurns: 0, matchdata: {} });
    const decoded = decodeJoclySimpleMatchEnvelope(json);
    assert(decoded.nbTurns === 0 && decoded.lastMove === null, 'decodeJoclySimpleMatchEnvelope : matchdata sans playedMoves -> lastMove null, pas d’exception');
}

// ── 9. Parsing d'un lien d'invitation jocly-simple-match ──────────────────────
{
    const url = 'https://biscandine.fr/variantes/joclymatch/index.php?game=knightmate-chess&mid=1784023862731-pIUWbcgh0yDFVT&player=a';
    const parsed = parseInvitationUrl(url);
    assert(parsed.gameName === 'knightmate-chess', 'parseInvitationUrl : gameName extrait');
    assert(parsed.matchId === '1784023862731-pIUWbcgh0yDFVT', 'parseInvitationUrl : matchId extrait tel quel');
    assert(parsed.player === 'a', 'parseInvitationUrl : player extrait');
    assert(parsed.relayUrl === 'https://biscandine.fr/variantes/joclymatch/fileio.php',
        `parseInvitationUrl : relayUrl déduite (index.php -> fileio.php, même dossier) (obtenu: ${parsed.relayUrl})`);
}
{
    const parsed = parseInvitationUrl(
        'https://biscandine.fr/variantes/joclymatch/index.php?game=go&mid=abc&player=B');
    assert(parsed.player === 'b', 'parseInvitationUrl : "player" insensible à la casse (B -> b)');
}
assert(parseInvitationUrl('ceci n’est pas une URL') === null, 'parseInvitationUrl : chaîne invalide -> null');
assert(parseInvitationUrl('https://biscandine.fr/variantes/joclymatch/index.php?game=go&mid=abc') === null,
    'parseInvitationUrl : player manquant -> null');
assert(parseInvitationUrl('https://biscandine.fr/variantes/joclymatch/index.php?mid=abc&player=a') === null,
    'parseInvitationUrl : game manquant -> null');
assert(parseInvitationUrl('https://biscandine.fr/variantes/joclymatch/index.php?game=go&player=a') === null,
    'parseInvitationUrl : mid manquant -> null');

// ── 10. Construction d'un lien d'invitation (sens inverse : je crée) ────────
{
    const link = buildInvitationUrl({
        relayUrl: 'https://biscandine.fr/variantes/joclymatch/fileio.php',
        gameName: 'knightmate-chess', matchId: '1784023862731-pIUWbcgh0yDFVT', player: 'b',
    });
    assert(link === 'https://biscandine.fr/variantes/joclymatch/index.php?game=knightmate-chess&mid=1784023862731-pIUWbcgh0yDFVT&player=b',
        `buildInvitationUrl : lien construit correctement (obtenu: ${link})`);
}
{
    // Aller-retour : ce que je construis doit se reparser à l'identique
    // (à part le rôle : je construis le lien pour l'AUTRE joueur).
    const relayUrl = 'https://biscandine.fr/variantes/joclymatch/fileio.php';
    const link = buildInvitationUrl({ relayUrl, gameName: 'go', matchId: 'xyz-123', player: 'b' });
    const reparsed = parseInvitationUrl(link);
    assert(reparsed.gameName === 'go' && reparsed.matchId === 'xyz-123' && reparsed.player === 'b',
        'buildInvitationUrl puis parseInvitationUrl : aller-retour cohérent');
    assert(reparsed.relayUrl === relayUrl, 'buildInvitationUrl puis parseInvitationUrl : relayUrl retrouvée à l’identique');
}
assert(buildInvitationUrl({ relayUrl: 'pas une url', gameName: 'go', matchId: 'x', player: 'a' }) === null,
    'buildInvitationUrl : relayUrl invalide -> null');

console.log(`\n${passed} assertions passées.`);
