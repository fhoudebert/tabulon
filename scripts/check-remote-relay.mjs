// scripts/check-remote-relay.mjs -- Vérification EN DIRECT du protocole de
// relai contre une vraie instance jocly-simple-match (fileio.php), par
// défaut https://biscandine.fr/variantes/joclymatch/fileio.php.
//
// Ce script parle en HTTP direct depuis Node (pas de CORS côté Node, donc
// pas besoin du plugin-http/Tauri ici) -- il sert à valider le protocole
// lui-même (remote-relay-protocol.js) indépendamment de l'appli Tauri, qui
// elle-même n'est pas exécutable dans cet environnement (voir README).
//
// Usage : node scripts/check-remote-relay.mjs [url-de-fileio.php]
//
// N'écrit qu'une seule partie de test, avec un gameid généré (aléatoire,
// préfixé "tabulon-check-"), donc sans effet sur les vraies parties du site.
import {
    encodeEnvelope, decodeEnvelope, hasOpponentMoved,
    buildSaveBody, buildLoadBody, generateMatchId,
} from '../app/content/remote-relay-protocol.js';

const relayUrl = process.argv[2] || 'https://biscandine.fr/variantes/joclymatch/fileio.php';
const matchId = 'tabulon-check-' + generateMatchId().slice(0, 8);

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

// 1. load sur une partie qui n'existe pas encore
const empty = await post(buildLoadBody(matchId));
check(decodeEnvelope(empty) === null, 'load() sur une partie inexistante -> enveloppe vide/absente');

// 2. save d'un premier coup
const env1 = encodeEnvelope({ nbTurns: 1, lastMove: { from: 'e2', to: 'e4' }, state: { note: 'coup 1' } });
await post(buildSaveBody(matchId, env1));

// 3. load doit retrouver exactement ce qu'on a écrit
const after1 = decodeEnvelope(await post(buildLoadBody(matchId)));
check(after1?.nbTurns === 1, `load() après save() -> nbTurns=1 (obtenu: ${after1?.nbTurns})`);
check(after1?.lastMove?.to === 'e4', 'load() après save() -> lastMove préservé par le relai');
check(after1?.state?.note === 'coup 1', 'load() après save() -> state préservé par le relai');

// 4. détection d'un "nouveau coup adverse" simulée (2e save avec nbTurns+1)
const env2 = encodeEnvelope({ nbTurns: 2, lastMove: { from: 'e7', to: 'e5' }, state: { note: 'coup 2' } });
await post(buildSaveBody(matchId, env2));
const after2 = decodeEnvelope(await post(buildLoadBody(matchId)));
check(hasOpponentMoved(1, after2), 'hasOpponentMoved(1, load()) -> true après un 2e coup poussé par "l’adversaire"');
check(!hasOpponentMoved(2, after2), 'hasOpponentMoved(2, load()) -> false une fois à jour');

console.log(failed
    ? '\n✗ Le relai ne se comporte pas comme attendu -- voir ci-dessus.'
    : '\n✓ Le relai est compatible avec le protocole remote-relay-protocol.js.');
process.exit(failed ? 1 : 0);
