// scripts/check-jocly-compat.mjs -- Vérification EN DIRECT du codec
// "jocly-simple-match" (celui utilisé pour rejoindre une partie via un lien
// d'invitation, potentiellement jouée par un vrai client web control.js, pas
// une autre instance de Tabulon) contre une vraie instance jocly-simple-match.
//
// Complète scripts/check-remote-relay.mjs (qui valide notre propre codec
// 'tabulon') : celui-ci valide que ce que nous écrivons a exactement la
// forme que control.js attend (matchDetails.{matchId,gameName,nbTurns},
// matchdata.playedMoves...), et que nous savons relire ce qu'un vrai client
// control.js écrirait.
//
// Usage : node scripts/check-jocly-compat.mjs [url-de-fileio.php]
import {
    encodeJoclySimpleMatchEnvelope, decodeJoclySimpleMatchEnvelope,
    buildSaveBody, buildLoadBody, generateMatchId, parseInvitationUrl,
} from '../app/content/remote-relay-protocol.js';

const relayUrl = process.argv[2] || 'https://biscandine.fr/variantes/joclymatch/fileio.php';
const matchId = 'tabulon-compat-' + generateMatchId().slice(0, 8);

async function post(body) {
    const res = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    return res.text();
}

let failed = false;
function check(cond, msg) {
    console.log((cond ? '✓' : '✗') + ' ' + msg);
    if (!cond) failed = true;
}

console.log(`Relai : ${relayUrl}`);
console.log(`Partie de test : ${matchId}\n`);

// 1. Parsing d'un lien d'invitation réel (structure fournie dans la demande)
const sampleInvite = 'https://biscandine.fr/variantes/joclymatch/index.php'
    + '?game=knightmate-chess&mid=1784023862731-pIUWbcgh0yDFVT&player=a';
const parsed = parseInvitationUrl(sampleInvite);
check(parsed?.gameName === 'knightmate-chess', 'parseInvitationUrl : gameName extrait du lien fourni en exemple');
check(parsed?.relayUrl === 'https://biscandine.fr/variantes/joclymatch/fileio.php',
    'parseInvitationUrl : relayUrl déduite correspond bien à ce script');

// 2. Ce que Tabulon écrit (codec jocly-simple-match) a la forme exacte
//    attendue par control.js (matchDetails.{matchId,gameName,nbTurns} etc.)
const matchdata1 = { playedMoves: [{ from: 'e2', to: 'e4' }], initialBoard: null };
await post(buildSaveBody(matchId, encodeJoclySimpleMatchEnvelope({
    matchId, gameName: 'classic-chess', nbTurns: 1, matchdata: matchdata1,
})));
const raw1 = JSON.parse(await post(buildLoadBody(matchId)));
check(raw1.matchDetails?.matchId === matchId, 'écrit puis relu : matchDetails.matchId correct');
check(raw1.matchDetails?.gameName === 'classic-chess', 'écrit puis relu : matchDetails.gameName correct');
check(raw1.matchDetails?.nbTurns === 1, 'écrit puis relu : matchDetails.nbTurns correct');
check(Array.isArray(raw1.matchdata?.playedMoves) && raw1.matchdata.playedMoves.length === 1,
    'écrit puis relu : matchdata.playedMoves préservé par le relai');

// 3. Tabulon sait relire ce qu'un vrai client control.js écrirait (on
//    simule ici l'écriture EXACTE que ferait saveGameIfNecessary(), sans
//    passer par notre propre encodeur).
const controlJsPayload = JSON.stringify({
    matchDetails: { matchId, gameName: 'classic-chess', nbTurns: 2, a: { pseudo: 'Alice' }, b: { pseudo: '' } },
    matchdata: { playedMoves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], initialBoard: null },
    time: Date.now(),
    key: 'myverypreciouskey',
});
await post(buildSaveBody(matchId, controlJsPayload));
const decoded = decodeJoclySimpleMatchEnvelope(await post(buildLoadBody(matchId)));
check(decoded?.nbTurns === 2, `decodeJoclySimpleMatchEnvelope lit un vrai payload control.js (nbTurns=2, obtenu: ${decoded?.nbTurns})`);
check(decoded?.lastMove?.to === 'e5', 'decodeJoclySimpleMatchEnvelope en extrait le bon lastMove');
check(Array.isArray(decoded?.state?.playedMoves) && decoded.state.playedMoves.length === 2,
    'decodeJoclySimpleMatchEnvelope expose le state complet (pour un load() intégral)');

console.log(failed
    ? '\n✗ Incompatibilité détectée -- voir ci-dessus.'
    : '\n✓ Le codec jocly-simple-match est bien compatible avec ce relai (écriture ET lecture).');
process.exit(failed ? 1 : 0);
