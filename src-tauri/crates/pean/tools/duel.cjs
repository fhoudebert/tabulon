#!/usr/bin/env node
/*
 * Duel : le Maréchal (pean-engine) contre un niveau jocly2 (Général par
 * défaut), camps alternés, une partie à la fois.
 *
 *   cargo build --release
 *   node tools/duel.cjs <racine jocly2> [options]
 *
 *   --games N        parties par scénario (défaut 10)
 *   --scenarios a,b  batailles (identifiants des scénarios ; défaut : les quatre)
 *   --level L        niveau jocly2 adverse (défaut 2 : Général)
 *   --ms T           temps du Maréchal par coup (défaut 2500)
 *   --loops N        borne le niveau jocly2 à N itérations (sans limite de
 *                    temps : mesure indépendante de la charge) ; défaut : le
 *                    niveau tel quel (5 s, 500 itérations)
 *   --engine PATH    binaire (défaut target/release/pean-engine)
 *
 * La bataille est choisie au prélude du jeu « pean » (« #k », puis « -- »). Le
 * déploiement libre (bataille libre) est joué par jocly2 pour les deux camps. Chaque coup du moteur est validé par jocly2 (IsValidMove) ; un coup
 * refusé est une erreur.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const args = process.argv.slice(2);
const ROOT = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : path.join(__dirname, "..", "..", "..", "..", "..", "jocly2"));
function opt(name, def) {
	const k = args.indexOf("--" + name);
	return k >= 0 ? args[k + 1] : def;
}
const GAMES = parseInt(opt("games", "10"), 10);
const SCENARIOS = opt("scenarios", "bataille-libre,leuctres-371,platees-479,laurion-413").split(",");
const LEVEL = parseInt(opt("level", "2"), 10);
const MS = parseInt(opt("ms", "2500"), 10);
const LOOPS = parseInt(opt("loops", "0"), 10);
const ENGINE = opt("engine", path.join(__dirname, "..", "target", "release", "pean-engine"));

const Jocly = require(path.join(ROOT, "dist", "node", "jocly.core.js"));
const R = require(path.join(ROOT, "src", "games", "pean", "pean-rules.js"));
const STATE_FIELDS = ["phase", "turn", "played", "u", "ctrl", "hold", "hs"];

const engine = spawn(ENGINE, [], { stdio: ["pipe", "pipe", "inherit"] });
const lines = readline.createInterface({ input: engine.stdout });
const waiting = [];
lines.on("line", (l) => waiting.shift()(JSON.parse(l)));
function ask(req) {
	return new Promise((resolve) => {
		waiting.push(resolve);
		engine.stdin.write(JSON.stringify(req) + "\n");
	});
}

async function game(name, marechalSide) {
	const match = await Jocly.createMatch("pean");
	const config = await match.getConfig();
	const k = config.model.gameOptions.scenarios.findIndex((sc) => sc.id === name);
	if(k < 0) throw new Error("bataille inconnue : " + name);
	await match.applyMove({ setup: k });
	await match.applyMove({ skip: 1 });
	const level = Object.assign({}, config.model.levels[LEVEL]);
	if(LOOPS) {
		level.maxLoops = LOOPS;
		level.maxDuration = 0;
	}
	const g = match.game;
	const context = R.exportContext(g.g.ctx);
	let finished = false, plies = 0;
	const stats = { engineMs: 0, engineMoves: 0, maxMs: 0, depth: 0, joclyMs: 0, joclyMoves: 0 };
	while(!finished && plies < 400) {
		const b = g.mBoard;
		let move;
		if(b.phase >= 2 && b.mWho === marechalSide) {
			const state = {};
			STATE_FIELDS.forEach((k) => { state[k] = b[k]; });
			const t0 = Date.now();
			const r = await ask({ context, state, moveTimeMs: MS });
			const dt = Date.now() - t0;
			if(r.error) throw new Error("moteur : " + r.error);
			stats.engineMs += dt;
			stats.engineMoves++;
			stats.maxMs = Math.max(stats.maxMs, dt);
			stats.depth += r.depth;
			if(!b.IsValidMove(g, r.move)) throw new Error("coup refusé par jocly2 : " + JSON.stringify(r.move));
			move = r.move;
		} else {
			const t0 = Date.now();
			move = (await match.machineSearch({ level, threaded: false })).move;
			if(b.phase >= 2) {
				stats.joclyMs += Date.now() - t0;
				stats.joclyMoves++;
			}
		}
		finished = (await match.applyMove(move)).finished;
		plies++;
	}
	const b = g.mBoard;
	const winner = b.over || (b.mFinished ? 2 : 0);
	return { winner, reason: b.reason, turns: b.played / 2, stats, camps: g.g.ctx.campKey };
}

(async () => {
	const total = { win: 0, loss: 0, draw: 0 };
	let maxMs = 0;
	for(const name of SCENARIOS) {
		const sc = { win: 0, loss: 0, draw: 0 };
		for(let i = 0; i < GAMES; i++) {
			const side = i % 2 ? -1 : 1;
			const r = await game(name, side);
			const res = r.winner === 2 || r.winner === 0 ? "draw" : r.winner === side ? "win" : "loss";
			sc[res]++;
			total[res]++;
			maxMs = Math.max(maxMs, r.stats.maxMs);
			console.log(`${name} #${i + 1} Maréchal=${r.camps[side]} : ${res} (${r.reason}, ${r.turns} tours)` +
				` · Maréchal ${Math.round(r.stats.engineMs / Math.max(1, r.stats.engineMoves))} ms/coup (max ${r.stats.maxMs}, prof. moy. ${(r.stats.depth / Math.max(1, r.stats.engineMoves)).toFixed(1)})` +
				` · jocly ${Math.round(r.stats.joclyMs / Math.max(1, r.stats.joclyMoves))} ms/coup`);
		}
		console.log(`== ${name} : ${sc.win} V / ${sc.draw} N / ${sc.loss} D`);
	}
	const n = total.win + total.draw + total.loss;
	console.log(`== total : ${total.win} V / ${total.draw} N / ${total.loss} D · score ${((total.win + total.draw / 2) / n * 100).toFixed(1)} % · coup max ${maxMs} ms`);
	engine.stdin.end();
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
