// test-remote-peer-protocol.mjs — logique pure du code d'invitation
// pair-à-pair (remote-peer-protocol.js) : aller-retour encode/decode,
// robustesse au copier-coller, rejet des codes invalides, jeton.
//
// Usage : node tests/test-remote-peer-protocol.mjs

import {
    encodePeerCode, decodePeerCode, generatePeerToken,
} from '../app/content/remote-peer-protocol.js';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// ── 1. Aller-retour nominal ──────────────────────────────────────────────────
{
    const info = {
        gameName: 'classic-chess',
        ips: ['192.168.1.42', '127.0.0.1'],
        port: 40123,
        token: generatePeerToken(),
    };
    const code = encodePeerCode(info);
    assert(typeof code === 'string' && code.startsWith('TBP1-'), 'encode produit un code TBP1-');
    assert(!/[\s+/=]/.test(code), 'le code est sur une seule ligne, sans caractères fragiles (+ / = espaces)');
    const back = decodePeerCode(code);
    assert(back !== null, 'decode relit le code');
    assert(back.gameName === info.gameName, 'gameName préservé');
    assert(JSON.stringify(back.ips) === JSON.stringify(info.ips), 'liste d\'adresses préservée (ordre inclus)');
    assert(back.port === info.port, 'port préservé');
    assert(back.token === info.token, 'jeton préservé');
}

// ── 1bis. Noms d'hôte (étape 8c : IP publique / DynDNS dans le code) ────────
{
    const code = encodePeerCode({
        gameName: 'shogi',
        ips: ['mon-nom.dyndns.example', '203.0.113.7', '192.168.1.42'],
        port: 40000, token: 'abcdef0123456789',
    });
    const back = decodePeerCode(code);
    assert(back !== null && back.ips[0] === 'mon-nom.dyndns.example',
        'un nom d\'hôte passe dans le code, ordre préservé (publique en tête)');
}

// ── 2. Tolérance au copier-coller ────────────────────────────────────────────
{
    const code = encodePeerCode({ gameName: 'shogi', ips: ['10.0.0.5'], port: 1234, token: 'abcdef0123456789' });
    const mangled = '  ' + code.slice(0, 12) + '\n' + code.slice(12) + ' \r\n';
    const back = decodePeerCode(mangled);
    assert(back !== null && back.gameName === 'shogi', 'espaces/sauts de ligne du copier-coller ignorés');
}

// ── 3. Rejets (jamais d'exception, toujours null) ────────────────────────────
{
    assert(decodePeerCode(null) === null, 'null rejeté');
    assert(decodePeerCode('') === null, 'chaîne vide rejetée');
    assert(decodePeerCode('pas-un-code') === null, 'préfixe absent rejeté');
    assert(decodePeerCode('TBP1-%%%%') === null, 'base64 invalide rejeté sans exception');
    assert(decodePeerCode('TBP1-' + Buffer.from('{"v":2}').toString('base64url')) === null,
        'version inconnue rejetée');
    assert(decodePeerCode('TBP1-' + Buffer.from('{"v":1,"g":"x","a":[],"p":80,"t":"tok"}').toString('base64url')) === null,
        'liste d\'adresses vide rejetée');
    assert(decodePeerCode('TBP1-' + Buffer.from('{"v":1,"g":"x","a":["h"],"p":99999,"t":"tok"}').toString('base64url')) === null,
        'port hors plage rejeté');
    assert(decodePeerCode('TBP1-' + Buffer.from('{"v":1,"g":"x","a":["h"],"p":80}').toString('base64url')) === null,
        'jeton manquant rejeté');
}

// ── 4. encodePeerCode refuse les entrées incomplètes ─────────────────────────
{
    assert(encodePeerCode({ gameName: '', ips: ['h'], port: 80, token: 't' }) === null, 'gameName vide refusé');
    assert(encodePeerCode({ gameName: 'x', ips: [], port: 80, token: 't' }) === null, 'ips vide refusé');
    assert(encodePeerCode({ gameName: 'x', ips: ['h'], port: 0, token: 't' }) === null, 'port 0 refusé');
    assert(encodePeerCode({ gameName: 'x', ips: ['h'], port: 80.5, token: 't' }) === null, 'port non entier refusé');
    assert(encodePeerCode({ gameName: 'x', ips: ['h'], port: 80, token: '' }) === null, 'jeton vide refusé');
}

// ── 5. Jeton ─────────────────────────────────────────────────────────────────
{
    const t1 = generatePeerToken();
    const t2 = generatePeerToken();
    assert(/^[0-9a-f]{32}$/.test(t1), 'jeton = 128 bits hex');
    assert(t1 !== t2, 'deux jetons diffèrent');
}

console.log(`\ntest-remote-peer-protocol: ${passed} assertions OK`);
