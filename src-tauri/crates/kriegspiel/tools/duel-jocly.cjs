// Match de mesure : le moteur Rust contre l'IA uct de jocly2 (la reference de
// force, puisque c'est elle que le joueur a deja). Camps alternes, placements
// tires des gabarits de jocly2, chaque coup du moteur valide par jocly2.
//
//   node tools/duel-jocly.cjs <chemin de jocly2> <niveau 0|1|2> <ms par coup> <parties> [options de `go`]
//
// jocly2 doit etre construit (`npx gulp build`) et le moteur aussi
// (`cargo build --release`). Niveaux : 0 Rapide, 1 Normal, 2 Fort.
// Avec la variable KRIEGSPIEL_NET=<fichier .ksnn>, le moteur joue avec ce
// reseau de valeur (setoption net) ; sans elle, avec l'evaluation ponderee.
// Lancer un seul match a la fois : le budget du moteur est en temps, et deux
// matchs en parallele sur la meme machine faussent la profondeur atteinte.
const path = require("path");
const JOCLY = process.argv[2];
if (!JOCLY || process.argv.length < 6) {
  console.error("usage: node tools/duel-jocly.cjs <chemin de jocly2> <niveau 0|1|2> <ms par coup> <parties> [options de go]");
  process.exit(2);
}
const { spawn } = require("child_process");
const readline = require("readline");
const Jocly = require(path.join(JOCLY, "dist", "node", "jocly.core.js"));
const ENGINE = path.join(__dirname, "..", "target", "release", "kriegspiel-engine" + (process.platform === "win32" ? ".exe" : ""));
const levelIndex = parseInt(process.argv[3], 10), movetime = parseInt(process.argv[4], 10), games = parseInt(process.argv[5], 10);
const extra = process.argv.slice(6).join(" ");
const CH = "ICAHTE";
function positionOf(board) {
  let g = "", e = 0;
  for (let p = 0; p < 500; p++) { const v = board.grid[p]; if (!v) { e++; continue; } if (e) { g += e; e = 0; } g += v > 0 ? CH[v - 1] : CH[-v - 1].toLowerCase(); }
  if (e) g += e;
  return [board.mWho > 0 ? "N" : "S", board.phase, board.turn, board.ars.map((a) => a ? 1 : 0).join(""), board.retreat >= 0 ? board.retreat : "-", g].join(" ");
}
function parseMove(text) {
  const mv = { m: [] };
  if (text === "pass") return mv;
  for (const w of text.split(" ")) {
    if (w.startsWith("r:")) mv.r = w.slice(2).split("-").map(Number);
    else if (w[0] === "x") mv.a = +w.slice(1);
    else if (w[0] === "d") mv.d = +w.slice(1);
    else mv.m.push(w.split("-").map(Number));
  }
  return mv;
}
const child = spawn(ENGINE);
const rl = readline.createInterface({ input: child.stdout });
if (process.env.KRIEGSPIEL_NET) child.stdin.write("setoption net " + path.resolve(process.env.KRIEGSPIEL_NET) + "\n");
// poids de l'evaluation a essayer (fichier `nom valeur`, voir eval.rs)
if (process.env.KRIEGSPIEL_WEIGHTS) child.stdin.write("setoption weights " + path.resolve(process.env.KRIEGSPIEL_WEIGHTS) + "\n");
let waiting = null, info = "";
rl.on("line", (line) => { if (line.startsWith("error") && !waiting) { console.error("moteur :", line); process.exit(1); } if (line.startsWith("info")) info = line; if ((line.startsWith("bestmove") || line.startsWith("error")) && waiting) { const w = waiting; waiting = null; w(line); } });
function go(board) {
  return new Promise((resolve) => { waiting = resolve; child.stdin.write("position " + positionOf(board) + "\ngo movetime " + movetime + " " + extra + "\n"); });
}
(async () => {
  const tally = { engine: 0, jocly: 0, draw: 0 }, lengths = [], depths = [];
  for (let g = 0; g < games; g++) {
    const engineSide = g % 2 === 0 ? 1 : -1;
    const match = await Jocly.createMatch("jeu-de-la-guerre");
    const level = (await match.getConfig()).model.levels[levelIndex];
    let plies = 0, result;
    for (;;) {
      const board = match.game.mBoard;
      let move;
      if (board.phase >= 2 && board.mWho === engineSide) {
        const line = await go(board);
        if (!line.startsWith("bestmove")) throw new Error(line);
        move = parseMove(line.slice(9));
        depths.push(+info.split(" ")[2]);
      } else move = (await match.machineSearch({ level, threaded: false })).move;
      result = await match.applyMove(move);   // leve une exception si le coup du moteur est refuse
      plies++;
      if (result.finished) break;
    }
    const who = result.winner === Jocly.DRAW ? "draw" : result.winner === engineSide ? "engine" : "jocly";
    tally[who]++; lengths.push(plies);
    console.log("game", g + 1, "engine plays", engineSide > 0 ? "North" : "South", "->", who, match.game.mBoard.reason, plies, "plies");
  }
  console.log("RESULT vs level", levelIndex, "engine", movetime + "ms", extra, "net", process.env.KRIEGSPIEL_NET || "none", JSON.stringify(tally), "mean plies", Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length), "mean engine depth", (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1));
  child.stdin.write("quit\n");
})().catch((e) => { console.error("ERROR", e); child.kill(); process.exit(1); });
