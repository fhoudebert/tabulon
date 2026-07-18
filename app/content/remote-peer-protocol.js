// app/content/remote-peer-protocol.js -- Jeu a distance en pair-a-pair :
// logique PURE du "code d'invitation" (encode/decode) et du jeton de session.
// Aucun import Tauri/DOM/reseau : testable directement sous Node
// (tests/test-remote-peer-protocol.mjs), comme remote-relay-protocol.js.
//
// Pourquoi PAS WebRTC (decision documentee, verifiee empiriquement -- voir
// DEVELOPMENT.md § Remote play) : la webview Linux de Tauri (WebKitGTK, build
// Ubuntu/Debian) est COMPILEE SANS WebRTC -- typeof RTCPeerConnection ===
// 'undefined', et les symboles (setLocalDescription, createDataChannel,
// webrtcbin...) sont absents du binaire libwebkit2gtk-4.1 ; le reglage
// runtime enable-webrtc n'y change rien (scripts/check-webrtc-webview.py
// pour reproduire). Par ailleurs, sans serveur STUN/TURN -- l'exigence ici
// est "aucun serveur" -- WebRTC ne produirait que des candidats *host*,
// c'est-a-dire exactement la meme classe de joignabilite qu'une connexion
// TCP directe. Le transport retenu est donc une connexion TCP directe
// portee par le cote Rust (src-tauri/src/commands/peer_cmds.rs), identique
// sur les trois OS et independante de la webview ; ce module ne porte que
// la partie encodage du code echange entre les joueurs.
//
// Le "code d'invitation" est un bloc de texte a copier-coller (chat,
// email...) de l'hote vers l'invite -- UN SEUL echange, la ou un WebRTC
// manuel en aurait demande deux (offer puis answer) :
//   TBP1-<base64url(JSON {v,g,a,p,t})>
//     v : version du format (1)
//     g : gameName (le jeu Jocly a ouvrir cote invite)
//     a : adresses IP locales de l'hote (l'invite les essaie dans l'ordre)
//     p : port TCP (ephemere, choisi par l'OS au moment de "Creer un code")
//     t : jeton de session (non-devinable ; verifie par l'hote au handshake,
//         seule "authentification" -- meme modele que le matchId du relai)

const CODE_PREFIX = 'TBP1-';

// -- base64url (sans dependance, dispo Node et webview) -------------------------
function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = (typeof btoa === 'function' ? btoa(bin)
        : Buffer.from(bytes).toString('base64'));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = (typeof atob === 'function' ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * Jeton de session non-devinable (128 bits hex). Genere COTE JS (crypto de
 * la webview / de Node) et passe au Rust, pour ne pas ajouter de dependance
 * d'aleatoire cote Cargo.
 */
export function generatePeerToken() {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
    } else {
        // Repli sans crypto : nettement moins bon, mais le code reste
        // non-trivial a deviner ; ne concerne en pratique que des
        // environnements de test exotiques.
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Construit le code d'invitation a transmettre a l'autre joueur.
 * @param {{gameName:string, ips:string[], port:number, token:string}} info
 * @returns {string|null} null si un champ requis manque/est invalide
 */
export function encodePeerCode({ gameName, ips, port, token }) {
    if (!gameName || typeof gameName !== 'string') return null;
    if (!Array.isArray(ips) || ips.length === 0 || !ips.every(a => typeof a === 'string' && a)) return null;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (!token || typeof token !== 'string') return null;
    return CODE_PREFIX + toBase64Url(JSON.stringify({ v: 1, g: gameName, a: ips, p: port, t: token }));
}

/**
 * Decode un code d'invitation colle par l'utilisateur.
 * Tolerant aux espaces/sauts de ligne ajoutes par le copier-coller, ET au
 * prefixe TBP1- manquant : un double-clic dans le champ du code selectionne
 * le "mot" apres le tiret (le '-' casse la selection), donc un copier-coller
 * manuel arrive facilement ampute du prefixe -- constate en test reel. Le
 * prefixe n'est qu'un marqueur de version ; la vraie garde reste la
 * validation stricte des champs ci-dessous (v===1, adresses, port, jeton).
 * @returns {{gameName:string, ips:string[], port:number, token:string}|null}
 *   null si le code est illisible ou incomplet (jamais d'exception).
 */
export function decodePeerCode(code) {
    if (typeof code !== 'string') return null;
    const cleaned = code.replace(/\s+/g, '');
    const payload = cleaned.startsWith(CODE_PREFIX)
        ? cleaned.slice(CODE_PREFIX.length)
        : cleaned;
    if (!payload) return null;
    let parsed;
    try {
        parsed = JSON.parse(fromBase64Url(payload));
    } catch {
        return null;
    }
    if (!parsed || parsed.v !== 1) return null;
    const { g: gameName, a: ips, p: port, t: token } = parsed;
    if (!gameName || typeof gameName !== 'string') return null;
    if (!Array.isArray(ips) || ips.length === 0 || !ips.every(x => typeof x === 'string' && x)) return null;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (!token || typeof token !== 'string') return null;
    return { gameName, ips, port, token };
}
