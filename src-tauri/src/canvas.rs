//! Canvas (the school learning site): the calendar feed every student can copy from Canvas, and the
//! Canvas API with a personal access token for courses, assignments, grades and announcements.
//! Requests are made here rather than in the page because Canvas doesn't allow them from other sites.
//!
//! Schools that turn access tokens off: the person signs in to Canvas in a BridgeDeck browser page,
//! and the API is read with that sign-in (the browser pages' cookies), as Canvas's own pages do.

use reqwest::Url;
use tauri::{AppHandle, Manager};
use serde_json::Value;
use std::time::Duration;

const MAX_FEED: usize = 5 * 1024 * 1024;
const MAX_PAGE: usize = 10 * 1024 * 1024;
const MAX_PAGES: usize = 10;

const NOT_SIGNED_IN: &str = "Not signed in to Canvas. Settings → Study → Canvas → “Sign in to Canvas”, sign in on the page that opens, then refresh.";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("BridgeDeck/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// For the API: a request that isn't signed in is sent to the login page, which is seen as that
/// rather than followed.
fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("BridgeDeck/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
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

/// A browser page to read cookies from (they share one store): an open one, else a hidden page
/// made for it.
fn cookie_page(app: &AppHandle, site: &Url) -> Option<tauri::Webview> {
    let open = |app: &AppHandle| app.webviews().into_iter().find(|(label, _)| label.starts_with("browser-")).map(|(_, view)| view);
    if let Some(view) = open(app) {
        return Some(view);
    }
    crate::browser::browser_show(app.clone(), SESSION_PAGE.into(), Some(site.to_string()), 0.0, 0.0, 1.0, 1.0).ok()?;
    let _ = crate::browser::browser_hide(app.clone(), SESSION_PAGE.into());
    open(app)
}

const SESSION_PAGE: &str = "canvassession";

/// The Cookie header for the Canvas site from the browser pages' sign-in, if there is one.
async fn session_cookie(app: &AppHandle, site: &Url) -> Result<String, String> {
    let (app, site) = (app.clone(), site.clone());
    // On Windows, reading cookies must happen off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let view = cookie_page(&app, &site).ok_or("Couldn’t open a page to read the Canvas sign-in")?;
        let cookies = view.cookies_for_url(site).map_err(|e| e.to_string())?;
        Ok(cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; "))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Canvas answers requests signed in with cookies with `while(1);` before the JSON.
fn strip_guard(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"while(1);").unwrap_or(bytes)
}

/// Downloads a calendar someone subscribes to (Outlook's "Publish calendar" ICS link, Google's
/// secret address, any https or webcal .ics link) for the Calendar tab to show.
#[tauri::command]
pub async fn calendar_subscription(url: String) -> Result<String, String> {
    let url = https(&url.replace("webcal://", "https://"))?;
    let response = client()?.get(url).send().await.map_err(|e| format!("Couldn’t reach the calendar: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The calendar answered {}", response.status()));
    }
    let text = String::from_utf8_lossy(&body(response, MAX_FEED).await?).into_owned();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("That link isn’t a calendar (.ics). In Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS link.".into());
    }
    Ok(text)
}

/// A GET from the Canvas API with the person's access token, or without one with their sign-in in
/// BridgeDeck's browser. Lists are followed across pages (up to ten) and returned as one array.
#[tauri::command]
pub async fn canvas_api(app: AppHandle, base: String, token: String, path: String) -> Result<Value, String> {
    let token = token.trim();
    let first = api_url(&base, &path)?;
    let cookie = if token.is_empty() {
        let mut site = first.clone();
        site.set_path("/");
        site.set_query(None);
        let cookie = session_cookie(&app, &site).await?;
        if cookie.is_empty() {
            return Err(NOT_SIGNED_IN.into());
        }
        Some(cookie)
    } else {
        None
    };
    let client = api_client()?;
    let mut next = Some(first.clone());
    let mut items: Vec<Value> = Vec::new();
    for _ in 0..MAX_PAGES {
        let Some(url) = next.take() else { break };
        let request = match &cookie {
            Some(cookie) => client.get(url).header(reqwest::header::COOKIE, cookie).header(reqwest::header::ACCEPT, "application/json"),
            None => client.get(url).bearer_auth(token),
        };
        let response = request.send().await.map_err(|e| format!("Couldn’t reach Canvas: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || (cookie.is_some() && status.is_redirection()) {
            return Err(if cookie.is_some() { NOT_SIGNED_IN.into() } else { "Canvas didn’t accept the access token. Make a new one in Canvas → Account → Settings.".into() });
        }
        if !status.is_success() {
            return Err(format!("Canvas answered {status}"));
        }
        next = response.headers().get("link").and_then(|h| h.to_str().ok()).and_then(|h| next_link(h, &first));
        match serde_json::from_slice::<Value>(strip_guard(&body(response, MAX_PAGE).await?)).map_err(|_| "Canvas sent something unexpected".to_string())? {
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
    fn cookie_answers_lose_their_guard() {
        assert_eq!(strip_guard(b"while(1);[1,2]"), b"[1,2]");
        assert_eq!(strip_guard(b"[1,2]"), b"[1,2]");
    }

    #[test]
    fn feed_links_must_be_https() {
        assert!(https("http://school.instructure.com/feeds/calendars/user_x.ics").is_err());
        assert!(https("https://school.instructure.com/feeds/calendars/user_x.ics").is_ok());
    }
}
