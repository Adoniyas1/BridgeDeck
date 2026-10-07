//! Canvas (the school learning site): the calendar feed every student can copy from Canvas, and the
//! Canvas API with a personal access token for courses, assignments, grades and announcements.
//! Requests are made here rather than in the page because Canvas doesn't allow them from other sites.

use reqwest::Url;
use serde_json::Value;
use std::time::Duration;

const MAX_FEED: usize = 5 * 1024 * 1024;
const MAX_PAGE: usize = 10 * 1024 * 1024;
const MAX_PAGES: usize = 10;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("BridgeDeck/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// An https address with a host; plain http would send the token unprotected.
fn https(text: &str) -> Result<Url, String> {
    let text = text.trim();
    let text = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let url = Url::parse(&text).map_err(|_| "That isn’t a web address".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err("The address must start with https://".into());
    }
    Ok(url)
}

/// The API address for `path` on the school's Canvas site. Only `/api/v1/…` is allowed.
fn api_url(base: &str, path: &str) -> Result<Url, String> {
    if !path.starts_with("/api/v1/") || path.contains("..") || path.contains("://") || path.contains('#') {
        return Err("Not a Canvas API path".into());
    }
    let mut url = https(base)?;
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    url.join(path).map_err(|e| e.to_string())
}

/// The `rel="next"` address in a Link header, if it's on the same site.
fn next_link(header: &str, site: &Url) -> Option<Url> {
    header.split(',').find_map(|part| {
        let (target, params) = part.split_once(';')?;
        if !params.split(';').any(|p| matches!(p.trim(), "rel=\"next\"" | "rel=next")) {
            return None;
        }
        let url = Url::parse(target.trim().trim_start_matches('<').trim_end_matches('>')).ok()?;
        (url.scheme() == "https" && url.host_str() == site.host_str()).then_some(url)
    })
}

async fn body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n as usize > limit) {
        return Err("Canvas sent more than expected".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Canvas sent more than expected".into());
    }
    Ok(bytes.to_vec())
}

/// Downloads the Canvas calendar feed (Calendar → Calendar Feed in Canvas).
#[tauri::command]
pub async fn canvas_feed(feed: String) -> Result<String, String> {
    let url = https(&feed.replace("webcal://", "https://"))?;
    let response = client()?.get(url).send().await.map_err(|e| format!("Couldn’t reach Canvas: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Canvas answered {} for the calendar feed", response.status()));
    }
    let text = String::from_utf8_lossy(&body(response, MAX_FEED).await?).into_owned();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("That link isn’t a calendar feed. Copy it from Calendar → Calendar Feed in Canvas.".into());
    }
    Ok(text)
}

/// A GET from the Canvas API with the person's access token. Lists are followed across pages (up
/// to ten) and returned as one array.
#[tauri::command]
pub async fn canvas_api(base: String, token: String, path: String) -> Result<Value, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Add a Canvas access token first".into());
    }
    let first = api_url(&base, &path)?;
    let client = client()?;
    let mut next = Some(first.clone());
    let mut items: Vec<Value> = Vec::new();
    for _ in 0..MAX_PAGES {
        let Some(url) = next.take() else { break };
        let response = client.get(url).bearer_auth(token).send().await.map_err(|e| format!("Couldn’t reach Canvas: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Canvas didn’t accept the access token. Make a new one in Canvas → Account → Settings.".into());
        }
        if !status.is_success() {
            return Err(format!("Canvas answered {status}"));
        }
        next = response.headers().get("link").and_then(|h| h.to_str().ok()).and_then(|h| next_link(h, &first));
        match serde_json::from_slice::<Value>(&body(response, MAX_PAGE).await?).map_err(|_| "Canvas sent something unexpected".to_string())? {
            Value::Array(page) => items.extend(page),
            other if items.is_empty() => return Ok(other),
            _ => break,
        }
    }
    Ok(Value::Array(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths_stay_on_the_school_site() {
        assert_eq!(api_url("school.instructure.com", "/api/v1/courses?per_page=50").unwrap().as_str(), "https://school.instructure.com/api/v1/courses?per_page=50");
        assert_eq!(api_url("https://canvas.school.edu/courses/12", "/api/v1/users/self").unwrap().as_str(), "https://canvas.school.edu/api/v1/users/self");
        assert!(api_url("http://school.instructure.com", "/api/v1/courses").is_err());
        assert!(api_url("school.instructure.com", "/login").is_err());
        assert!(api_url("school.instructure.com", "/api/v1/../login").is_err());
        assert!(api_url("school.instructure.com", "/api/v1/x?u=https://evil.example").is_err());
    }

    #[test]
    fn next_page_only_on_the_same_site() {
        let site = Url::parse("https://school.instructure.com/api/v1/courses").unwrap();
        let header = r#"<https://school.instructure.com/api/v1/courses?page=1>; rel="current", <https://school.instructure.com/api/v1/courses?page=2>; rel="next""#;
        assert_eq!(next_link(header, &site).unwrap().as_str(), "https://school.instructure.com/api/v1/courses?page=2");
        assert!(next_link(r#"<https://evil.example/api/v1/courses?page=2>; rel="next""#, &site).is_none());
        assert!(next_link(r#"<https://school.instructure.com/x>; rel="last""#, &site).is_none());
    }

    #[test]
    fn feed_links_must_be_https() {
        assert!(https("http://school.instructure.com/feeds/calendars/user_x.ics").is_err());
        assert!(https("https://school.instructure.com/feeds/calendars/user_x.ics").is_ok());
    }
}
