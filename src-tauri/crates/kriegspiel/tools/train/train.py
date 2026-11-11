"""Entraine le reseau de valeur sur des echantillons d'auto-jeu.

    python train.py --data gen000.kspl gen001.kspl --out net-001 \
        [--init net-000.pt] [--epochs 4] [--batch 512] [--lr 2e-3] \
        [--channels 32 --blocks 4 --head 2 --hidden 64] \
        [--score-weight 0] [--device auto|cpu|cuda] [--threads n] [--seed 1]

Ecrit <out>.pt (pour reprendre l'entrainement) et <out>.ksnn (pour le
moteur), et affiche les pertes. `--init` part d'un reseau precedent : c'est
le cas normal dans la boucle, chaque generation affine la precedente.

Validation : les parties, pas les positions, sont reparties entre
entrainement et validation (une partie entiere d'un cote ou de l'autre) ; sans
cela, des positions voisines de la meme partie se retrouveraient des deux
cotes et la perte de validation serait trompeuse.
"""

import argparse
import json
import time

import numpy as np
import torch

from ksnn import ValueNet, export_ksnn, load_checkpoint, planes_of, read_samples, save_checkpoint, targets_of


def pick_device(name):
    if name == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"   # ROCm se presente comme "cuda"
    return name


def game_ids(records):
    """Un identifiant de partie par enregistrement : une partie commence au coup 0."""
    starts = (records["ply"] == 0).astype(np.int64)
    return np.cumsum(starts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--out", required=True, help="prefixe des fichiers ecrits (.pt, .ksnn, .json)")
    ap.add_argument("--init", help="checkpoint .pt de depart")
    ap.add_argument("--epochs", type=float, default=4)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--channels", type=int, default=32)
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--head", type=int, default=2)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--score-weight", type=float, default=0.0, help="part de l'avis de la recherche dans la cible (0 : resultat seul)")
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--threads", type=int, default=0, help="fils de calcul au processeur (0 : choix de PyTorch)")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    if args.threads > 0:
        torch.set_num_threads(args.threads)
    device = pick_device(args.device)

    records = np.concatenate([read_samples(p) for p in args.data])
    # une partie commence au coup 0, dans chaque fichier : les identifiants
    # restent distincts d'un fichier a l'autre
    games = game_ids(records)
    ids = np.unique(games)
    val_games = rng.choice(ids, size=max(1, int(len(ids) * args.val_frac)), replace=False)
    is_val = np.isin(games, val_games)
    train_idx, val_idx = np.flatnonzero(~is_val), np.flatnonzero(is_val)
    y_all = targets_of(records, args.score_weight)
    print(f"{len(records)} positions de {len(ids)} parties ({len(train_idx)} entrainement, {len(val_idx)} validation) ; "
          f"resultats : {np.mean(records['z'] > 0):.1%} gagnes, {np.mean(records['z'] == 0):.1%} nuls ; appareil {device}", flush=True)

    if args.init:
        model, _ = load_checkpoint(args.init, device)
        print(f"depart : {args.init} {model.config}")
    else:
        model = ValueNet(args.channels, args.blocks, args.head, args.hidden).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    steps = max(1, int(args.epochs * len(train_idx) / args.batch))
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.1)

    def batch(idx):
        x = torch.from_numpy(planes_of(records[idx])).to(device)
        y = torch.from_numpy(y_all[idx]).to(device)
        return x, y

    def evaluate():
        model.eval()
        total, right, decided, n = 0.0, 0, 0, 0
        with torch.no_grad():
            for i in range(0, len(val_idx), 2048):
                idx = val_idx[i:i + 2048]
                x, y = batch(idx)
                v = model(x)
                total += torch.sum((v - y) ** 2).item()
                z = torch.from_numpy(records["z"][idx]).to(device)
                mask = z != 0
                right += torch.sum((torch.sign(v) == torch.sign(z)) & mask).item()
                decided += torch.sum(mask).item()
                n += len(idx)
        model.train()
        return total / max(n, 1), right / max(decided, 1)

    before = evaluate()
    print(f"validation avant : erreur quadratique {before[0]:.4f}, signe juste {before[1]:.1%}", flush=True)
    started = time.time()
    model.train()
    done, running = 0, 0.0
    while done < steps:
        order = rng.permutation(train_idx)
        for i in range(0, len(order) - args.batch + 1, args.batch):
            x, y = batch(np.sort(order[i:i + args.batch]))
            loss = torch.mean((model(x) - y) ** 2)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            scheduler.step()
            running = 0.98 * running + 0.02 * loss.item() if done else loss.item()
            done += 1
            if done % 200 == 0 or done == steps:
                rate = done * args.batch / (time.time() - started)
                print(f"  pas {done}/{steps}  perte {running:.4f}  {rate:.0f} positions/s", flush=True)
            if done >= steps:
                break
    after = evaluate()
    elapsed = time.time() - started
    print(f"validation apres : erreur quadratique {after[0]:.4f}, signe juste {after[1]:.1%} ; {elapsed:.0f} s", flush=True)

    model = model.cpu()
    save_checkpoint(model, optimizer, args.out + ".pt", {"data": args.data, "args": vars(args)})
    size = export_ksnn(model, args.out + ".ksnn")
    report = {
        "positions": int(len(records)), "games": int(len(ids)), "device": device, "seconds": round(elapsed),
        "val_mse_before": round(before[0], 5), "val_mse_after": round(after[0], 5),
        "val_sign_before": round(before[1], 4), "val_sign_after": round(after[1], 4),
        "config": model.config, "ksnn_bytes": size,
    }
    with open(args.out + ".json", "w") as f:
        json.dump(report, f, indent=1)
    print(f"-> {args.out}.pt, {args.out}.ksnn ({size / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
