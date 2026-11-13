//! Test différentiel : les règles Rust contre la référence jocly2.
//!
//! `tests/fixtures/*.json` est produit par `tests/make-fixture.cjs` à partir
//! de `pean-rules.js` : positions de parties réelles, avec les destinations,
//! les combats possibles et des tours (valides ou abîmés) avec leur verdict.
//! Tout doit coïncider, sans exception.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use pean::ctx::Ctx;
use pean::ai::{candidates, evaluate, Rng, WEIGHTS};
use pean::rules::{outcome, play_turn, Facing, State, Turn};
use serde_json::{json, Value};

/// le JSON qu'écrit jocly2 pour `{ hexagone: chemin }` (clés numériques croissantes)
fn reach_text(r: &[(i32, Vec<i32>)]) -> String {
    let parts: Vec<String> = r.iter().map(|(h, p)| format!("\"{h}\":{}", serde_json::to_string(p).unwrap())).collect();
    format!("{{{}}}", parts.join(","))
}

/// FNV-1a 32 bits, comme make-fixture.cjs (texte ASCII)
fn fnv(text: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in text.encode_utf16() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

/// la valeur attendue est en clair (--full) ou une empreinte
fn same(text: String, expected: &Value) -> bool {
    match expected {
        Value::String(d) => fnv(&text) == *d,
        v => serde_json::from_str::<Value>(&text).unwrap() == *v,
    }
}

fn ids(v: &Value) -> Vec<i64> {
    v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect()
}

fn usizes(v: &Value) -> Vec<usize> {
    v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect()
}

fn check_targets(turn: &Turn, expected: &Value, at: &str, counts: &mut BTreeMap<&'static str, usize>) {
    let targets = turn.targets();
    let expected = expected.as_array().unwrap();
    assert_eq!(targets.len(), expected.len(), "{at} : nombre de cibles");
    for ((t, a), x) in targets.iter().zip(expected) {
        assert_eq!(json!(t), x["t"], "{at} : cible");
        assert_eq!(json!(a), x["a"], "{at} : attaquants de {t}");
        for s in x["strengths"].as_array().unwrap() {
        let r = turn.strength(&ids(&s["ids"]), *t as i64).expect("force");
        let got = json!({
            "ids": s["ids"], "att": r.att, "def": r.def, "col": r.col,
            "result": r.result.map(|x| x.name()), "ranged": r.ranged
        });
        // les nombres : comparaison numérique (5 et 5.0)
        for k in ["att", "def"] {
            assert!((got[k].as_f64().unwrap() - s[k].as_f64().unwrap()).abs() < 1e-9, "{at} : {k} contre {t} : {got} / {s}");
        }
        for k in ["col", "result", "ranged"] {
            assert_eq!(got[k], s[k], "{at} : {k} contre {t}");
        }
        *counts.entry("forces").or_default() += 1;
        }
    }
}

fn check_file(path: &Path, counts: &mut BTreeMap<&'static str, usize>) {
    let data: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let ctx = Ctx::from_value(&data["context"]).expect("contexte");
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    for (pi, pos) in data["positions"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} position {pi}");
        let who = pos["who"].as_i64().unwrap() as i8;
        let st = State::parse(&ctx, &pos["before"]).expect("état");
        assert_eq!(serde_json::to_value(st.to_json(&ctx)).unwrap(), pos["before"], "{at} : aller-retour de l'état");
        let close = |a: f64, b: &Value| (a - b.as_f64().unwrap()).abs() < 1e-9;
        assert!(close(evaluate(&ctx, &st, &WEIGHTS), &pos["eval"]), "{at} : évaluation {} / {}", evaluate(&ctx, &st, &WEIGHTS), pos["eval"]);
        let mut rng = Rng::new(pos["cseed"].as_i64().unwrap() as i32);
        let cands = candidates(&ctx, &st, who, 14, &mut rng);
        let got = serde_json::to_value(&cands).unwrap();
        let want: Vec<Value> = pos["cands"].as_array().unwrap().iter().map(|m| {
            // jocly2 omet o / k vides ? non : toMove les écrit toujours
            m.clone()
        }).collect();
        for (i, (g, w)) in got.as_array().unwrap().iter().zip(&want).enumerate() {
            assert_eq!(g, w, "{at} : tour candidat {i}");
        }
        assert_eq!(got.as_array().unwrap().len(), want.len(), "{at} : nombre de tours candidats");
        *counts.entry("candidats").or_default() += cands.len();
        let probe = &pos["probe"];
        let turn = Turn::new(&ctx, &st, who);
        assert_eq!(json!(turn.arrived), probe["arrived"], "{at} : renforts");
        assert_eq!(json!(turn.max_orders), probe["maxOrders"], "{at} : ordres");
        assert!(same(serde_json::to_string(&turn.st.to_json(&ctx)).unwrap(), &probe["state"]), "{at} : état du tour");
        for u in probe["units"].as_array().unwrap() {
            let id = u["id"].as_u64().unwrap() as usize;
            assert_eq!(json!(turn.why_not_order(&[id as i64])), u["why"], "{at} : why-not {id}");
            assert!(same(reach_text(&turn.reach(&[id])), &u["reach"]), "{at} : destinations de {id}");
            *counts.entry("unités").or_default() += 1;
        }
        for g in probe["groups"].as_array().unwrap() {
            let list = usizes(&g["ids"]);
            assert_eq!(json!(turn.why_not_order(&ids(&g["ids"]))), g["why"], "{at} : why-not {list:?}");
            assert!(same(reach_text(&turn.reach(&list)), &g["reach"]), "{at} : destinations du groupe {list:?}");
            *counts.entry("groupes").or_default() += 1;
        }
        check_targets(&turn, &probe["targets"], &at, counts);
        for c in pos["contact"].as_array().unwrap() {
            let mut turn = Turn::new(&ctx, &st, who);
            for o in c["o"].as_array().unwrap() {
                let f = o.get("f").and_then(|x| x.as_i64()).map(|x| Facing::Dir(x as i32)).unwrap_or(Facing::None);
                assert!(turn.order(&ids(&o["u"]), &ids(&o["c"]), f), "{at} : ordre {o}");
            }
            check_targets(&turn, &c["targets"], &format!("{at} contact"), counts);
        }
        for (ti, trial) in pos["trials"].as_array().unwrap().iter().enumerate() {
            let at = format!("{at} tour {ti} {}", trial["move"]);
            match play_turn(&ctx, &st, who, &trial["move"]) {
                Err(e) => {
                    assert_eq!(json!(e), trial["error"], "{at} : refusé à tort");
                    *counts.entry("refus").or_default() += 1;
                }
                Ok(t) => {
                    assert!(trial.get("error").is_none(), "{at} : accepté à tort ({})", trial["error"]);
                    assert!(same(serde_json::to_string(&t.st.to_json(&ctx)).unwrap(), &trial["state"]), "{at} : état");
                    let (w, why) = outcome(&ctx, &t.st, who);
                    let reason = if w == 0 { Value::Null } else { json!(why) };
                    assert_eq!(json!({"winner": w, "reason": reason}), trial["outcome"], "{at} : issue");
                    assert!(close(evaluate(&ctx, &t.st, &WEIGHTS), &trial["eval"]), "{at} : évaluation après le tour");
                    *counts.entry("tours").or_default() += 1;
                }
            }
        }
        *counts.entry("positions").or_default() += 1;
    }
}

#[test]
fn rules_match_reference() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut counts = BTreeMap::new();
    let mut files: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().map_or(false, |x| x == "json") && p.file_name().map_or(false, |n| n != "search.json")).collect();
    files.sort();
    assert!(files.len() >= 4, "fixtures manquantes : node tests/make-fixture.cjs <jocly2>");
    for f in &files {
        check_file(f, &mut counts);
    }
    eprintln!("{counts:?}");
    assert!(counts["positions"] >= 80, "fixtures trop petites");
    assert!(counts["refus"] >= 100 && counts["tours"] >= 100);
}
