// tests/test-html-assets.mjs — ce que les pages demandent au chargement.
//
// DEUX RÉGRESSIONS, LE MÊME FICHIER, ET AUCUNE N'ÉTAIT VISIBLE AUTREMENT QUE
// DANS LA CONSOLE. chat.html avait été écrit sur un squelette de l'époque
// JoclyBoard plutôt que sur une page sœur de Tabulon, et gardait :
//
//   1. <link rel="stylesheet" href="../photon/css/photon.css"> — photonkit a
//      été remplacé par tabulon.css, app/photon/ n'existe pas. Le protocole
//      d'app INTÉGRÉ répond 500 pour un asset absent (dist_override.rs, lui,
//      ne rend que 200 ou 404 : un 500 vient toujours de l'intégré), donc
//      « Failed to load resource: 500 (photon.css) » à chaque ouverture de la
//      fenêtre de discussion ;
//
//   2. une <meta http-equiv="Content-Security-Policy"> écrite à la main, sans
//      ipc: — elle bloquait `plugin:os|locale`, donc la lecture de la langue
//      du système, dans cette fenêtre-là seulement.
//
// POURQUOI PAS SIMPLEMENT AJOUTER ipc: À CETTE CSP. Parce que l'origine de
// l'IPC dépend de la plateforme (ipc://localhost sous WebKitGTK et macOS,
// http://ipc.localhost sous WebView2) : une CSP écrite à la main dans une page
// ne peut pas s'y adapter, et son mode de panne est un refus silencieux en
// console — exactement ce qui s'est passé. Tauri sait générer la bonne par
// plateforme, à partir de `app.security.csp` dans tauri.conf.json ; c'est là
// qu'une politique doit vivre, et elle couvrirait alors TOUTES les fenêtres
// plutôt qu'une sur dix-sept. Le jour où le projet en veut une, ce test est à
// mettre à jour en même temps.
//
// Usage : npm test  (ou node tests/test-html-assets.mjs)
import { readdirSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const here    = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, '..', 'app', 'content');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

/*
 * Les deux dossiers REMPLIS AU BUILD, et eux seuls.
 *
 * ../browser/ est le dist de jocly2 copié à côté de app/ (voir check-dist), et
 * ../node_modules/ vient de `npm --prefix app install`. Ni l'un ni l'autre
 * n'est dans le dépôt, donc les exiger sur le disque ferait échouer ce test
 * sur un clone neuf — ce qui apprendrait vite à l'ignorer. Tout le reste doit
 * exister : c'est précisément ce qui manquait.
 */
const BUILT = ['../browser/', '../node_modules/'];

const pages = readdirSync(content).filter(f => f.endsWith('.html')).sort();
ok(pages.length > 0, `${pages.length} pages inspectées`);

console.log('Assets référencés');
for (const page of pages) {
    const text = readFileSync(path.join(content, page), 'utf-8');
    const refs = [...text.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map(m => m[1]);
    for (const ref of refs) {
        // Liens externes, ancres et données en ligne : rien à ouvrir sur le
        // disque. Le favicon `data:,` est de ceux-là — il est là justement
        // pour qu'aucune requête ne parte.
        if (/^(https?:|data:|#|mailto:|tauri:|asset:)/.test(ref)) continue;
        if (BUILT.some(p => ref.startsWith(p))) continue;
        ok(existsSync(path.resolve(content, ref)), `${page} : ${ref} existe`);
    }
}

console.log('Politique de sécurité');
for (const page of pages) {
    const text = readFileSync(path.join(content, page), 'utf-8');
    ok(!/http-equiv\s*=\s*["']?Content-Security-Policy/i.test(text),
        `${page} : pas de CSP écrite à la main (elle appartient à tauri.conf.json)`);
}

console.log('');
console.log(`RESULTAT html-assets: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
