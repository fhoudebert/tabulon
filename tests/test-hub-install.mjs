// tests/test-hub-install.mjs — le panneau « Installation » du hub.
//
// Tabulon se télécharge comme un binaire seul : la ludothèque, le moteur et
// son réseau s'ajoutent à côté de l'exécutable. Le panneau dit ce qui est en
// place et **où poser ce qui manque** — c'est cette dernière partie qui compte,
// et c'est elle qu'on vérifie ici.
//
// Le Rust est remplacé par un faux : ces assertions portent sur ce que
// l'interface FAIT de la réponse, pas sur la réponse elle-même.
//
// Usage : npm test  (ou node tests/test-hub-install.mjs)
import { JSDOM } from '../app/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const html = readFileSync(path.join(repo, 'app/content/hub.html'), 'utf-8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html);
const doc = dom.window.document;

console.log('Structure du panneau');
ok(!!doc.getElementById('nav-install'), 'une entrée « Installation » dans la navigation');
ok(!!doc.getElementById('install'), 'un panneau #install');
ok(doc.getElementById('install').style.display === 'none', 'masqué au départ, comme les autres');
ok(!!doc.getElementById('install-items'), 'un conteneur pour les éléments');
const link = doc.querySelector('#install a[href*="jocly2/releases"]');
ok(!!link, 'et un lien vers les versions publiées');

console.log('');
console.log('Traductions');
const i18n = readFileSync(path.join(repo, 'app/content/tabulon-i18n.js'), 'utf-8');
// Chaque élément décrit doit avoir un intitulé ET une explication : sans le
// « à quoi ça sert », l'utilisateur ne sait pas s'il doit s'en soucier.
for (const id of ['dist', 'engine', 'scan', 'nnue']) {
    ok(i18n.includes(`'install.${id}'`) && i18n.includes(`'install.${id}.what'`),
       `« ${id} » a un intitulé et une explication`);
}
for (const key of ['install.foundAt', 'install.putAt', 'install.test', 'install.unavailable']) {
    const count = (i18n.match(new RegExp(`'${key.replace('.', '\\.')}'`, 'g')) || []).length;
    ok(count === 2, `${key} traduite dans les deux langues (${count})`);
}

console.log('');
console.log('Ce que le panneau fait de la réponse');
{
    // Un faux état : la ludothèque manque, le moteur est là.
    const status = {
        external_dist: false, platform: 'linux', engine_file: 'fairy-stockfish',
        items: [
            { id: 'dist',   present: false, path: null, expected: '/opt/tabulon/dist' },
            { id: 'engine', present: true,  path: '/opt/tabulon/engine/fairy-stockfish', expected: null },
        ],
    };
    // On rejoue la logique du rendu : un élément présent montre où il a été
    // TROUVÉ, un élément absent où le POSER. Confondre les deux rendrait le
    // panneau inutile pour celui qui doit agir.
    const lines = status.items.map(item => item.present
        ? { id: item.id, shown: item.path, testable: item.id === 'engine' }
        : { id: item.id, shown: item.expected, testable: false });

    const dist = lines.find(l => l.id === 'dist');
    ok(dist.shown === '/opt/tabulon/dist', 'la ludothèque absente indique où la poser');
    ok(dist.testable === false, 'et ne propose pas de test — rien à interroger');

    const engine = lines.find(l => l.id === 'engine');
    ok(engine.shown === '/opt/tabulon/engine/fairy-stockfish', 'le moteur présent indique où il est');
    ok(engine.testable === true, 'et propose un test : c\'est le seul élément qui réponde');

    ok(lines.every(l => l.shown), 'aucun élément sans chemin — c\'est tout l\'objet du panneau');
}

console.log('');
console.log('Les liens sortent de la fenêtre');
{
    const hub = readFileSync(path.join(repo, 'app/content/hub.js'), 'utf-8');
    // Dans une webview Tauri, un <a href> fait naviguer la FENÊTRE : le hub
    // disparaît, remplacé par une page web, sans retour. Chaque panneau qui
    // affiche un lien doit l'intercepter, comme « Obtenir des extensions… ».
    ok(/function BindExternalLinks/.test(hub), 'un seul endroit ouvre les liens au dehors');
    ok(/BindExternalLinks\('#about'\)/.test(hub), 'le panneau À propos y passe');
    ok(/BindExternalLinks\('#install'\)/.test(hub), 'le panneau Installation aussi');

    // Et il y passe AVANT de lire l'état : c'est justement quand rien ne
    // marche qu'on a besoin d'aller télécharger.
    const render = hub.slice(hub.indexOf('async function RenderInstall'));
    const bind = render.indexOf("BindExternalLinks('#install')");
    const call = render.indexOf("tRpc.call('install_status')");
    ok(bind >= 0 && call >= 0 && bind < call,
       'le lien est armé avant l\'appel qui peut échouer');
}

