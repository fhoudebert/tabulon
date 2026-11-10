// Produit tests/fixtures/differential.txt a partir de la REFERENCE des regles,
// kriegspiel-rules.js de jocly2 : des parties jouees par l'IA de jocly2 (avec
// du hasard), et pour chaque position retenue tout ce que le moteur Rust doit
// retrouver a l'identique -- communications, destinations de chaque unite,
// attaques possibles, coup joue, position resultante, issue, et le verdict de
// la reference sur quelques coups tires au hasard (acceptes ou refuses, avec
// le code du refus).
//
//   node tests/make-fixture.cjs <chemin de jocly2> [parties] [graine]
//
// A relancer quand les regles de jocly2 changent ; le fichier produit est
// versionne, `cargo test` n'a donc pas besoin de jocly2.
const fs = require("fs");
const path = require("path");

const jocly = process.argv[2];
if(!jocly) {
	console.error("usage: node tests/make-fixture.cjs <chemin de jocly2> [parties] [graine]");
	process.exit(2);
}
const GAMES = parseInt(process.argv[3], 10) || 10;
let seed = parseInt(process.argv[4], 10) || 20261110;
// generateur deterministe : le fichier ne change pas d'une execution a l'autre
function rng(n) {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return Math.floor(seed / 4294967296 * n);
}
const dir = path.join(jocly, "src", "games", "kriegspiel");
const R = require(path.join(dir, "kriegspiel-rules.js"));
global.KriegspielRules = R;
const AI = require(path.join(dir, "kriegspiel-ai.js"));
const ctx = R.makeContext({});

const CHARS = "ICAHTE";
function position(st, who) {
	// cases vides comptees, comme dans une FEN : "187I3c..."
	let grid = "", empty = 0;
	for(let p = 0; p < R.N; p++) {
		const v = st.grid[p];
		if(v === 0) { empty++; continue; }
		if(empty) { grid += empty; empty = 0; }
		grid += v > 0 ? CHARS[v - 1] : CHARS[-v - 1].toLowerCase();
	}
	if(empty) grid += empty;
	return [who > 0 ? "N" : "S", st.phase, st.turn, st.ars.map((a) => a ? 1 : 0).join(""),
		st.retreat >= 0 ? st.retreat : "-", grid].join(" ");
}
function moveText(mv) {
	if(mv.p) {
		const items = [];
		for(let t = 1; t <= 6; t++) (mv.p[R.CODES[t]] || []).forEach((pos) => items.push(t + "@" + pos));
		return "p:" + items.join(",");
	}
	const parts = [];
	if(mv.r) parts.push("r:" + mv.r[0] + "-" + mv.r[1]);
	(mv.m || []).forEach((s) => parts.push(s[0] + "-" + s[1]));
	if(mv.a !== undefined) parts.push("x" + mv.a);
	if(mv.d !== undefined) parts.push("d" + mv.d);
	return parts.length ? parts.join(" ") : "pass";
}

