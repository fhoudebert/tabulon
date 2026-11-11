"""Verifie que le moteur et PyTorch calculent la meme chose.

    python check_export.py <echantillons.kspl> [--net net.pt] [--lab chemin/kriegspiel-lab]

Exporte le reseau (ou un reseau tire au hasard, normalisation par lots
comprise, si --net est absent), le fait evaluer par le moteur sur les
premieres positions du fichier (`kriegspiel-lab nneval`) et compare aux
valeurs de PyTorch. Echoue au-dela de 1e-4 d'ecart : les plans, l'ordre des
poids ou le repli de la normalisation ne sont alors plus d'accord.
"""

import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np
import torch

from ksnn import ValueNet, export_ksnn, load_checkpoint, planes_of, read_samples

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples")
    ap.add_argument("--net")
    ap.add_argument("--lab", default=os.path.join(HERE, "..", "..", "target", "release", "kriegspiel-lab"))
    ap.add_argument("--count", type=int, default=64)
    args = ap.parse_args()

    if args.net:
        model, _ = load_checkpoint(args.net)
    else:
        torch.manual_seed(3)
        model = ValueNet(channels=8, blocks=2, head=2, hidden=16)
        # statistiques de normalisation non triviales, pour eprouver le repli
        with torch.no_grad():
            for m in model.modules():
                if isinstance(m, torch.nn.BatchNorm2d):
                    m.running_mean.uniform_(-0.5, 0.5)
                    m.running_var.uniform_(0.5, 2.0)
                    m.weight.uniform_(0.5, 1.5)
                    m.bias.uniform_(-0.2, 0.2)
    model.eval()
    records = read_samples(args.samples)[: args.count]
    with torch.no_grad():
        expected = model(torch.from_numpy(planes_of(records))).numpy()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "net.ksnn")
        export_ksnn(model, path)
        out = subprocess.run([args.lab, "nneval", path, args.samples, "--count", str(args.count)],
                             check=True, capture_output=True, text=True).stdout
    got = np.array([float(line.split()[1]) for line in out.splitlines()])
    gap = np.max(np.abs(got - expected))
    print(f"{len(got)} positions, ecart maximal moteur / PyTorch : {gap:.2e}")
    print(f"  valeurs : {np.round(expected[:6], 4)} ...")
    if len(got) != len(expected) or gap > 1e-4:
        print("ECHEC : le moteur et PyTorch ne calculent pas la meme chose")
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