console.log('');
console.log('Le style : une carte par élément, un chemin lisible');
{
    const css = readFileSync(path.join(repo, 'app/content/tabulon.css'), 'utf-8');
    ok(/\.install-item\s*\{/.test(css), 'chaque élément est une carte');
    ok(/\.install-item\.present/.test(css) && /\.install-item\.missing/.test(css),
       'présent et manquant se distinguent à la couleur, pas seulement au texte');
    // Le chemin est fait pour être recopié : police fixe et sélectionnable.
    ok(/\.install-path[\s\S]{0,400}monospace/.test(css), 'le chemin est en police fixe');
    ok(/\.install-path[\s\S]{0,400}user-select:\s*text/.test(css), 'et sélectionnable');
    ok(/overflow-wrap:\s*anywhere/.test(css), 'un chemin long se coupe au lieu de déborder');
}

console.log('');
console.log('Choisir le bon binaire, et bien nommer les réseaux');
{
    const hub = readFileSync(path.join(repo, 'app/content/hub.js'), 'utf-8');
    const css = readFileSync(path.join(repo, 'app/content/tabulon.css'), 'utf-8');

    // Le système est nommé : les binaires en dépendent, et plusieurs archives
    // portent des noms voisins.
    ok(!!doc.getElementById('install-platform'), 'la page dit sur quel système on est');
    ok(/install\.platform\.\s*\+\s*status\.platform|install\.platform\.' \+ status\.platform/.test(hub),
       'et le remplit depuis la réponse du Rust');

    // Fairy-Stockfish n'active un réseau que si le NOM commence par celui de
    // la variante : un fichier mal nommé est chargé sans effet ET sans
    // message. La liste des noms attendus n'est donc pas décorative.
    ok(/const NNUE_NAMES/.test(hub), 'les noms de réseaux attendus sont listés');
    for (const name of ['shogi.nnue', 'khans.nnue', 'capablanca-chess.nnue', 'spartan.nnue'])
        ok(hub.includes(`'${name}'`), `« ${name} » y figure`);
    ok(/\.install-names[\s\S]{0,300}monospace/.test(css), 'et s\'affichent en police fixe');

    // Deux dépôts, deux rôles — et les moteurs restent l'œuvre de leurs
    // auteurs : on renvoie vers eux sans rien s'attribuer.
    ok(!!doc.querySelector('#install a[href*="jocly2/releases"]'), 'lien vers la ludothèque');
    ok(!!doc.querySelector('#install a[href*="tabulon/releases"]'), 'lien vers les archives d\'appoint');
    ok(!!doc.querySelector('#install .install-credits'), 'la paternité des moteurs est indiquée');

    // GPL v3 : redistribuer un binaire oblige à fournir la source
    // correspondante OU un lien vers elle. Ces liens ne sont donc pas de la
    // politesse — ils sont la moitié de ce que la licence demande, et ils
    // doivent rester atteignables depuis l'application, là où se trouve celui
    // qui a reçu une archive toute faite.
    const sources = [...doc.querySelectorAll('#install .install-credits a[href]')]
        .map(a => a.getAttribute('href'));
    ok(sources.some(u => /fairy-stockfish\/Fairy-Stockfish/i.test(u)),
       'la source de Fairy-Stockfish est liée');
    ok(sources.some(u => /scan/i.test(u)), 'celle de Scan aussi');
    ok(sources.some(u => /fairy-stockfish\.github\.io\/nnue/i.test(u)),
       'et les réseaux renvoient à leur page officielle plutôt qu\'à une copie');
    ok(/GPL v3/.test(doc.querySelector('#install .install-credits').textContent)
       || /GPL v3/.test(readFileSync(path.join(repo, 'app/content/tabulon-i18n.js'), 'utf-8')),
       'la licence est nommée');
}

console.log('');
console.log('La bannière d\'installation incomplète');
{
    const hub = readFileSync(path.join(repo, 'app/content/hub.js'), 'utf-8');
    ok(/install-notice-seen/.test(hub), 'la bannière se souvient d\'avoir été vue');
    // Elle ne se déclenche que sur la ludothèque : le moteur absent laisse
    // jouer avec l'IA interne, et une alerte permanente pour un élément
    // facultatif serait vite ignorée.
    ok(/status\.external_dist/.test(hub), 'et ne se déclenche que si la ludothèque manque');
    ok(/'install\.incomplete'/.test(readFileSync(path.join(repo, 'app/content/tabulon-i18n.js'), 'utf-8')),
       'son texte est traduit');

    // La logique de déclenchement, rejouée : seul le premier cas alerte.
    const shouldWarn = (status, seen) => !seen && !!status && !status.external_dist;
    ok(shouldWarn({ external_dist: false }, false), 'ludothèque absente, jamais vue : on alerte');
    ok(!shouldWarn({ external_dist: false }, true), 'déjà vue : on se tait');
    ok(!shouldWarn({ external_dist: true }, false), 'ludothèque présente : rien à dire');
    ok(!shouldWarn(null, false), 'commande absente : rien à dire non plus');
}

console.log('');
console.log(`RESULTAT hub-install: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
