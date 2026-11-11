"""Reseau de valeur du Jeu de la guerre : modele PyTorch, lecture des
echantillons d'auto-jeu, export au format lu par le moteur (src/nn.rs).

Trois formats doivent rester d'accord avec le Rust ; chacun renvoie a sa
definition de reference :
- les plans d'entree : en tete de src/nn.rs ;
- les echantillons `selfplay --planes 1` : `write_planes_header` dans src/bin/lab.rs ;
- le fichier du reseau (KSNN) : en tete de src/nn.rs.

`python check_export.py` verifie l'accord de bout en bout : il exporte un
reseau, le fait evaluer par le moteur (`kriegspiel-lab nneval`) et compare.
"""

import struct

import numpy as np
import torch
import torch.nn as nn

ROWS, COLS = 20, 25
N = ROWS * COLS
PLANES = 27           # plans d'entree du reseau
BINARY_PLANES = 26    # plans 0..25, tasses bit a bit dans les echantillons
PACKED = BINARY_PLANES * N // 8

# un enregistrement d'echantillon (voir lab.rs, write_planes_header)
RECORD = np.dtype([
    ("bits", np.uint8, (PACKED,)),
    ("progress", "<f4"),
    ("z", "<f4"),
    ("score", "<i4"),
    ("who", "i1"),
    ("from_net", "u1"),
    ("ply", "<u2"),
    ("length", "<u2"),
])
assert RECORD.itemsize == PACKED + 18

NET_SCALE = 20000.0   # search.rs : NET_SCALE
NO_SCORE = np.iinfo(np.int32).min


def read_samples(path):
    """Les enregistrements d'un fichier `selfplay --planes 1`."""
    with open(path, "rb") as f:
        head = f.read(16)
        if head[:4] != b"KSPL":
            raise ValueError(f"{path} : pas un fichier d'echantillons KSPL")
        version, planes, cells = struct.unpack("<3I", head[4:])
        if (version, planes, cells) != (1, BINARY_PLANES, N):
            raise ValueError(f"{path} : format {version}/{planes}/{cells}, attendu 1/{BINARY_PLANES}/{N}")
        data = np.fromfile(f, dtype=RECORD)
    return data


def planes_of(records):
    """Plans d'entree (lot, PLANES, ROWS, COLS) en float32, a partir des enregistrements."""
    bits = np.unpackbits(records["bits"], axis=1, bitorder="little")[:, : BINARY_PLANES * N]
    x = np.empty((len(records), PLANES, N), dtype=np.float32)
    x[:, :BINARY_PLANES, :] = bits.reshape(len(records), BINARY_PLANES, N)
    x[:, BINARY_PLANES, :] = records["progress"][:, None]
    return x.reshape(len(records), PLANES, ROWS, COLS)


def targets_of(records, score_weight=0.0, handmade_scale=3000.0):
    """Cible de valeur pour le camp au trait.

    Le resultat de la partie (z), melange au besoin a l'avis de la recherche :
    `score_weight` = 0 : z seul ; 1 : la recherche seule. Le score de la
    recherche est ramene dans [-1, 1] : divise par NET_SCALE s'il vient du
    reseau, passe par tanh(score / handmade_scale) s'il vient de l'evaluation
    ponderee. Les coups tires au hasard n'ont pas de score : z seul.
    """
    z = records["z"].astype(np.float32)
    if score_weight <= 0:
        return z
    score = records["score"].astype(np.float64)
    has = records["score"] != NO_SCORE
    q = np.where(records["from_net"] == 1, score / NET_SCALE, np.tanh(score / handmade_scale))
    q = np.clip(q, -1.0, 1.0).astype(np.float32)
    return np.where(has, (1 - score_weight) * z + score_weight * q, z).astype(np.float32)


class Block(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.c1 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(c)
        self.c2 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(c)

    def forward(self, x):
        y = torch.relu(self.b1(self.c1(x)))
        return torch.relu(self.b2(self.c2(y)) + x)


class ValueNet(nn.Module):
    """La meme architecture que src/nn.rs : tronc 3x3, blocs residuels, tete
    1x1, deux couches denses, tanh."""

    def __init__(self, channels=32, blocks=4, head=2, hidden=64):
        super().__init__()
        self.config = dict(channels=channels, blocks=blocks, head=head, hidden=hidden)
        self.stem = nn.Conv2d(PLANES, channels, 3, padding=1, bias=False)
        self.stem_bn = nn.BatchNorm2d(channels)
        self.blocks = nn.ModuleList(Block(channels) for _ in range(blocks))
        self.head = nn.Conv2d(channels, head, 1, bias=False)
        self.head_bn = nn.BatchNorm2d(head)
        self.fc1 = nn.Linear(head * N, hidden)
        self.fc2 = nn.Linear(hidden, 1)

    def forward(self, x):
        x = torch.relu(self.stem_bn(self.stem(x)))
        for block in self.blocks:
            x = block(x)
        x = torch.relu(self.head_bn(self.head(x)))
        x = torch.relu(self.fc1(x.flatten(1)))
        return torch.tanh(self.fc2(x)).squeeze(1)


def _fold(conv, bn):
    """Poids et biais d'une convolution sans biais suivie d'une normalisation par lots."""
    scale = bn.weight / torch.sqrt(bn.running_var + bn.eps)
    w = conv.weight * scale.reshape(-1, 1, 1, 1)
    b = bn.bias - bn.running_mean * scale
    return w, b


def export_ksnn(model, path):
    """Ecrit le reseau au format KSNN (src/nn.rs), normalisation repliee."""
    model = model.eval().cpu()
    cfg = model.config
    parts = []
    with torch.no_grad():
        parts += list(_fold(model.stem, model.stem_bn))
        for block in model.blocks:
            parts += list(_fold(block.c1, block.b1))
            parts += list(_fold(block.c2, block.b2))
        hw, hb = _fold(model.head, model.head_bn)
        parts += [hw.reshape(cfg["head"], cfg["channels"]), hb]
        parts += [model.fc1.weight, model.fc1.bias, model.fc2.weight, model.fc2.bias]
        flat = np.concatenate([p.detach().numpy().astype("<f4").ravel() for p in parts])
    header = b"KSNN" + struct.pack("<7I", 1, PLANES, cfg["channels"], cfg["blocks"], cfg["head"], cfg["hidden"], 0)
    with open(path, "wb") as f:
        f.write(header)
        f.write(flat.tobytes())
    return len(header) + flat.nbytes


def save_checkpoint(model, optimizer, path, extra=None):
    torch.save({"config": model.config, "model": model.state_dict(),
                "optimizer": optimizer.state_dict() if optimizer else None, "extra": extra or {}}, path)


def load_checkpoint(path, device="cpu"):
    data = torch.load(path, map_location=device, weights_only=False)
    model = ValueNet(**data["config"]).to(device)
    model.load_state_dict(data["model"])
    return model, data
