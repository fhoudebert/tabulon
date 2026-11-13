//! Moteur de Péan, wargame tactique à hexagones de jocly2 : le niveau
//! « Maréchal » de Tabulon.
//!
//! - [`ctx`]      : le contexte d'un scénario, tel que jocly2 l'exporte ;
//! - [`rules`]    : les règles, portage fidèle de `pean-rules.js` ;
//! - [`ai`]       : évaluation et tours candidats ;
//! - [`search`]   : la recherche (alpha-bêta sur tours candidats) ;
//! - [`service`]  : une requête JSON, une réponse JSON.

pub mod ai;
pub mod ctx;
pub mod rules;
pub mod search;
pub mod service;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
