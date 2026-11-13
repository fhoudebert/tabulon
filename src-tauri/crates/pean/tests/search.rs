//! La recherche : un tour légal, dans le temps, et l'arrêt demandé respecté.

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use pean::ctx::Ctx;
use pean::rules::{play_turn, to_move, State};
use pean::search::{search, Limits};
use serde_json::Value;

fn start() -> (Ctx, State) {
    let v: Value = serde_json::from_str(include_str!("fixtures/search.json")).unwrap();
    let ctx = Ctx::from_value(&v["context"]).unwrap();
    let st = State::parse(&ctx, &v["state"]).unwrap();
    (ctx, st)
}

#[test]
fn the_best_move_is_legal_and_on_time() {
    let (ctx, mut st) = start();
    // quelques tours de partie, moteur contre moteur
    for _ in 0..4 {
        let who = to_move(&st);
        let t0 = Instant::now();
        let r = search(&ctx, &st, Limits { time: Duration::from_millis(300), ..Limits::default() }, None).expect("un tour");
        assert!(t0.elapsed() < Duration::from_millis(1500), "trop long : {:?}", t0.elapsed());
        assert!(r.depth >= 1 && r.nodes > 0);
        let mv = serde_json::to_value(&r.best).unwrap();
        let turn = play_turn(&ctx, &st, who, &mv).expect("tour légal");
        st = turn.st;
    }
}

#[test]
fn a_stop_request_ends_the_search() {
    let (ctx, st) = start();
    let stop = AtomicBool::new(true);
    let t0 = Instant::now();
    let r = search(&ctx, &st, Limits { time: Duration::from_secs(20), ..Limits::default() }, Some(&stop)).expect("un tour");
    assert!(t0.elapsed() < Duration::from_secs(2));
    assert_eq!(r.depth, 1);
}

#[test]
fn the_service_answers_in_json() {
    let v: Value = serde_json::from_str(include_str!("fixtures/search.json")).unwrap();
    let req = serde_json::json!({ "context": v["context"], "state": v["state"], "moveTimeMs": 200 });
    let reply = pean::service::handle(&req, None);
    assert!(reply.get("move").is_some(), "{reply}");
    let probe = pean::service::handle(&serde_json::json!({ "probe": true }), None);
    assert_eq!(probe["engine"], "pean");
    // déploiement libre : le moteur refuse, jocly2 joue lui-même
    let mut placing = req.clone();
    placing["state"]["phase"] = serde_json::json!(0);
    assert_eq!(pean::service::handle(&placing, None)["error"], "placement");
}
