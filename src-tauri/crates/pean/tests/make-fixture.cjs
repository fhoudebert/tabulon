#!/usr/bin/env node
/*
 * Fixtures du test différentiel : des parties jouées par la référence
 * (jocly2, src/games/pean/pean-rules.js), position par position, avec tout
 * ce que le moteur Rust doit retrouver à l'identique :
 *   - why-not-order, destinations (chemins compris) d'unités et de groupes ;
 *   - cibles, attaquants, rapports de force (attaquants au complet, un seul) ;
 *   - des tours entiers, valides ou abîmés exprès : verdict, code d'erreur,
 *     état obtenu, issue de la partie.
 *
 *   node tests/make-fixture.cjs <racine jocly2> [parties par scénario] [--full]
 *
 * Écrit tests/fixtures/<scénario>.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] || path.join(__dirname, "..", "..", "..", "..", "..", "jocly2");
const GAMES = parseInt(process.argv[3], 10) || 4;
// --full : tout en clair (diagnostic) ; sinon destinations et états réduits à
// une empreinte FNV-1a de leur JSON (fixtures livrées, compactes)
const FULL = process.argv.includes("--full");

function fnv(text) {
	let h = 0x811c9dc5;
	for(let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return ("0000000" + h.toString(16)).slice(-8);
}
const digest = (x) => FULL ? x : fnv(JSON.stringify(x));
const GAME = path.join(ROOT, "src", "games", "pean");
const R = require(path.join(GAME, "pean-rules.js"));
global.PeanRules = R;
const AI = require(path.join(GAME, "pean-ai.js"));
const SCENARIOS = ["bataille-libre", "leuctres-371", "platees-479", "laurion-413"];

let seed = 4242;
function rng(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return n > 0 ? seed % n : 0;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

function randomTurn(ctx, st, who) {
	const turn = new R.Turn(ctx, st, who);
	const mine = turn.st.u.filter((u) => u.s === who && u.h >= 0);
	for(let k = 0; k < 8 && turn.ordersLeft() > 0; k++) {
		const u = mine[rng(mine.length)];
		if(!u || turn.whyNotOrder([u.i])) continue;
		const r = turn.reach([u.i]), dests = Object.keys(r);
		if(!dests.length) continue;
		let f;
		if(ctx.options.orientation && ctx.types[u.t].phalanx && rng(4) === 0) f = rng(6);
		turn.order([u.i], r[dests[rng(dests.length)]], f);
	}
	for(let k = 0; k < 4; k++) {
		const tg = turn.targets();
		if(!tg.length) break;
		const pick = tg[rng(tg.length)];
		const ids = pick.a.filter(() => rng(3) > 0);
		const s = ids.length && turn.strength(ids, pick.t);
		if(s && s.result) turn.attack(ids, pick.t, rng(2) ? ids[0] : undefined);
	}
	return turn.toMove();
}

// un voisin au hasard (chemins plausibles : les refus viennent des règles, pas de la géométrie)
function near(ctx, h) {
	const n = [];
	for(let d = 0; d < 6; d++) {
		const x = ctx.nb[h * 6 + d];
		if(x >= 0) n.push(x);
	}
	return n.length ? n[rng(n.length)] : h;
}

// un tour abîmé : la référence dit pourquoi il est refusé (ou pas)
function mutate(ctx, st, who, move) {
	const m = clone(move), N = st.u.length;
	const o = m.o || (m.o = []), k = m.k || (m.k = []);
	const mine = st.u.filter((u) => u.s === who && u.h >= 0), theirs = st.u.filter((u) => u.s !== who && u.h >= 0);
	const any = (l) => l.length ? l[rng(l.length)] : null;
	const walk = (h, n) => { const c = [h]; for(let i = 0; i < n; i++) c.push(near(ctx, c[c.length - 1])); return c; };
	switch(rng(20)) {
		case 0: if(o.length) { const c = o[rng(o.length)].c; c.push(near(ctx, c[c.length - 1])); } break;
		case 1: if(o.length) { const c = o[rng(o.length)].c; c.push(near(ctx, c[c.length - 1])); c.push(near(ctx, c[c.length - 1])); } break;
		case 2: if(o.length) o[rng(o.length)].f = rng(8) - 1; break;
		case 3: { const u = any(mine); if(u) o.push({ u: [u.i], c: walk(u.h, 1 + rng(4)) }); } break;
		case 4: { const u = any(mine); if(u) o.unshift({ u: [u.i], c: walk(u.h, 1 + rng(6)) }); } break;
		case 5: { const u = any(mine), v = any(mine); if(u && v) o.push({ u: [u.i, v.i], c: walk(u.h, 1 + rng(3)) }); } break;
		case 6: if(o.length) o.push(clone(o[0])); break;
		case 7: if(k.length) k[rng(k.length)].h = rng(ctx.N); break;
		case 8: if(k.length) k[rng(k.length)].v = rng(N); break;
		case 9: if(k.length) k[rng(k.length)].a.push(rng(N)); break;
		case 10: { const t = any(theirs), u = any(mine); if(t && u) k.push({ a: [u.i], t: t.i }); } break;
		case 11: if(k.length) k.push(clone(k[0])); break;
		case 12: if(k.length) { const x = k.shift(); o.push({ u: [x.a[0]], c: [st.u[x.a[0]].h, near(ctx, st.u[x.a[0]].h)] }); k.push(x); } break;
		case 13: if(o.length) { const x = o[rng(o.length)]; x.c = [x.c[0]]; } break;
		case 14: if(k.length) k[rng(k.length)].a = []; break;
		case 15: { const t = any(theirs); if(t) o.push({ u: [t.i], c: walk(t.h, 1) }); } break;
		case 16: { const u = any(mine); if(u) o.push({ u: [u.i], c: [u.h], f: rng(6) }); } break;
		case 17: if(o.length) { const x = o[rng(o.length)]; x.u = x.u.concat(x.u); } break;
		case 18: if(k.length) { const x = k[rng(k.length)]; x.v = x.a[rng(x.a.length)]; } break;
		default: if(o.length) o.splice(rng(o.length), 1); break;
	}
	return m;
}

function verdict(ctx, st, who, move) {
	const r = R.playTurn(ctx, st, who, clone(move));
	if(!r.ok) return { move, error: r.error };
	return { move, state: digest(r.state), outcome: R.outcome(ctx, r.state, who), eval: AI.evaluate(ctx, r.state) };
}

// les tours candidats de jocly2, avec le générateur de lab.js (Math.imul)
function imulRng(seed) {
	return function (n) {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return seed % n;
	};
}

function probe(ctx, st, who) {
	const turn = new R.Turn(ctx, st, who);
	const units = [], groups = [];
	turn.st.u.forEach((u) => {
		if(u.s !== who || u.h < 0) return;
		units.push({ id: u.i, why: turn.whyNotOrder([u.i]), reach: digest(turn.reach([u.i])) });
		// groupes : l'unité et ses voisines de même type (2 et 3)
		const mates = turn.st.u.filter((v) => v.s === who && v.h >= 0 && v.i !== u.i && v.t === u.t &&
			R.distance(ctx, u.h, v.h) === 1);
		for(let n = 1; n <= Math.min(2, mates.length); n++) {
			const ids = [u.i].concat(mates.slice(0, n).map((v) => v.i));
			groups.push({ ids, why: turn.whyNotOrder(ids), reach: digest(turn.reach(ids)) });
		}
	});
	const targets = targetsOf(turn);
	return { arrived: turn.arrived, maxOrders: turn.maxOrders, state: digest(turn.st), units, groups, targets };
}

function targetsOf(turn) {
	return turn.targets().map((x) => {
		const strengths = [x.a].concat(x.a.length > 1 ? x.a.map((id) => [id]) : []).map((ids) => {
			const s = turn.strength(ids, x.t);
			return { ids, att: s.att, def: s.def, col: s.col, result: s.result, ranged: s.ranged };
		});
		return { t: x.t, a: x.a, strengths };
	});
}

// les combats possibles une fois les ordres d'un tour candidat donnés
function contact(ctx, st, who, move) {
	const turn = new R.Turn(ctx, st, who);
	for(const o of move.o || []) if(!turn.order(o.u, o.c, o.f)) return null;
	return { o: move.o || [], targets: targetsOf(turn) };
}

function game(name, g) {
	const sc = JSON.parse(fs.readFileSync(path.join(GAME, "scenarios", name + ".json"), "utf8"));
	const ctx = R.makeContext({ scenario: sc });
	let st = R.newState(ctx), plies = 0, end = { winner: 0 };
	const positions = [];
	const mode = g % 2 ? "random" : "ai";
	while(!end.winner && plies < 120) {
		const who = R.toMove(st);
		let move;
		if(st.phase < 2) {
			move = AI.placements(ctx, st, who, 2, rng)[0];
			st = R.playTurn(ctx, st, who, move).state;
			plies++;
			continue;
		}
		const cands = AI.candidates(ctx, st, who, { max: 8, rng });
		const trials = [];
		cands.slice(0, 4).forEach((m) => trials.push(verdict(ctx, st, who, m)));
		const rnd = randomTurn(ctx, st, who);
		trials.push(verdict(ctx, st, who, rnd));
		for(let i = 0; i < 10; i++)
			trials.push(verdict(ctx, st, who, mutate(ctx, st, who, cands.length && rng(2) ? cands[rng(cands.length)] : rnd)));
		const cseed = 1000 + positions.length * 7;
		positions.push({ who, before: st, eval: AI.evaluate(ctx, st), cseed, cands: AI.candidates(ctx, st, who, { max: 14, rng: imulRng(cseed) }), probe: probe(ctx, st, who), contact: cands.map((m) => contact(ctx, st, who, m)).filter((x) => x && x.targets.length), trials });
		move = mode === "ai" && cands.length ? cands[0] : rnd;
		const r = R.playTurn(ctx, st, who, move);
		if(!r.ok) throw new Error("coup refusé : " + r.error);
		st = r.state;
		end = R.outcome(ctx, st, who);
		plies++;
	}
	return positions;
}

// une position sur `every` (fixtures livrées)
const EVERY = FULL ? 1 : 2;

const out = path.join(__dirname, "fixtures");
fs.mkdirSync(out, { recursive: true });

// une position de départ, pour les tests de la recherche (et de Tabulon)
{
	const sc = JSON.parse(fs.readFileSync(path.join(GAME, "scenarios", "leuctres-371.json"), "utf8"));
	const ctx = R.makeContext({ scenario: sc });
	fs.writeFileSync(path.join(out, "search.json"), JSON.stringify({ context: R.exportContext(ctx), state: R.newState(ctx) }));
}
for(const name of SCENARIOS) {
	if(process.argv.includes("--search-only")) break;
	const sc = JSON.parse(fs.readFileSync(path.join(GAME, "scenarios", name + ".json"), "utf8"));
	const ctx = R.makeContext({ scenario: sc });
	let positions = [];
	for(let g = 0; g < GAMES; g++) positions = positions.concat(game(name, g).filter((p, i) => i % EVERY === 0));
	fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify({ context: R.exportContext(ctx), positions }));
	const trials = positions.reduce((n, p) => n + p.trials.length, 0);
	const bad = positions.reduce((n, p) => n + p.trials.filter((t) => t.error).length, 0);
	console.log(name + " : " + positions.length + " positions, " + trials + " tours (" + bad + " refusés)");
}
