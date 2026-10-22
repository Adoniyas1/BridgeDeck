//! The flashcard review log, and FSRS weights fitted to it.
//!
//! Each computer appends its reviews to `Study/.state/reviews/<instance>.jsonl`, one JSON object a
//! line: `{card, at, grade, ms}` (card id `note/block[/sub]`, time in ms, grade 1-4, ms spent).
//! Files only grow and each computer writes only its own, so syncing them never conflicts.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bridgelink::BridgeLinkManager;

/// Fewer reviews than this and the defaults are better than a fit.
pub const MIN_REVIEWS: usize = 400;
const MAX_LINE: usize = 2_000;
const DAY: u64 = 86_400_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Review {
    pub card: String,
    pub at: u64,
    pub grade: u32,
    #[serde(default)]
    pub ms: u64,
}

fn dir(study: &Path) -> PathBuf {
    study.join(".state").join("reviews")
}

fn device_file(device: &str) -> String {
    let safe: String = device.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    format!("{safe}.jsonl")
}

pub fn append(study: &Path, device: &str, review: &Review) -> Result<(), String> {
    if !(1..=4).contains(&review.grade) || review.card.is_empty() || review.card.len() > 300 {
        return Err("Not a review".into());
    }
    let folder = dir(study);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new().create(true).append(true).open(folder.join(device_file(device))).map_err(|e| e.to_string())?;
    let line = serde_json::to_string(review).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| format!("Couldn't save the review: {e}"))
}

/// Every computer's reviews, oldest first, each once. Lines that don't parse (a half-synced line,
/// a newer format) are skipped.
pub fn read(study: &Path) -> Vec<Review> {
    let mut seen = HashSet::new();
    let mut out: Vec<Review> = fs::read_dir(dir(study))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .flat_map(|text| text.lines().filter(|l| l.len() <= MAX_LINE).filter_map(|l| serde_json::from_str::<Review>(l).ok()).collect::<Vec<_>>())
        .filter(|r| (1..=4).contains(&r.grade) && seen.insert((r.card.clone(), r.at)))
        .collect();
    out.sort_by_key(|r| r.at);
    out
}

/// The training set: for each card, one item per review after its first, holding the reviews up
/// to it with the days between them (0 for the first). Several reviews on one day count as the
/// first of them, as FSRS models a day at a time.
pub fn train_set(reviews: &[Review]) -> Vec<fsrs::FSRSItem> {
    let mut by_card: BTreeMap<&str, Vec<&Review>> = BTreeMap::new();
    for r in reviews {
        by_card.entry(&r.card).or_default().push(r);
    }
    let mut items = Vec::new();
    for list in by_card.values() {
        let mut days: Vec<(u64, u32)> = Vec::new();
        for r in list {
            let day = r.at / DAY;
            if days.last().is_none_or(|(d, _)| *d != day) {
                days.push((day, r.grade));
            }
        }
        let history: Vec<fsrs::FSRSReview> = days.iter().enumerate().map(|(i, (day, grade))| fsrs::FSRSReview { rating: *grade, delta_t: if i == 0 { 0 } else { (day - days[i - 1].0) as u32 } }).collect();
        for end in 2..=history.len() {
            items.push(fsrs::FSRSItem { reviews: history[..end].to_vec() });
        }
    }
    items
}

#[derive(Debug, Serialize)]
pub struct Tuned {
    pub weights: Vec<f32>,
    pub reviews: usize,
    pub cards: usize,
}

pub fn tune(reviews: &[Review]) -> Result<Tuned, String> {
    if reviews.len() < MIN_REVIEWS {
        return Err(format!("Needs {MIN_REVIEWS} reviews to tune; there are {} so far", reviews.len()));
    }
    let items = train_set(reviews);
    let cards = reviews.iter().map(|r| &r.card).collect::<HashSet<_>>().len();
    let weights = fsrs::compute_parameters(fsrs::ComputeParametersInput { train_set: items, ..Default::default() }).map_err(|e| format!("Couldn't tune: {e}"))?;
    Ok(Tuned { weights, reviews: reviews.len(), cards })
}

#[tauri::command]
pub fn study_review_log(manager: State<'_, BridgeLinkManager>, review: Review) -> Result<(), String> {
    let device = manager.instance_id();
    if device.is_empty() {
        return Err("BridgeLink hasn't started yet".into());
    }
    append(&crate::study::current_root()?, &device, &review)
}

#[tauri::command]
pub fn study_review_history() -> Result<Vec<Review>, String> {
    Ok(read(&crate::study::current_root()?))
}

/// FSRS weights fitted to every computer's reviews (takes a few seconds).
#[tauri::command]
pub async fn study_fsrs_tune() -> Result<Tuned, String> {
    let study = crate::study::current_root()?;
    tauri::async_runtime::spawn_blocking(move || tune(&read(&study))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review(card: &str, day: u64, grade: u32) -> Review {
        Review { card: card.into(), at: day * DAY + 3_600_000, grade, ms: 0 }
    }

    #[test]
    fn logs_from_both_computers_are_read_together_once() {
        let study = std::env::temp_dir().join(format!("bd-reviews-{}", std::process::id()));
        let _ = fs::remove_dir_all(&study);
        append(&study, "mac", &review("n/a", 1, 3)).unwrap();
        append(&study, "pc", &review("n/a", 3, 1)).unwrap();
        // The same review synced twice, a half-written line and a bad grade are skipped.
        fs::write(dir(&study).join("old.jsonl"), format!("{}\n{{\"card\":\"n/a\"\n{{\"card\":\"x\",\"at\":1,\"grade\":9}}\n", serde_json::to_string(&review("n/a", 1, 3)).unwrap())).unwrap();
        let all = read(&study);
        assert_eq!(all, vec![review("n/a", 1, 3), review("n/a", 3, 1)]);
        assert!(append(&study, "mac", &Review { grade: 0, ..review("n/a", 1, 3) }).is_err());
        let _ = fs::remove_dir_all(&study);
    }

    #[test]
    fn training_items_count_days_between_reviews() {
        let reviews = vec![review("a", 10, 3), review("a", 10, 1), review("a", 13, 3), review("a", 20, 4), review("b", 5, 3)];
        let items = train_set(&reviews);
        assert_eq!(items.len(), 2);
        let last: Vec<(u32, u32)> = items[1].reviews.iter().map(|r| (r.rating, r.delta_t)).collect();
        assert_eq!(last, vec![(3, 0), (3, 3), (4, 7)]);
    }

    #[test]
    fn tuning_needs_enough_reviews_and_gives_weights() {
        assert!(tune(&[review("a", 1, 3)]).unwrap_err().contains("Needs 400"));
        // A made-up history: 60 cards, each reviewed on a growing schedule, sometimes forgotten.
        let mut reviews = Vec::new();
        for c in 0..60u64 {
            let mut day = c % 7;
            let mut gap = 1;
            for k in 0..8u64 {
                let grade = if (c + k) % 5 == 0 { 1 } else { 3 };
                reviews.push(review(&format!("c{c}"), day, grade as u32));
                gap = if grade == 1 { 1 } else { gap * 2 + 1 };
                day += gap;
            }
        }
        let tuned = tune(&reviews).unwrap();
        assert_eq!(tuned.cards, 60);
        assert!(tuned.weights.len() >= 19, "{:?}", tuned.weights);
        assert!(tuned.weights.iter().all(|w| w.is_finite()));
    }
}