const lines = [];
let positions = 0;
function record(st, who, mv) {
	lines.push("P " + position(st, who));
	if(st.phase >= 2) {
		[1, -1].forEach((side) => {
			const comm = R.communications(ctx, st, side, false);
			const on = [];
			for(let p = 0; p < R.N; p++) if(comm.on[p]) on.push(p);
			lines.push("C " + (side > 0 ? "N" : "S") + " " + on.join(" "));
		});
		const turn = new R.Turn(ctx, st, who);
		for(let p = 0; p < R.N; p++) {
			if(R.sideOf(st.grid[p]) !== who) continue;
			const dests = turn.dests(p).slice().sort((a, b) => a - b);
			if(dests.length) lines.push("D " + p + " " + dests.join(" "));
		}
		turn.attacks().forEach((a) => {
			lines.push("A " + a.target + " " + a.att + " " + a.def + " " + (turn.outcomeOf(a.target, a.delta) === "destroy" ? "D" : "R"));
		});
		// coups au hasard : la reference dit lesquels sont legaux, et pourquoi non
		const mine = [], theirs = [];
		for(let p = 0; p < R.N; p++) {
			if(R.sideOf(st.grid[p]) === who) mine.push(p);
			else if(st.grid[p] !== 0) theirs.push(p);
		}
		// des suites de deplacements legaux : 6 pour depasser la limite, puis
		// quelques-uns suivis d'une attaque au hasard
		[6, 1 + rng(4)].forEach((wanted, which) => {
			const t = new R.Turn(ctx, st, who);
			if(t.needRetreat) {
				const d = t.dests(st.retreat);
				t.move(st.retreat, d[rng(d.length)]);
			}
			const steps = [];
			const pool = mine.slice();
			while(steps.length < wanted && pool.length) {
				const from = pool.splice(rng(pool.length), 1)[0];
				const probeTurn = steps.length < R.makeContext({}).maxMoves - t.n ? t : null;
				let d = probeTurn ? t.dests(from) : R.reach(ctx, t.st, from);
				if(!d.length) continue;
				const to = d[rng(d.length)];
				steps.push([from, to]);
				if(probeTurn) t.move(from, to);
			}
			const probe = { m: steps };
			if(t.r) probe.r = t.r;
			if(t.d !== undefined) probe.d = t.d;
			if(which === 1 && theirs.length) {
				const list = t.attacks();
				probe.a = list.length && rng(3) > 0 ? list[rng(list.length)].target : theirs[rng(theirs.length)];
			}
			if(st.retreat < 0 && rng(15) === 0) probe.r = [mine[0], mine[0] + 1];
			const res = R.playTurn(ctx, st, who, probe);
			lines.push("X " + (res.ok ? "ok" : res.error) + " " + moveText(probe));
		});
		for(let k = 0; k < 4; k++) {
			const probe = { m: [] };
			const steps = rng(7);
			let from = mine[rng(mine.length)];
			for(let s = 0; s < steps; s++) {
				const to = Math.max(0, Math.min(R.N - 1, from + (rng(5) - 2) * R.W + rng(5) - 2));
				probe.m.push([from, to]);
				// de temps en temps, la meme unite une seconde fois
				from = rng(4) === 0 ? to : mine[rng(mine.length)];
			}
			if(st.retreat >= 0 && rng(3) > 0 && probe.m.length) {
				probe.r = [st.retreat, probe.m[0][1]];
				probe.m.shift();
			}
			if(theirs.length && rng(2) === 0) probe.a = theirs[rng(theirs.length)];
			if(rng(12) === 0) probe.d = ctx.arsPos[rng(4)];
			const res = R.playTurn(ctx, st, who, probe);
			lines.push("X " + (res.ok ? "ok" : res.error) + " " + moveText(probe));
		}
	}
	const res = R.playTurn(ctx, st, who, mv);
	if(!res.ok) throw new Error("reference refused its own move: " + res.error);
	lines.push("M " + moveText(mv));
	lines.push("R " + position(res.state, -who));
	const end = R.outcome(ctx, res.state, who);
	lines.push("O " + end.winner + " " + (end.reason || "-"));
	positions++;
}

