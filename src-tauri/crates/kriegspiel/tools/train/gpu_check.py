"""Faut-il entrainer sur la carte graphique ? On mesure au lieu de supposer.

    python gpu_check.py [--channels 32 --blocks 4] [--batch 512] [--steps 30]

Chronometre des pas d'entrainement (passe avant + arriere + Adam) sur le
processeur, puis sur la carte graphique si PyTorch en voit une (ROCm se
presente comme « cuda »). Donne des positions par seconde et le rapport des
deux. Sur la Radeon 890M (gfx1150), il faut un PyTorch construit pour ROCm
et le pilote amdgpu ; voir le README, « Machine d'entrainement ».
"""

import argparse
import time

import torch

from ksnn import COLS, PLANES, ROWS, ValueNet


def bench(device, args):
    torch.manual_seed(0)
    model = ValueNet(args.channels, args.blocks, args.head, args.hidden).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
    x = (torch.rand(args.batch, PLANES, ROWS, COLS, device=device) < 0.1).float()
    y = torch.rand(args.batch, device=device) * 2 - 1

    def step():
        loss = torch.mean((model(x) - y) ** 2)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        return loss

    for _ in range(3):   # echauffement : compilation des noyaux, allocations
        step()
    if device != "cpu":
        torch.cuda.synchronize()
    started = time.time()
    for _ in range(args.steps):
        loss = step()
    loss.item()
    if device != "cpu":
        torch.cuda.synchronize()
    return args.steps * args.batch / (time.time() - started)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--channels", type=int, default=32)
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--head", type=int, default=2)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--steps", type=int, default=30)
    args = ap.parse_args()

    print(f"PyTorch {torch.__version__} ; reseau {args.blocks} blocs x {args.channels} canaux ; lots de {args.batch}")
    print(f"processeur : {torch.get_num_threads()} fils")
    cpu = bench("cpu", args)
    print(f"  processeur : {cpu:,.0f} positions/s".replace(",", " "))
    if not torch.cuda.is_available():
        hip = getattr(torch.version, "hip", None)
        print("carte graphique : aucune vue par PyTorch"
              + (" (PyTorch construit pour ROCm, mais aucun peripherique : pilote, groupes video/render ?)" if hip else
                 " (ce PyTorch n'est pas construit pour ROCm)"))
        print("=> entrainer au processeur")
        return
    name = torch.cuda.get_device_name(0)
    print(f"carte graphique : {name} (ROCm {getattr(torch.version, 'hip', None)})")
    try:
        gpu = bench("cuda", args)
    except Exception as e:   # noyau absent pour gfx1150, memoire...
        print(f"  echec sur la carte graphique : {e}")
        print("=> entrainer au processeur")
        return
    print(f"  carte graphique : {gpu:,.0f} positions/s".replace(",", " "))
    ratio = gpu / cpu
    print(f"=> carte graphique {ratio:.1f} fois {'plus rapide' if ratio >= 1 else 'plus lente'} que le processeur ; "
          + ("l'utiliser (train.py --device cuda)" if ratio >= 1.5 else "rester au processeur (train.py --device cpu)"))


if __name__ == "__main__":
    main()
