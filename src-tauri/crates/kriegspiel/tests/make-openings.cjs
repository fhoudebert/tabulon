// Produit tests/fixtures/openings.txt : des positions de debut de partie
// (les deux deploiements faits, le Nord au trait), tirees des gabarits de
// deploiement de jocly2. kriegspiel-lab en part pour ses parties.
//
//   node tests/make-openings.cjs <chemin de jocly2> [nombre] [graine]
const fs = require("fs");
const path = require("path");
const jocly = process.argv[2];
if(!jocly) {
	console.error("usage: node tests/make-openings.cjs <chemin de jocly2> [nombre] [graine]");
	process.exit(2);
}
const COUNT = parseInt(process.argv[3], 10) || 200;
let seed = parseInt(process.argv[4], 10) || 1965;
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
const lines = new Set();
while(lines.size < COUNT) {
	let st = R.newState();
	st = R.playTurn(ctx, st, 1, AI.placements(ctx, 1, 1, rng)[0]).state;
	st = R.playTurn(ctx, st, -1, AI.placements(ctx, -1, 1, rng)[0]).state;
	let grid = "", empty = 0;
	for(let p = 0; p < R.N; p++) {
		const v = st.grid[p];
		if(v === 0) { empty++; continue; }
		if(empty) { grid += empty; empty = 0; }
		grid += v > 0 ? CHARS[v - 1] : CHARS[-v - 1].toLowerCase();
	}
	if(empty) grid += empty;
	lines.add("N 2 2 1111 - " + grid);
}
const out = path.join(__dirname, "fixtures", "openings.txt");
fs.writeFileSync(out, Array.from(lines).join("\n") + "\n");
console.log(lines.size + " openings -> " + out);
