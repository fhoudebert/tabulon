// app/content/sample-books.js
//
// Exemples livres avec l'application, affiches en vignettes sur l'ecran
// "Charger une partie". Ils sont la pour repondre a une question que la
// documentation ne repond jamais bien : a quoi ressemble un fichier que
// Tabulon sait ouvrir ? On peut donc les LANCER (meme circuit que le
// selecteur de fichier, rien de special) ou les ENREGISTRER pour les
// relire, les modifier, s'en servir de gabarit.
//
// Le contenu est en dur plutot que dans des fichiers a cote : ces textes
// font quelques centaines d'octets, et un module JS traverse le build et la
// reecriture d'assets sans configuration, ce qu'un repertoire de donnees ne
// fait pas.
//
// `game` sert a la vignette (miniature du jeu dans le catalogue) et doit
// exister dans le catalogue, sinon l'exemple est simplement masque -- une
// installation reduite ne doit pas afficher de vignette morte.

const ES3_PJN = `[JoclyGame "chu-shogi"]
[Event "es3"]
[Date "2026.8.10"]
[PlyCount "9"]
[FEN "8+lc1l/7+h2ok/4+H3Q3/9Fg1/11p/9D2/12/12/12/12/4+L7/10K1 w - - 0 1"]
[SetUp "1"]

1. FLj9-k10+ Gk9xk10 2. DKj7-j9=+DK+ Gk10xj9 3. +Le2-l9+ +Li12xl9
4. FKi10-k12+ Kl11xk12 5. +DHe10-k10+
`;

const ES3_JSON = `{
  "game": "chu-shogi",
  "initialBoard": "8+lc1l/7+h2ok/4+H3Q3/9Fg1/11p/9D2/12/12/12/12/4+L7/10K1 w - - 0 1",
  "playedMoves": [
    { "f": 105, "t": 118, "c": null, "a": "FL", "ck": true },
    { "f": 106, "t": 118, "c": 0, "a": "G", "ep": false, "ck": false },
    { "f": 81, "t": 105, "c": null, "pr": 51, "a": "DK", "ck": true },
    { "f": 118, "t": 105, "c": 2, "a": "G", "ep": false, "ck": false },
    { "f": 16, "t": 107, "c": null, "a": "+L", "ck": true },
    { "f": 140, "t": 107, "c": 1, "a": "+L", "ep": false, "ck": false },
    { "f": 116, "t": 142, "c": null, "a": "FK", "ck": true },
    { "f": 131, "t": 142, "c": 4, "a": "K", "ep": false, "ck": false },
    { "f": 112, "t": 118, "c": null, "a": "+DH", "ck": true }
  ]
}
`;

const ROCAILLE_PJN = `[JoclyGame "rocaille"]
[Event "rocaille"]
[Date "2026.7.29"]
[PlyCount "13"]

1. Wg3-g6 Ph8-i7 2. Pi3-j4 Wg8-k4 3. Ai2-i6*1 Pg9-g8 4. Ai6-k6 Pj8-j7
5. Ak6-k5*1 Pj7-k7 6. Ak5-k6*1 Ai9-k7 7. Ak6-j6
`;

const MATE_PGN = `[Event "Mat en deux"]
[Game classic-chess]
[Result "1-0"]
[FEN "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1"]
[SetUp "1"]

1. Ra8+ Kg8-h8 2. Ra8-a1 1-0
`;

const BOOK_PGN = `[JoclyGame "classic-chess"]
[Event "Ouvertures"]
[White "Blancs"]
[Black "Noirs"]
[Date "2026.1.1"]
[PlyCount "6"]

1. e2-e4 e7-e5 2. Ng1-f3 Nb8-c6 3. Bf1-b5 a7-a6

[JoclyGame "classic-chess"]
[Event "Defense sicilienne"]
[White "Blancs"]
[Black "Noirs"]
[Date "2026.1.1"]
[PlyCount "6"]

1. e2-e4 c7-c5 2. Ng1-f3 d7-d6 3. d2-d4 c5xd4
`;

// `kind` designe la RUBRIQUE illustree par l'exemple, pas le format : c'est
// ce que l'utilisateur cherche a comprendre en arrivant sur cet ecran.
//   'book'    : plusieurs parties dans un fichier
//   'game'    : une partie complete depuis la position initiale
//   'problem' : une suite de coups a partir d'une position donnee
export const SAMPLES = [
    {
        id: 'es3-pjn', game: 'chu-shogi', kind: 'problem',
        fileName: 'es3.pjn', text: ES3_PJN,
    },
    {
        id: 'es3-json', game: 'chu-shogi', kind: 'problem',
        fileName: 'es3-solution.json', text: ES3_JSON,
    },
    {
        id: 'mate2', game: 'classic-chess', kind: 'problem',
        fileName: 'mat-en-deux.pgn', text: MATE_PGN,
    },
    {
        id: 'openings', game: 'classic-chess', kind: 'book',
        fileName: 'ouvertures.pgn', text: BOOK_PGN,
    },
    {
        id: 'rocaille', game: 'rocaille', kind: 'game',
        fileName: 'rocaille.pjn', text: ROCAILLE_PJN,
    },
];
