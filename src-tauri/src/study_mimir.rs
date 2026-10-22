//! What Mimir reads about the user's courses beyond their books: assignments (the shared Canvas
//! copy, items ticked done on either computer, and ones added by hand), grades worked out from the
//! grade sheets the way the Study tab does (grades.ts), and class times. Dates are left as they are
//! stored (ms, "YYYY-MM-DD", "HH:MM") for Mimir to put in local time.

use std::collections::BTreeMap;

use serde_json::{json, Value};

/// One assignment as Mimir sees it.
pub fn assignment(a: &Value, done: bool) -> Value {
    json!({
        "id": a["id"], "course": a["course"], "title": a["title"], "kind": a["kind"], "due": a["due"],
        "points": a["points"], "score": a.get("score").cloned().unwrap_or(Value::Null), "submitted": a["submitted"],
        "missing": a["missing"], "done": done, "source": "canvas",
    })
}

/// The Canvas copy's assignments (the API's version of an item over the feed's) with done ticks
/// from either computer, then the hand-added ones (`(course: title, due, checked)`).
pub fn assignments(snapshot: Option<&Value>, done: &BTreeMap<String, Value>, manual: &[(String, Option<i64>, bool)]) -> Vec<Value> {
    let mut by_id: Vec<(String, Value)> = Vec::new();
    for list in ["feed", "api"] {
        for a in snapshot.and_then(|s| s[list].as_array()).into_iter().flatten() {
            let Some(id) = a["id"].as_str() else { continue };
            match by_id.iter_mut().find(|(k, _)| k == id) {
                Some((_, old)) => {
                    let mut merged = a.clone();
                    for key in ["url", "course"] {
                        if merged[key].as_str().is_none_or(str::is_empty) {
                            merged[key] = old[key].clone();
                        }
                    }
                    *old = merged;
                }
                None => by_id.push((id.to_string(), a.clone())),
            }
        }
    }
    let mut out: Vec<Value> = by_id
        .into_iter()
        .filter(|(_, a)| a["kind"].as_str() != Some("event"))
        .map(|(id, a)| assignment(&a, done.get(&id) == Some(&Value::Bool(true)) || a["submitted"] == Value::Bool(true)))
        .collect();
    for (text, due, checked) in manual {
        let (course, title) = match text.split_once(": ") {
            Some((c, t)) if c.chars().count() <= 40 && !c.contains(':') => (c.trim(), t.trim()),
            _ => ("", text.trim()),
        };
        out.push(json!({ "course": course, "title": title, "kind": "assignment", "due": due, "done": checked, "source": "added" }));
    }
    out.sort_by_key(|a| a["due"].as_i64().unwrap_or(i64::MAX));
    out
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

/// A category's points (got, out of), with the `drop` lowest regular scores left out while more
/// than that are graded, and extra credit adding only to what was got.
fn category_points(c: &Value) -> (f64, f64) {
    let items: Vec<&Value> = c["items"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let graded: Vec<(f64, f64, bool)> = items.iter().filter_map(|i| Some((num(&i["got"])?, num(&i["max"]).unwrap_or(100.0).max(0.0), i["extra"] == Value::Bool(true)))).collect();
    let mut regular: Vec<(f64, f64)> = graded.iter().filter(|(_, max, extra)| !extra && *max > 0.0).map(|(g, m, _)| (*g, *m)).collect();
    regular.sort_by(|a, b| (b.0 / b.1).total_cmp(&(a.0 / a.1)));
    let drop = num(&c["drop"]).unwrap_or(0.0).max(0.0) as usize;
    if drop > 0 && regular.len() > drop {
        regular.truncate(regular.len() - drop);
    }
    let extra: f64 = graded.iter().filter(|(_, _, extra)| *extra).map(|(g, _, _)| g).sum();
    (regular.iter().map(|(g, _)| g).sum::<f64>() + extra, regular.iter().map(|(_, m)| m).sum())
}

/// The course grade so far (percent of what's graded), as grades.ts works it out.
pub fn current_percent(grading: &Value) -> Option<f64> {
    let categories = grading["categories"].as_array()?;
    if grading["mode"].as_str() == Some("points") {
        let (got, max) = categories.iter().map(category_points).fold((0.0, 0.0), |(g, m), (a, b)| (g + a, m + b));
        return (max > 0.0).then(|| got / max * 100.0);
    }
    let (mut weight, mut sum) = (0.0, 0.0);
    for c in categories {
        let (got, max) = category_points(c);
        let w = num(&c["weight"]).unwrap_or(0.0);
        if max > 0.0 && w > 0.0 {
            weight += w;
            sum += got / max * 100.0 * w;
        }
    }
    (weight > 0.0).then(|| sum / weight)
}

/// CSULB's letters (no plus or minus).
pub fn letter(percent: f64) -> &'static str {
    [("A", 90.0), ("B", 80.0), ("C", 70.0), ("D", 60.0)].iter().find(|(_, min)| percent >= min - 1e-9).map(|(l, _)| *l).unwrap_or("F")
}

/// A course's grade for Mimir: the grade sheet's percent and letter, each category, the goal, and
/// what Canvas says.
pub fn grade_summary(grading: Option<&Value>, canvas: Option<&Value>) -> Value {
    let percent = grading.and_then(current_percent);
    let categories: Vec<Value> = grading
        .and_then(|g| g["categories"].as_array())
        .into_iter()
        .flatten()
        .map(|c| {
            let (got, max) = category_points(c);
            let items = c["items"].as_array().map(|a| a.iter().map(|i| json!({ "name": i["name"], "got": i["got"], "max": i["max"] })).collect::<Vec<_>>()).unwrap_or_default();
            json!({ "name": c["name"], "weight": c["weight"], "percent": (max > 0.0).then(|| (got / max * 1000.0).round() / 10.0), "items": items })
        })
        .collect();
    json!({
        "percent": percent.map(|p| (p * 10.0).round() / 10.0),
        "letter": percent.map(letter),
        "goal": grading.and_then(|g| num(&g["goal"])),
        "categories": categories,
        "canvas": canvas.map(|c| json!({ "score": c["score"], "grade": c["grade"] })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignments_merge_canvas_copies_ticks_and_added_ones() {
        let snapshot = json!({
            "feed": [{ "id": "a1", "title": "HW 4", "course": "EE 310", "kind": "assignment", "due": 300, "url": "https://feed", "submitted": false }, { "id": "e1", "kind": "event", "title": "Lecture" }],
            "api": [{ "id": "a1", "title": "HW 4", "course": "", "kind": "assignment", "due": 300, "url": "", "points": 10, "submitted": false }, { "id": "q1", "title": "Quiz 2", "course": "MATH 370", "kind": "quiz", "due": 100, "submitted": true }],
        });
        let done = BTreeMap::from([("a1".to_string(), json!(true))]);
        let list = assignments(Some(&snapshot), &done, &[("EE 310: Lab report".into(), Some(200), false), ("Read ch 3".into(), None, true)]);
        let short: Vec<(String, String, bool)> = list.iter().map(|a| (a["title"].as_str().unwrap().into(), a["course"].as_str().unwrap().into(), a["done"].as_bool().unwrap())).collect();
        assert_eq!(short, vec![("Quiz 2".into(), "MATH 370".into(), true), ("Lab report".into(), "EE 310".into(), false), ("HW 4".into(), "EE 310".into(), true), ("Read ch 3".into(), "".into(), true)]);
        assert_eq!(list[2]["points"], json!(10));
    }

    #[test]
    fn grades_are_worked_out_like_the_study_tab() {
        let grading = json!({ "goal": 85, "categories": [
            { "name": "Homework", "weight": 20, "drop": 1, "items": [{ "name": "1", "got": 5, "max": 10 }, { "name": "2", "got": 9, "max": 10 }, { "name": "3", "got": 10, "max": 10 }, { "name": "bonus", "got": 1, "max": 0, "extra": true }] },
            { "name": "Exams", "weight": 80, "items": [{ "name": "Midterm", "got": 80, "max": 100 }, { "name": "Final", "got": null, "max": 100 }] },
        ] });
        // Homework: (9 + 10 + 1) / 20 = 100%; exams 80%; weighted (100·20 + 80·80) / 100 = 84%.
        let summary = grade_summary(Some(&grading), Some(&json!({ "score": 83.5, "grade": "B" })));
        assert_eq!(summary["percent"], json!(84.0));
        assert_eq!(summary["letter"], json!("B"));
        assert_eq!(summary["goal"], json!(85.0));
        assert_eq!(summary["categories"][0]["percent"], json!(100.0));
        assert_eq!(summary["canvas"]["grade"], json!("B"));
        let points = json!({ "mode": "points", "categories": [{ "name": "All", "weight": 0, "items": [{ "name": "a", "got": 45, "max": 50 }] }] });
        assert_eq!(current_percent(&points), Some(90.0));
        assert_eq!(grade_summary(None, None)["percent"], Value::Null);
    }
}
