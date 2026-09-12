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

/* ─── La clé de discussion voyage dans le FRAGMENT ────────────────────────── */
//
// Le lien d'invitation est une URL de joclymatch, faite pour être ouverte dans
// un navigateur. Une clé placée dans la requête (`?k=...`) partirait donc au
// SERVEUR dès le premier clic de l'invité — et la clé censée cacher la
// conversation à ce serveur lui arriverait par la porte d'entrée. Un fragment
// n'est jamais transmis : le navigateur le garde, la page de joclymatch
// l'ignore, Tabulon le lit.
{
    const relayUrl = 'https://biscandine.fr/variantes/joclymatch/fileio.php';
    const key = 'a'.repeat(64);
    const link = buildInvitationUrl({ relayUrl, gameName: 'go19', matchId: 'xyz-123', player: 'b', chatKey: key });

    assert(link.includes('#k=' + key), 'la clé est dans le fragment');
    assert(!new URL(link).search.includes(key),
        'et surtout PAS dans la requête, que le navigateur enverrait au serveur');
    assert(parseInvitationUrl(link).chatKey === key, 'elle se relit à l’arrivée');

    // Sans clé, le lien est exactement celui d'avant : une partie sans
    // discussion ne doit rien porter de nouveau.
    const plain = buildInvitationUrl({ relayUrl, gameName: 'go19', matchId: 'xyz-123', player: 'b' });
    assert(!plain.includes('#'), 'un lien sans discussion n’a pas de fragment');
    assert(parseInvitationUrl(plain).chatKey === null, 'et se relit sans clé');

    // Une clé mal formée est REFUSÉE plutôt qu'écrite : un lien annonçant une
    // discussion protégée qui ne le serait pas est pire qu'un lien sans
    // discussion.
    assert(buildInvitationUrl({ relayUrl, gameName: 'go19', matchId: 'x', player: 'a', chatKey: 'trop-court' }) === null,
        'une clé mal formée fait échouer la construction du lien');

    // À la lecture, en revanche, une clé abîmée est traitée comme une absence :
    // la partie doit pouvoir démarrer, sans discussion, plutôt qu'échouer.
    const damaged = 'https://biscandine.fr/variantes/joclymatch/index.php?game=go19&mid=xyz-123&player=b#k=nawak';
    const r = parseInvitationUrl(damaged);
    assert(r !== null && r.chatKey === null, 'une clé abîmée n’empêche pas de rejoindre la partie');

    // Un lien d'aujourd'hui, sans fragment, reste lisible : le champ est
    // additif.
    const old = 'https://biscandine.fr/variantes/joclymatch/index.php?game=go19&mid=xyz-123&player=a';
    assert(parseInvitationUrl(old).chatKey === null, 'un lien antérieur au champ se lit toujours');
}

/* ─── L'empreinte du trousseau, quand la clé se DÉRIVE ────────────────────── */
//
// Avec une clé de communauté, les deux joueurs calculent la clé de la partie
// chacun de leur côté : il n'y a rien à transporter. Le lien dit seulement
// LEQUEL de leurs trousseaux employer — une empreinte, pas un secret.
//
// Elle reste dans le fragment avec le reste : elle ne donne pas la clé, mais
// elle dit à quel groupe la partie appartient, et le relai n'a pas à
// l'apprendre.
{
    const relayUrl = 'https://biscandine.fr/variantes/joclymatch/fileio.php';
    const kid = '0123456789abcdef';
    const link = buildInvitationUrl({ relayUrl, gameName: 'go19', matchId: 'm-1', player: 'b', chatKeyId: kid });

    assert(link.includes('#kid=' + kid), 'l’empreinte est dans le fragment');
    assert(!new URL(link).search.includes(kid), 'et pas dans la requête');
    assert(parseInvitationUrl(link).chatKeyId === kid, 'elle se relit à l’arrivée');
    assert(parseInvitationUrl(link).chatKey === null, 'et aucune clé ne l’accompagne — rien ne circule');

    // Une empreinte mal formée est refusée à la construction, ignorée à la
    // lecture : même politique que pour la clé.
    assert(buildInvitationUrl({ relayUrl, gameName: 'go19', matchId: 'm', player: 'a', chatKeyId: 'zz' }) === null,
        'une empreinte mal formée fait échouer le lien');
    const damaged = 'https://biscandine.fr/variantes/joclymatch/index.php?game=go19&mid=m-1&player=b#kid=nawak';
    assert(parseInvitationUrl(damaged)?.chatKeyId === null, 'une empreinte abîmée n’empêche pas de rejoindre');

    // Une clé explicite l'emporte : c'est le cas de l'adversaire inconnu, qui
    // n'a aucun trousseau en commun avec nous.
    const both = buildInvitationUrl({ relayUrl, gameName: 'go19', matchId: 'm-1', player: 'b',
        chatKey: 'a'.repeat(64), chatKeyId: kid });
    assert(parseInvitationUrl(both).chatKey === 'a'.repeat(64), 'une clé explicite reste prioritaire');
}

console.log(`\n${passed} assertions passées.`);
