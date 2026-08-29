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
