"""La boucle d'entrainement par generations.

    python loop.py calibrate --run runs/essai [options]   # mesure, annonce la duree, ne garde rien
    python loop.py run       --run runs/essai [options]   # lance (ou reprend) la boucle

Une generation :
  1. auto-jeu avec le reseau en titre (le moteur actuel pour la premiere),
     positions ecrites pour le reseau (`kriegspiel-lab selfplay --planes 1`) ;
  2. entrainement sur les echantillons des dernieres generations, en partant
     du reseau en titre (train.py) ;
  3. match du nouveau reseau contre le reseau en titre (le moteur actuel
     pour la premiere) ; il prend le titre au-dela du seuil (55 % par defaut) ;
  4. toutes les `--report-every` generations, et a la fin : le reseau en titre
     contre le moteur actuel (poids `handmade`, sans reseau).

Tout est note dans le repertoire du run : `state.json` (pour reprendre),
`generations.md` (lisible, a verser au depot), `generations.jsonl` (detail),
`config.json` (les options), les reseaux dans `nets/` et les echantillons
dans `samples/`. Une generation interrompue est refaite depuis le debut.

Le match contre l'IA de jocly2 (`tools/duel-jocly.cjs`) n'est pas lance par la
boucle : il est lent et doit tourner seul sur la machine. La commande a
lancer est ecrite dans generations.md a chaque nouveau titre.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.abspath(os.path.join(HERE, "..", ".."))


def lab_path(args):
    return args.lab or os.path.join(CRATE, "target", "release", "kriegspiel-lab")


def run(cmd, log, env=None):
    """Lance une commande, recopie sa sortie dans le journal, rend sa sortie et sa duree."""
    started = time.time()
    with open(log, "a") as f:
        f.write(f"\n$ {' '.join(cmd)}\n")
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    with open(log, "a") as f:
        f.write(proc.stdout)
        f.write(proc.stderr)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit(f"echec : {' '.join(cmd)}")
    return proc.stdout, time.time() - started


def parse_match(text):
    m = re.search(r"\+(\d+) -(\d+) =(\d+)\s+score ([\d.]+)% \(\+-([\d.]+)\)", text)
    if not m:
        raise SystemExit(f"resultat de match illisible :\n{text}")
    endings = re.search(r"endings: (.*)", text)
    return {"won": int(m[1]), "lost": int(m[2]), "drawn": int(m[3]), "score": float(m[4]),
            "margin": float(m[5]), "endings": endings[1] if endings else ""}


def options(ap):
    ap.add_argument("--run", required=True, help="repertoire du run")
    ap.add_argument("--generations", type=int, default=12)
    ap.add_argument("--games", type=int, default=5000, help="parties d'auto-jeu par generation")
    ap.add_argument("--match-games", type=int, default=400)
    ap.add_argument("--adopt", type=float, default=55.0, help="score (%%) au-dela duquel le nouveau reseau prend le titre")
    ap.add_argument("--depth", type=int, default=2, help="profondeur de recherche de l'auto-jeu et des matchs")
    ap.add_argument("--eps", type=float, default=0.1, help="part de coups tires au hasard dans l'auto-jeu")
    ap.add_argument("--window", type=int, default=3, help="generations d'echantillons pour l'entrainement")
    ap.add_argument("--epochs", type=float, default=4)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--score-weight", type=float, default=0.0)
    ap.add_argument("--channels", type=int, default=32)
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 2, help="fils pour l'auto-jeu et les matchs")
    ap.add_argument("--train-threads", type=int, default=0, help="fils PyTorch (0 : son choix)")
    ap.add_argument("--device", default="auto", help="auto, cpu ou cuda (ROCm)")
    ap.add_argument("--report-every", type=int, default=3)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--openings", default=os.path.join(CRATE, "tests", "fixtures", "openings.txt"))
    ap.add_argument("--lab", help="chemin de kriegspiel-lab (defaut : target/release de la crate)")
    ap.add_argument("--keep-samples", type=int, default=0, help="garder les echantillons des N dernieres generations seulement (0 : tout garder)")


def generation(args, state, g, root, quick=None):
    """Une generation ; `quick` (calibrage) remplace les volumes."""
    lab = lab_path(args)
    log = os.path.join(root, "log.txt")
    games = quick["games"] if quick else args.games
    match_games = quick["match_games"] if quick else args.match_games
    epochs = quick["epochs"] if quick else args.epochs
    seed = args.seed * 1000 + g
    best = state.get("best")              # chemin sans extension, ou None
    samples = os.path.join(root, "samples", f"gen{g:03d}.kspl")
    cand = os.path.join(root, "nets", f"gen{g:03d}")
    os.makedirs(os.path.dirname(samples), exist_ok=True)
    os.makedirs(os.path.dirname(cand), exist_ok=True)
    rec = {"generation": g, "seed": seed, "opponent": os.path.basename(best) if best else "handmade"}

    # 1. auto-jeu
    cmd = [lab, "selfplay", args.openings, str(games), samples, "--planes", "1", "--depth", str(args.depth),
           "--eps", str(args.eps), "--threads", str(args.threads), "--seed", str(seed)]
    if best:
        cmd += ["--net", best + ".ksnn"]
    out, t = run(cmd, log)
    rec["selfplay_s"] = round(t)
    rec["selfplay"] = out.strip().splitlines()[0]
    rec["positions"] = (os.path.getsize(samples) - 16) // 1643

    # 2. entrainement
    window = [os.path.join(root, "samples", f"gen{k:03d}.kspl") for k in range(max(0, g - args.window + 1), g + 1)]
    window = [w for w in window if os.path.exists(w)]
    cmd = [sys.executable, os.path.join(HERE, "train.py"), "--data", *window, "--out", cand,
           "--epochs", str(epochs), "--batch", str(args.batch), "--lr", str(args.lr),
           "--score-weight", str(args.score_weight), "--channels", str(args.channels), "--blocks", str(args.blocks),
           "--device", args.device, "--threads", str(args.train_threads), "--seed", str(seed)]
    if best:
        cmd += ["--init", best + ".pt"]
    out, t = run(cmd, log)
    rec["train_s"] = round(t)
    with open(cand + ".json") as f:
        rec["train"] = json.load(f)

    # 3. match contre le titre
    cmd = [lab, "match", args.openings, str(match_games), "tuned", "tuned", "--net-a", cand + ".ksnn",
           "--net-b", (best + ".ksnn") if best else "none", "--depth", str(args.depth),
           "--threads", str(args.threads), "--seed", str(seed)]
    out, t = run(cmd, log)
    rec["match_s"] = round(t)
    rec["match"] = parse_match(out)
    rec["adopted"] = rec["match"]["score"] >= args.adopt
    return rec


def report_vs_handmade(args, state, root, games):
    lab = lab_path(args)
    cmd = [lab, "match", args.openings, str(games), "tuned", "tuned", "--net-a", state["best"] + ".ksnn",
           "--net-b", "none", "--depth", str(args.depth), "--threads", str(args.threads), "--seed", str(args.seed * 7)]
    out, t = run(cmd, os.path.join(root, "log.txt"))
    res = parse_match(out)
    res["seconds"] = round(t)
    return res


def write_markdown(root, args, state, history):
    lines = [
        f"# Run `{os.path.basename(os.path.abspath(root))}`",
        "",
        f"Reseau {args.blocks} blocs x {args.channels} canaux ; {args.games} parties d'auto-jeu par generation "
        f"(profondeur {args.depth}, {args.eps:.0%} de coups au hasard) ; entrainement sur {args.window} generation(s), "
        f"{args.epochs} passes ; titre au-dela de {args.adopt} % sur {args.match_games} parties. Graine {args.seed}. "
        "Options completes : `config.json`. Commandes et sorties : `log.txt`.",
        "",
        "| gen. | adversaire | positions | MSE val. avant -> apres | score contre le titre | titre ? | auto-jeu | entr. | match |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in history:
        if "generation" not in r:
            continue
        m, tr = r["match"], r["train"]
        lines.append(
            f"| {r['generation']} | {r['opponent']} | {r['positions']} | {tr['val_mse_before']:.3f} -> {tr['val_mse_after']:.3f} "
            f"| {m['score']:.1f} % +-{m['margin']:.1f} (+{m['won']} -{m['lost']} ={m['drawn']}) | {'oui' if r['adopted'] else 'non'} "
            f"| {r['selfplay_s'] // 60} min | {r['train_s'] // 60} min | {r['match_s'] // 60} min |")
    reports = [r for r in history if "vs_handmade" in r]
    if reports:
        lines += ["", "## Le reseau en titre contre le moteur actuel (sans reseau), meme profondeur", "",
                  "| apres gen. | reseau | score | fins de partie |", "|---|---|---|---|"]
        for r in reports:
            v = r["vs_handmade"]
            lines.append(f"| {r['after']} | {r['net']} | {v['score']:.1f} % +-{v['margin']:.1f} (+{v['won']} -{v['lost']} ={v['drawn']}) | {v['endings']} |")
    if state.get("best"):
        net = os.path.abspath(state["best"] + ".ksnn")
        lines += ["", "## Mesure contre jocly2 (a lancer seul sur la machine)", "", "```",
                  f"KRIEGSPIEL_NET={net} node {os.path.join(CRATE, 'tools', 'duel-jocly.cjs')} <chemin de jocly2> 2 3000 100",
                  "```", "",
                  "Le critere de reussite : au moins 70 % contre « Fort » sur 100 parties au moins."]
    with open(os.path.join(root, "generations.md"), "w") as f:
        f.write("\n".join(lines) + "\n")


def load_state(root):
    path = os.path.join(root, "state.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"next": 0, "best": None}


def save_state(root, state):
    tmp = os.path.join(root, "state.json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, os.path.join(root, "state.json"))


def history_of(root):
    path = os.path.join(root, "generations.jsonl")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def append_history(root, rec):
    with open(os.path.join(root, "generations.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")


def cmd_run(args):
    root = args.run
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "config.json"), "w") as f:
        json.dump(vars(args), f, indent=1)
    state = load_state(root)
    while state["next"] < args.generations:
        g = state["next"]
        print(f"generation {g} (titre : {os.path.basename(state['best']) if state['best'] else 'moteur actuel'})", flush=True)
        rec = generation(args, state, g, root)
        print(f"  auto-jeu {rec['selfplay_s']} s, entrainement {rec['train_s']} s, match {rec['match_s']} s ; "
              f"{rec['match']['score']:.1f} % +-{rec['match']['margin']:.1f} -> {'titre' if rec['adopted'] else 'rejete'}", flush=True)
        if rec["adopted"]:
            state["best"] = os.path.join(root, "nets", f"gen{g:03d}")
            shutil.copyfile(state["best"] + ".ksnn", os.path.join(root, "best.ksnn"))
        state["next"] = g + 1
        append_history(root, rec)
        if args.keep_samples > 0:
            old = os.path.join(root, "samples", f"gen{g - args.keep_samples:03d}.kspl")
            if os.path.exists(old) and g - args.keep_samples < g - args.window + 1:
                os.remove(old)
        if state["best"] and (state["next"] % args.report_every == 0 or state["next"] == args.generations):
            v = report_vs_handmade(args, state, root, args.match_games)
            append_history(root, {"after": g, "net": os.path.basename(state["best"]), "vs_handmade": v})
            print(f"  titre contre le moteur actuel : {v['score']:.1f} % +-{v['margin']:.1f}", flush=True)
        save_state(root, state)
        write_markdown(root, args, state, history_of(root))
    print(f"fini ; resume : {os.path.join(root, 'generations.md')}")


def cmd_calibrate(args):
    """Une mini-generation chronometree, puis l'extrapolation aux volumes demandes."""
    root = os.path.join(args.run, "calibration")
    if os.path.exists(root):
        shutil.rmtree(root)
    os.makedirs(root)
    quick = {"games": max(args.threads * 4, 48), "match_games": max(args.threads * 4, 48), "epochs": 1}
    print(f"calibrage : {quick['games']} parties d'auto-jeu, 1 passe d'entrainement, {quick['match_games']} parties de match "
          f"({args.threads} fils, appareil {args.device})", flush=True)
    state = {"next": 0, "best": None}
    g0 = generation(args, state, 0, root, quick)
    # deuxieme mini-generation avec un reseau en titre : l'auto-jeu et les matchs coutent alors plus cher
    state["best"] = os.path.join(root, "nets", "gen000")
    g1 = generation(args, state, 1, root, quick)
    per_game_selfplay = g1["selfplay_s"] / quick["games"]
    per_game_match = g1["match_s"] / quick["match_games"]
    positions_per_game = g1["positions"] / quick["games"]
    train_rate = g1["train"]["positions"] * 0.95 / max(g1["train_s"] - 3, 1)   # positions vues par seconde (1 passe)
    window_positions = positions_per_game * args.games * args.window
    selfplay = per_game_selfplay * args.games
    train = window_positions * args.epochs / train_rate
    match = per_game_match * args.match_games
    report = per_game_match * args.match_games / args.report_every
    per_gen = selfplay + train + match + report
    print("")
    print(f"mesure : {per_game_selfplay:.2f} s par partie d'auto-jeu, {positions_per_game:.0f} positions par partie, "
          f"{train_rate:.0f} positions/s a l'entrainement, {per_game_match:.2f} s par partie de match")
    print(f"par generation ({args.games} parties, fenetre de {args.window}, {args.epochs} passes, {args.match_games} parties de match) :")
    print(f"  auto-jeu {selfplay / 60:.0f} min, entrainement {train / 60:.0f} min (en regime : fenetre pleine), "
          f"match {match / 60:.0f} min, mesure contre le moteur actuel {report / 60:.0f} min en moyenne")
    print(f"  total : {per_gen / 60:.0f} min par generation ; {args.generations} generations : {per_gen * args.generations / 3600:.1f} h")
    print(f"  disque : {positions_per_game * args.games * 1643 / 1e9:.2f} Go d'echantillons par generation")
    shutil.rmtree(root)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("run", "calibrate"):
        options(sub.add_parser(name))
    args = ap.parse_args()
    if not os.path.exists(lab_path(args)):
        raise SystemExit(f"{lab_path(args)} introuvable : cargo build --release dans {CRATE}")
    {"run": cmd_run, "calibrate": cmd_calibrate}[args.command](args)


if __name__ == "__main__":
    main()
