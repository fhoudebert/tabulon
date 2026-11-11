//! Moteur du Jeu de la guerre (Guy Debord, Alice Becker-Ho).
//!
//! - [`rules`]  : les regles, portage de `kriegspiel-rules.js` (jocly2) ;
//! - [`eval`]   : l'evaluation statique ;
//! - [`search`] : la recherche (tours construits par faisceau, puis alpha-beta
//!   sur les tours) ;
//! - [`proto`]  : le format texte des positions et des coups ;
//! - [`service`] : l'appel unique dont un hote a besoin.
//!
//! Conventions, identiques a celles de jocly2 : plateau de 25 colonnes sur 20
//! lignes, `pos = ligne * 25 + colonne - 1` (ligne A = 0) ; camps 1 = Nord,
//! -1 = Sud ; une case de la grille vaut 0 (vide) ou `camp * type`.

pub mod eval;
pub mod proto;
pub mod rules;
pub mod search;
pub mod service;

pub use rules::{Ctx, Move, State};
pub use search::{Limits, SearchResult};

/// version du moteur, annoncee a l'hote
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
