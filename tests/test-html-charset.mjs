// tests/test-html-charset.mjs — encodage déclaré par les pages.
//
// Régression : aucune page de app/content/ ne déclarait son encodage. Les
// fichiers sont bien en UTF-8 sur le disque, mais sans déclaration la webview
// devine — et sous Linux (WebKitGTK) elle retombe sur windows-1252. Les
// caractères écrits EN DUR dans le HTML sortaient alors en mojibake :
// « Un livre — un » s'affichait « Un livre â€” un » (le tiret cadratin
// U+2014 = E2 80 94 en UTF-8, relu comme trois caractères latin-1).
//
// Les chaînes injectées par JS n'étaient pas touchées (un module ES est
// toujours décodé en UTF-8 par spécification), ce qui explique que seule une
// partie du texte était abîmée et que le bug ait pu passer.
//
// Le Content-Type servi par le protocole d'app de Tauri ne porte pas de
// charset pour les assets embarqués : c'est donc la balise qui tranche.
// Usage : npm test  (ou node tests/test-html-charset.mjs)
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const here    = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, '..', 'app', 'content');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

const pages = readdirSync(content).filter(f => f.endsWith('.html')).sort();
ok(pages.length > 0, `${pages.length} pages inspectées`);

console.log('Déclaration d\'encodage');
for (const page of pages) {
    const raw = readFileSync(path.join(content, page));

    // 1. Le fichier lui-même doit être en UTF-8 valide. Un fichier réenregistré
    //    en latin-1 par un éditeur donnerait le même symptôme, et la balise
    //    ne le rattraperait pas — elle l'aggraverait.
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { ok(false, `${page} : le fichier n'est pas de l'UTF-8 valide`); continue; }

    // 2. La déclaration doit être présente ET dans les 1024 premiers octets :
    //    au-delà, la spécification HTML n'oblige pas le navigateur à en tenir
    //    compte, et celui qui le fait quand même recharge la page.
    const head = raw.subarray(0, 1024).toString('latin1').toLowerCase();
    const has  = /<meta[^>]+charset\s*=\s*["']?utf-8/.test(head);
    ok(has, `${page} : <meta charset="utf-8"> dans les 1024 premiers octets`);

    // 3. Rien ne doit précéder la balise dans le <head> : la déclaration est
    //    la première chose à lire, avant tout <title> ou <link> qui pourrait
    //    lui-même contenir du texte non-ASCII.
    const lower = text.toLowerCase();
    const openHead = lower.indexOf('<head>');
    const meta     = lower.search(/<meta[^>]+charset/);
    if (openHead >= 0 && meta >= 0) {
        const between = text.slice(openHead + 6, meta);
        ok(!/<\w/.test(between), `${page} : la balise ouvre le <head>`);
    }
}

console.log('Caractères concernés (ceux que le bug abîmait)');
{
    // Sans la correction, ces pages étaient les seules visiblement touchées.
    // Le test les cite pour que la régression reste reconnaissable.
    const affected = {};
    for (const page of pages) {
        const text = readFileSync(path.join(content, page), 'utf-8');
        const bad = [...new Set([...text].filter(c => c.codePointAt(0) > 127))];
        if (bad.length) affected[page] = bad;
    }
    ok(Object.keys(affected).length > 0,
       'des pages contiennent bien du texte non-ASCII en dur : ' + Object.keys(affected).join(', '));
    ok((affected['hub.html'] || []).includes('\u2014'),
       'hub.html contient le tiret cadratin de « Un livre — un », à l\'origine du signalement');
}

console.log('');
console.log(`RESULTAT html-charset: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
