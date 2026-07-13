// scripts/make-extension.mjs — fabrique une extension Tabulon (<jeu>.tabulon-ext)
// depuis un dist/ complet, SANS l'application. Sert aussi d'outillage pour
// alimenter une future liste d'extensions téléchargeables (GitHub).
//
// Une extension contient STRICTEMENT ce que la config du jeu déclare :
//   - le code   : <jeu>-config.js, <jeu>-model.js, <jeu>-view.js (bundles
//                 autonomes du dist — les js partagés y sont déjà inlinés)
//   - les pages : rules (toutes langues), credits, description
//   - l'image   : thumbnail (config + déclaration d'index si différente)
//   - les visuels (view.visuals.*)
// Les ressources partagées du module (css, sons, res/<set>/* sprites et
// textures, res/rules/*/graphs/*, moteurs fairy-stockfish) restent LIÉES AU
// MODULE : elles ne font jamais partie d'une extension, et l'import exige que
// le module soit déjà présent dans le dist externe cible.
//
// Usage : node scripts/make-extension.mjs <jeu> [dossier-sortie] [--dist chemin]
//   ex.  node scripts/make-extension.mjs seireigi /tmp
// La logique (collecte, réécriture d'index) est exportée pour les tests et
// MIROIR de l'implémentation Rust (src-tauri/src/commands/extension_cmds.rs).
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, copyFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

export const FORMAT_VERSION = 1;

// ── Lecture d'index (jocly-allgames.js : littéral JS, clés non quotées) ──────
export function readIndex(indexPath) {
  const raw = readFileSync(indexPath, 'utf-8');
  const m = raw.match(/exports\.games\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error(`format d'index inattendu : ${indexPath}`);
  return (0, eval)('(' + m[1] + ')');
}

// Réécriture en JSON STRICT (toujours un littéral JS valide pour le loader,
// et parseable ensuite par serde_json côté Rust). Sauvegarde .bak avant.
export function writeIndex(indexPath, games) {
  if (existsSync(indexPath)) copyFileSync(indexPath, indexPath + '.bak');
  writeFileSync(indexPath, '"use strict";exports.games=' + JSON.stringify(games) + ';\n');
}

export function addToIndex(indexPath, gameName, declaration) {
  const games = readIndex(indexPath);
  games[gameName] = declaration;
  writeIndex(indexPath, games);
}

export function removeFromIndex(indexPath, gameName) {
  const games = readIndex(indexPath);
  if (!(gameName in games)) throw new Error(`jeu absent de l'index : ${gameName}`);
  delete games[gameName];
  writeIndex(indexPath, games);
}

// ── Noms/chemins sûrs (miroir des gardes Rust) ───────────────────────────────
export function isSafeName(n) { return /^[a-z0-9][a-z0-9-]*$/i.test(n); }
export function isSafeRelPath(p) {
  return typeof p === 'string' && p.length > 0 &&
    !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

// ── Config d'un jeu (JSON pur après le préfixe exports.config =) ─────────────
export function readGameConfig(distDir, module, gameName) {
  const p = path.join(distDir, 'browser', 'games', module, gameName + '-config.js');
  const raw = readFileSync(p, 'utf-8');
  const m = raw.match(/^exports\.config\s*=\s*([\s\S]*?);?\s*$/);
  if (!m) throw new Error(`format de config inattendu : ${p}`);
  return JSON.parse(m[1]);
}

// ── Collecte : STRICTEMENT le déclaré (voir en-tête) ─────────────────────────
// Retourne { module, declaration, files, missing } ; `files` = chemins relatifs
// à games/<module>/, dédoublonnés, existants ; `missing` = déclarés absents.
export function collectGameFiles(distDir, gameName) {
  const index = readIndex(path.join(distDir, 'browser', 'jocly-allgames.js'));
  const declaration = index[gameName];
  if (!declaration) throw new Error(`jeu absent de l'index : ${gameName}`);
  const module = declaration.module;
  if (!isSafeName(gameName) || !isSafeName(module))
    throw new Error(`nom de jeu/module invalide : ${gameName}/${module}`);

  const cfg = readGameConfig(distDir, module, gameName);
  const wanted = [];
  const push = (f) => { if (typeof f === 'string' && f) wanted.push(f); };
  const pushLangMap = (v) => {
    if (typeof v === 'string') push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(push);
  };

  // Code (bundles autonomes)
  push(gameName + '-config.js');
  push(gameName + '-model.js');
  push(gameName + '-view.js');
  // Pages déclarées par le modèle
  pushLangMap(cfg.model && cfg.model.rules);
  pushLangMap(cfg.model && cfg.model.credits);
  pushLangMap(cfg.model && cfg.model.description);
  // Images déclarées
  push(cfg.model && cfg.model.thumbnail);
  push(declaration.thumbnail);                       // celle de l'index (souvent identique)
  const visuals = (cfg.view && cfg.view.visuals) || {};
  Object.values(visuals).forEach(v => [v].flat().forEach(push));
  // Volontairement RIEN d'autre : ni view.css, ni skins[].preload, ni sons —
  // ressources partagées du module.

  const moduleDir = path.join(distDir, 'browser', 'games', module);
  const files = [], missing = [];
  for (const f of [...new Set(wanted)]) {
    if (!isSafeRelPath(f)) throw new Error(`chemin déclaré non sûr : ${f}`);
    (existsSync(path.join(moduleDir, f)) ? files : missing).push(f);
  }
  return { module, declaration, files, missing };
}

export function buildManifest(gameName, collected, exportedBy = 'make-extension.mjs') {
  return {
    formatVersion: FORMAT_VERSION,
    game: gameName,
    module: collected.module,
    title: collected.declaration.title || gameName,
    summary: collected.declaration.summary || '',
    declaration: collected.declaration,
    files: collected.files,
    exportedBy,
  };
}

// ── Assemblage du .tabulon-ext (zip : extension.json + games/<module>/…) ─────
export function buildExtension(distDir, gameName, outDir) {
  const collected = collectGameFiles(distDir, gameName);
  if (collected.files.length < 3)
    throw new Error(`collecte incomplète pour ${gameName} (code manquant ?)`);
  const staging = path.join(outDir, `.ext-${gameName}-staging`);
  rmSync(staging, { recursive: true, force: true });
  const modOut = path.join(staging, 'games', collected.module);
  mkdirSync(modOut, { recursive: true });
  for (const f of collected.files) {
    const dst = path.join(modOut, f);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(path.join(distDir, 'browser', 'games', collected.module, f), dst);
  }
  writeFileSync(path.join(staging, 'extension.json'),
    JSON.stringify(buildManifest(gameName, collected), null, 1));
  const out = path.join(outDir, `${gameName}.tabulon-ext`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-q', '-r', path.resolve(out), 'extension.json', 'games'], { cwd: staging });
  rmSync(staging, { recursive: true, force: true });
  return { out, ...collected };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--dist');
  const distDir = di >= 0 ? args.splice(di, 2)[1]
    : path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');
  const [gameName, outDir = '.'] = args;
  if (!gameName) { console.error('Usage : node scripts/make-extension.mjs <jeu> [sortie] [--dist chemin]'); process.exit(1); }
  const r = buildExtension(distDir, gameName, outDir);
  console.log(`✓ ${r.out} — module ${r.module}, ${r.files.length} fichiers`);
  if (r.missing.length) console.warn(`  ⚠ déclarés mais absents du dist : ${r.missing.join(', ')}`);
}