// Positions construites : les cas que des parties jouees ne rencontrent pas
// assez souvent pour qu'une regle fausse soit sure d'etre vue.
const { position: build } = require(path.join(jocly, "tests", "kriegspiel", "harness.js"));
[
	{ N: { I: "D3" }, S: { T: "D5" } },                       // une transmission ennemie n'arrete pas la ligne
	{ N: { I: "D3" }, S: { E: "D5", I: "T4" } },
	{ N: { I: "D3" }, S: { I: "D5" } },                       // une autre unite, si
	{ N: { T: "D3", E: "H3", I: "H6" }, S: { I: "T4" } },     // chaine de transmissions
	{ N: { I: "D6 E1", T: "E5" }, S: { I: "T4" } },           // transmission au contact, hors ligne
	{ N: { I: "D6 F4", T: "E5" }, S: { I: "T4" } },
	{ N: { I: "D6 E5 F4" }, S: { I: "T4" } },                 // contact en chaine
	{ N: { T: "D3", E: "H3", I: "H6" }, S: { I: "T4" }, ars: [0, 1, 1, 1] },
	{ N: { C: "F6" }, S: { I: "G5 I3" } },                    // unite isolee defendue a distance
	{ N: { C: "H4" }, S: { I: "H3", T: "G3" } },              // ecart nul
	{ N: { C: "H4" }, S: { I: "H3" } },                       // ecart de 1 : retraite
	{ N: { I: "H4 H5" }, S: { I: "H3" } },                    // ecart de 2 : destruction
	{ N: { C: "K6 K7 K8 K9", T: "D11", E: "K11" }, S: { I: "K5" } },   // colonne de 4
	{ N: { C: "K6 K8", I: "K7", T: "D11", E: "K11" }, S: { I: "K5" } },
	{ N: { C: "M4 M5", T: "D5", E: "M5".replace("M5", "D4") }, S: { I: "M3" } },   // cible en forteresse
	{ N: { C: "O15", T: "D15", E: "O14".replace("O14", "B14") }, S: { I: "O16" } },  // cible dans un col
	{ N: { C: "B8 B7" }, S: { I: "B9 T4" } },                 // cavalier en forteresse
	{ N: { C: "F10", I: "E9" }, S: { I: "F11 T4" } },         // cavalier dans un col
	{ N: { I: "K4" }, S: { I: "K5", C: "K6 K7 K8" } },        // cavalerie en defense, portee 2
	{ N: { I: "M5", T: "D5" }, S: { I: "M3 M4" } },           // soutien depuis une forteresse
	{ N: { T: "S8", C: "S4", I: "S6" }, S: { I: "Q4" } },     // arsenal a portee
	{ N: { T: "S8", C: "S4" }, S: { I: "T3" } },              // arsenal occupe
	{ N: { T: "S8", E: "S4" }, S: { I: "K20" } },             // une estafette n'y detruit rien
	{ N: { T: "R8", C: "R3" }, S: { I: "K20" } },             // la cavalerie s'arrete dans l'arsenal
	{ N: { I: "D7 D9" }, S: { C: "E8", T: "E3" } },           // ... et ne passe pas au travers (C8 n'est accessible que par D8)
	{ N: { I: "D7 D9" }, S: { E: "E8", T: "E3" } },           // une estafette, elle, traverse
	{ N: { C: "H4" }, S: { I: "H3 K3 L3 N3 O3 P3" }, retreat: "H3", who: -1 },   // retraite due
	{ N: { I: "D9" }, S: { I: "T1 S1 S2 T2", T: "T5" } },     // unite sans case libre
	{ N: { I: "D9" }, S: { I: "K10 M12" } },                  // tout est isole, sans transmission
	{ N: { I: "D9" }, S: { T: "T4", E: "T5" } },              // plus d'unite combattante
	{ N: { I: "D9" }, S: { I: "T4" }, ars: [1, 1, 0, 0] },    // plus d'arsenal
	{ N: { I: "D9" }, S: { I: "T4" }, turn: 399 },            // dernier coup avant la nulle
].forEach((spec) => {
	const sides = spec.who ? [spec.who] : [1, -1];
	sides.forEach((who) => record(build(R, spec), who, spec.retreat ? { r: [R.posOf("H3"), R.posOf("H2")], m: [] } : { m: [] }));
});
const scenarios = positions;

for(let g = 0; g < GAMES; g++) {
	let st = R.newState(), who = 1;
	for(let ply = 0; ply < 400; ply++) {
		let mv;
		if(st.phase < 2)
			mv = AI.placements(ctx, who, 1, rng)[0];
		else {
			const cands = AI.candidates(ctx, st, who, { max: 28, rng });
			// le meilleur a un coup, ou un candidat au hasard une fois sur cinq
			let best = cands[rng(cands.length)], bestScore = -Infinity;
			if(rng(5) > 0)
				for(const c of cands) {
					const s = AI.evaluate(ctx, R.playTurn(ctx, st, who, c).state, -who) * who + rng(100) / 100;
					if(s > bestScore) { bestScore = s; best = c; }
				}
			mv = best;
		}
		// toutes les positions qui comptent (retraite due, attaque, arsenal),
		// une sur quatre des autres
		const special = st.phase < 2 || st.retreat >= 0 || mv.a !== undefined || mv.d !== undefined;
		if(special || rng(4) === 0) record(st, who, mv);
		st = R.playTurn(ctx, st, who, mv).state;
		if(R.outcome(ctx, st, who).winner) break;
		who = -who;
	}
}
const out = path.join(__dirname, "fixtures", "differential.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(positions + " positions (" + scenarios + " built by hand), " + lines.length + " lines, " + Math.round(fs.statSync(out).size / 1024) + " KB -> " + out);
