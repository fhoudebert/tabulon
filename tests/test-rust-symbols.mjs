// tests/test-rust-symbols.mjs
//
// Verification STATIQUE des sources Rust : chaque identifiant qu'un module de
// commandes emprunte a un autre existe-t-il bien la ou il le cherche ?
//
// Ce n'est pas un substitut a `cargo check`, et cela ne pretend pas en etre
// un : rien ici ne compile quoi que ce soit, ne verifie un type ni un
// emprunt. C'est un filet pour UNE erreur precise, celle qui a mordu -- une
// edition qui ne s'applique pas la ou on croit, laissant un
// `use super::engine_cmds::{…, not_found_message}` pointer sur une fonction
// jamais ecrite, ou un `dir.join(KATAGO_CFG)` survivre au renommage de la
// constante en `KATAGO_CFGS`.
//
// Cela tourne partout, y compris la ou la chaine Rust n'est pas installee,
// et cela coute quelques millisecondes. La ou cargo est disponible, c'est
// `cargo check` qui fait foi.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = fileURLToPath(new URL('../src-tauri/src/commands/', import.meta.url));

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log('  ✓', label); }
    else { fail++; console.log('  ✗', label); }
}

const files = {};
for (const name of await readdir(DIR))
    if (name.endsWith('.rs'))
        files[path.basename(name, '.rs')] = await readFile(path.join(DIR, name), 'utf8');

const declares = (src, name) =>
    new RegExp(`(fn|struct|enum|const|type|static)\\s+${name}\\b`).test(src);
const declaredAnywhere = (name) =>
    Object.values(files).some((src) => declares(src, name));

console.log('Test - les imports entre modules de commandes designent quelque chose');
{
    const missing = [], unused = [];
    for (const [mod, src] of Object.entries(files)) {
        for (const m of src.matchAll(/use super::(\w+)::\{([^}]*)\};/gs)) {
            const from = m[1];
            if (!files[from]) continue;
            for (const raw of m[2].split(',')) {
                const name = raw.trim();
                if (!name) continue;
                if (!declares(files[from], name)) missing.push(`${mod} <- ${from}::${name}`);
                // un import inutilise est un avertissement en Rust, pas une
                // erreur -- mais c'est presque toujours le residu d'une
                // edition a moitie appliquee, ce que ce test traque
                if ((src.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length <= 1)
                    unused.push(`${mod}: ${name}`);
            }
        }
    }
    ok(missing.length === 0, `aucun import fantome${missing.length ? ' — ' + missing.join(', ') : ''}`);
    ok(unused.length === 0, `aucun import inutilise${unused.length ? ' — ' + unused.join(', ') : ''}`);
}

console.log('Test - les appels pleinement qualifies aboutissent');
{
    const missing = [];
    for (const [mod, src] of Object.entries(files))
        for (const m of src.matchAll(/(?:super|crate::commands)::(\w+_cmds)::(\w+)/g)) {
            const [, target, name] = m;
            if (!files[target]) continue;
            if (!declares(files[target], name)) missing.push(`${mod} -> ${target}::${name}`);
        }
    ok(missing.length === 0, `aucun appel vers un symbole absent${missing.length ? ' — ' + missing.join(', ') : ''}`);
}

console.log('Test - les constantes citees sont definies');
{
    // C'est ce cas precis qui a casse la compilation : KATAGO_CFG survivait a
    // son renommage en KATAGO_CFGS, a un seul endroit du fichier.
    const missing = [];
    for (const [mod, src] of Object.entries(files))
        for (const name of new Set(src.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [])) {
            if (new RegExp(`"${name}"`).test(src)) continue;   // litteral, ex. "TABULON_KATAGO"
            // constantes de la bibliotheque standard, importees et non declarees
            if (/^(UNIX_EPOCH|PATH_MAX|MAIN_SEPARATOR|SIG[A-Z]+)$/.test(name)) continue;
            if (!declaredAnywhere(name)) missing.push(`${mod}: ${name}`);
        }
    ok(missing.length === 0, `aucune constante fantome${missing.length ? ' — ' + missing.join(', ') : ''}`);
}

console.log('Test - les commandes enregistrees existent');
{
    const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const missing = [];
    for (const m of lib.matchAll(/(\w+_cmds)::(\w+),/g)) {
        const [, mod, name] = m;
        if (!files[mod]) { missing.push(`${mod} (module absent)`); continue; }
        if (!declares(files[mod], name)) missing.push(`${mod}::${name}`);
    }
    ok(missing.length === 0,
       `chaque commande du handler existe${missing.length ? ' — ' + missing.join(', ') : ''}`);

    // et le module doit etre declare, sinon rien ne compile
    const mods = new Set([...lib.matchAll(/(\w+_cmds)::/g)].map((m) => m[1]));
    const undeclared = [...mods].filter((m) => !new RegExp(`pub mod ${m};`).test(files.mod || ''));
    ok(undeclared.length === 0,
       `chaque module utilise est declare dans mod.rs${undeclared.length ? ' — ' + undeclared.join(', ') : ''}`);
}

console.log(`\nRESULTAT rust-symbols: ${pass} OK / ${fail} ECHEC`);
process.exit(fail ? 1 : 0);
