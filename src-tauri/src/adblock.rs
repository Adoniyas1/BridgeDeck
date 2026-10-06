//! The ad blocker for the Browser tab, the TV tab and the ChatGPT panel.
//!
//! Rules come from EasyList and EasyPrivacy (the standard ad and tracker lists, downloaded and kept
//! up to date here, never bundled). Only the plain, safe parts are used:
//! - `||ads.example.com^` (and `$third-party`): requests to that server are refused;
//!   `@@||…^` exceptions let a server through again;
//! - `##.ad-banner` and `example.com##.promo` (Mac): page elements hidden.
//!
//! macOS: the rules become a Safari content-blocker list that WebKit itself applies (blocking and
//! hiding). Windows: each request the page makes is checked against the servers here, and refused.

// Request checking runs on Windows; WebKit does it itself on macOS.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager};

/// Each list's name and where to get it: easylist.to, else EasyList's own copy on GitHub.
pub const LISTS: [(&str, [&str; 2]); 2] = [
    ("easylist", ["https://easylist.to/easylist/easylist.txt", "https://raw.githubusercontent.com/easylist/easylist/gh-pages/easylist.txt"]),
    ("easyprivacy", ["https://easylist.to/easylist/easyprivacy.txt", "https://raw.githubusercontent.com/easylist/easylist/gh-pages/easyprivacy.txt"]),
];
/// Lists older than this are fetched again (EasyList changes daily; a few days is plenty).
const REFRESH: Duration = Duration::from_secs(4 * 24 * 3600);
/// The most cosmetic (hiding) rules kept, so WebKit's list stays quick to build.
const MAX_HIDING: usize = 30_000;

/// Kinds of request a rule can be limited to (none set = every kind).
pub mod kind {
    pub const SCRIPT: u8 = 1;
    pub const IMAGE: u8 = 2;
    pub const STYLE: u8 = 4;
    pub const FETCH: u8 = 8;
    pub const FRAME: u8 = 16;
    pub const MEDIA: u8 = 32;
    pub const FONT: u8 = 64;
    pub const OTHER: u8 = 128;
}

/// One server rule: a server (and its subdomains), optionally only a path on it, only when
/// another site loads from it, or only some kinds of request.
#[derive(Clone, Debug, PartialEq)]
pub struct NetRule {
    /// The start of the path, e.g. "/pagead/" (`*` matches anything).
    pub path: Option<String>,
    pub third_party: bool,
    /// `kind::*` bits; 0 for every kind.
    pub kinds: u8,
}

#[derive(Default, Debug)]
pub struct Rules {
    /// Requests refused, by server.
    pub block: HashMap<String, Vec<NetRule>>,
    /// Requests let through even if refused above, by server.
    pub allow: HashMap<String, Vec<NetRule>>,
    /// Elements hidden on every site.
    pub hide: Vec<String>,
    /// Elements hidden on particular sites: (sites, selector).
    pub hide_on: Vec<(Vec<String>, String)>,
}

fn valid_host(host: &str) -> bool {
    host.contains('.') && !host.starts_with('.') && !host.ends_with('.')
        && host.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// A selector WebKit is sure to accept: plain element, class, id and attribute selectors (one
/// invalid selector would make WebKit refuse the whole list).
fn safe_selector(sel: &str) -> bool {
    !sel.is_empty() && sel.len() <= 200
        && !sel.contains(':') && !sel.contains(',') && !sel.contains('{') && !sel.contains('\\')
        && sel.chars().all(|c| c.is_ascii_alphanumeric() || " #.-_[]=\"'^$*~|>+()".contains(c))
        && sel.matches('[').count() == sel.matches(']').count()
        && sel.matches('"').count() % 2 == 0 && sel.matches('\'').count() % 2 == 0
}

/// The options after `$`, if every one of them is understood: (third party only, kinds).
/// Rules for some sites only, first-party only, pop-ups, whole pages and the like aren't used.
fn options(text: &str) -> Option<(bool, u8)> {
    let (mut third_party, mut kinds) = (false, 0u8);
    for option in text.split(',') {
        match option {
            "third-party" | "3p" => third_party = true,
            "script" => kinds |= kind::SCRIPT,
            "image" => kinds |= kind::IMAGE,
            "stylesheet" | "css" => kinds |= kind::STYLE,
            "xmlhttprequest" | "xhr" | "ping" | "websocket" => kinds |= kind::FETCH,
            "subdocument" | "frame" => kinds |= kind::FRAME,
            "media" => kinds |= kind::MEDIA,
            "font" => kinds |= kind::FONT,
            "object" | "other" => kinds |= kind::OTHER,
            _ => return None,
        }
    }
    Some((third_party, kinds))
}

/// A path part of a rule, if it's a plain one: letters, digits and `/_.-=?&`, with `*` for "any"
/// and an optional `^` or `|` at the end.
fn plain_path(path: &str) -> Option<String> {
    let path = path.trim_end_matches(['^', '|']);
    (path.starts_with('/') && path.len() > 1 && path.len() <= 120
        && path.chars().all(|c| c.is_ascii_alphanumeric() || "/_.-=?&*".contains(c)))
        .then(|| path.to_string())
}

/// The usable rules in an Adblock Plus–style list.
pub fn parse(text: &str, rules: &mut Rules) {
    let mut hide: HashSet<String> = rules.hide.iter().cloned().collect();
    let mut unhide: HashSet<String> = HashSet::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
            continue;
        }
        if let Some(i) = line.find("#@#") {
            if i == 0 {
                unhide.insert(line[3..].to_string());
            }
            continue;
        }
        if let Some(i) = line.find("##") {
            let (sites, sel) = (&line[..i], &line[i + 2..]);
            if !safe_selector(sel) {
                continue;
            }
            if sites.is_empty() {
                hide.insert(sel.to_string());
            } else {
                let sites: Vec<String> = sites.split(',').map(str::trim).map(str::to_ascii_lowercase).collect();
                if sites.iter().all(|s| valid_host(s)) {
                    rules.hide_on.push((sites, sel.to_string()));
                }
            }
            continue;
        }
        if line.contains("#?#") || line.contains("#$#") || line.contains("#%#") {
            continue;
        }
        let (exception, rest) = match line.strip_prefix("@@") { Some(r) => (true, r), None => (false, line) };
        let Some(rest) = rest.strip_prefix("||") else { continue };
        let (pattern, opts) = match rest.split_once('$') { Some((p, o)) => (p, Some(o)), None => (rest, None) };
        let Some((third_party, kinds)) = opts.map_or(Some((false, 0)), options) else { continue };
        let split = pattern.find(['^', '/']).unwrap_or(pattern.len());
        let host = pattern[..split].to_ascii_lowercase();
        let tail = &pattern[split..];
        if !valid_host(&host) {
            continue;
        }
        let path = match tail {
            "" | "^" | "^|" => None,
            t if t.starts_with('/') => match plain_path(t) { Some(p) => Some(p), None => continue },
            _ => continue,
        };
        let rule = NetRule { path, third_party, kinds };
        let into = if exception { &mut rules.allow } else { &mut rules.block };
        into.entry(host).or_default().push(rule);
    }
    rules.hide = hide.into_iter().filter(|s| !unhide.contains(s)).collect();
    rules.hide.sort();
    rules.hide.truncate(MAX_HIDING);
}

/// `host` and every parent domain of it ("a.b.example.com", "b.example.com", "example.com").
fn suffixes(host: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(host);
    std::iter::from_fn(move || {
        let current = rest?;
        rest = current.split_once('.').map(|(_, r)| r).filter(|r| r.contains('.'));
        Some(current)
    })
}

/// The site a host belongs to, roughly (the last two parts; "bbc.co.uk" counts as "co.uk").
fn site(host: &str) -> &str {
    let parts: Vec<&str> = host.rsplitn(3, '.').collect();
    if parts.len() < 3 { host } else { &host[parts[2].len() + 1..] }
}

/// Whether `path` (with its query) starts with a rule's path, `*` matching anything.
fn path_matches(rule: &str, path: &str) -> bool {
    let mut at = 0;
    for (i, piece) in rule.split('*').enumerate() {
        if i == 0 {
            if !path.starts_with(piece) {
                return false;
            }
            at = piece.len();
        } else {
            match path[at..].find(piece) {
                Some(found) => at += found + piece.len(),
                None => return false,
            }
        }
    }
    true
}

/// A request being checked.
pub struct Request<'a> {
    pub host: &'a str,
    /// The path and query, e.g. "/pagead/show?x=1".
    pub path: &'a str,
    pub page_host: &'a str,
    /// One `kind::*` bit, or 0 when not known.
    pub kind: u8,
}

fn matches(rule: &NetRule, request: &Request, third_party: bool) -> bool {
    (!rule.third_party || third_party)
        && (rule.kinds == 0 || request.kind == 0 || rule.kinds & request.kind != 0)
        && rule.path.as_deref().is_none_or(|p| path_matches(p, request.path))
}

impl Rules {
    /// Whether a request is refused.
    pub fn blocks_request(&self, request: &Request) -> bool {
        let host = request.host.to_ascii_lowercase();
        let third_party = site(&host) != site(&request.page_host.to_ascii_lowercase());
        let hit = |map: &HashMap<String, Vec<NetRule>>| suffixes(&host).any(|h| map.get(h).is_some_and(|rules| rules.iter().any(|r| matches(r, request, third_party))));
        hit(&self.block) && !hit(&self.allow)
    }

    /// Whether any request to `host` from a page on `page_host` is refused (for tests and checks).
    #[allow(dead_code)]
    pub fn blocks(&self, host: &str, page_host: &str) -> bool {
        self.blocks_request(&Request { host, path: "/", page_host, kind: 0 })
    }

    pub fn server_rules(&self) -> usize {
        self.block.values().map(Vec::len).sum()
    }

    /// The rules as a Safari content-blocker list (for WebKit on macOS). Kept under WebKit's limit.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn safari_list(&self, with_hiding: bool, allowed_sites: &[String]) -> String {
        fn regex_path(path: &str) -> String {
            path.chars().map(|c| match c {
                '*' => ".*".to_string(),
                '.' | '?' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' | '^' | '$' => format!("\\{c}"),
                c => c.to_string(),
            }).collect()
        }
        fn trigger(host: &str, rule: &NetRule) -> serde_json::Value {
            let host = host.replace('.', "\\.");
            let filter = match &rule.path {
                Some(path) => format!("^[htpsw]+://([a-z0-9-]+\\.)*{host}(:[0-9]+)?{}", regex_path(path)),
                None => format!("^[htpsw]+://([a-z0-9-]+\\.)*{host}[/:?]"),
            };
            let mut t = serde_json::json!({ "url-filter": filter });
            if rule.third_party {
                t["load-type"] = serde_json::json!(["third-party"]);
            }
            if rule.kinds != 0 {
                let names = [(kind::SCRIPT, "script"), (kind::IMAGE, "image"), (kind::STYLE, "style-sheet"), (kind::FETCH, "fetch"), (kind::FRAME, "document"), (kind::MEDIA, "media"), (kind::FONT, "font"), (kind::OTHER, "other")];
                let mut kinds: Vec<&str> = names.iter().filter(|(bit, _)| rule.kinds & bit != 0).map(|(_, n)| *n).collect();
                if rule.kinds & kind::FETCH != 0 {
                    kinds.push("raw");
                }
                t["resource-type"] = serde_json::json!(kinds);
            }
            t
        }
        const LIMIT: usize = 140_000;
        let mut out: Vec<serde_json::Value> = Vec::new();
        let mut hosts: Vec<(&String, &Vec<NetRule>)> = self.block.iter().collect();
        hosts.sort_by(|a, b| a.0.cmp(b.0));
        let mut allowed: Vec<(&String, &Vec<NetRule>)> = self.allow.iter().collect();
        allowed.sort_by(|a, b| a.0.cmp(b.0));
        let exceptions: usize = self.allow.values().map(Vec::len).sum();
        let hiding = if with_hiding { self.hide.len().div_ceil(200) + self.hide_on.len() } else { 0 };
        let room = LIMIT.saturating_sub(exceptions + hiding);
        'hosts: for (host, rules) in hosts {
            for rule in rules {
                if out.len() >= room {
                    break 'hosts;
                }
                out.push(serde_json::json!({ "trigger": trigger(host, rule), "action": { "type": "block" } }));
            }
        }
        if with_hiding {
            for chunk in self.hide.chunks(200) {
                out.push(serde_json::json!({ "trigger": { "url-filter": ".*" }, "action": { "type": "css-display-none", "selector": chunk.join(", ") } }));
            }
            for (sites, sel) in &self.hide_on {
                let domains: Vec<String> = sites.iter().map(|s| format!("*{s}")).collect();
                out.push(serde_json::json!({ "trigger": { "url-filter": ".*", "if-domain": domains }, "action": { "type": "css-display-none", "selector": sel } }));
            }
        }
        for (host, rules) in allowed {
            for rule in rules {
                out.push(serde_json::json!({ "trigger": trigger(host, rule), "action": { "type": "ignore-previous-rules" } }));
            }
        }
        // Sites the person allowed ads on: nothing on their pages is blocked or hidden.
        for site in allowed_sites {
            out.push(serde_json::json!({ "trigger": { "url-filter": ".*", "if-domain": [format!("*{site}")] }, "action": { "type": "ignore-previous-rules" } }));
        }
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    }
}

// ---- State: the lists on disk, the rules in memory ----

static RULES: Mutex<Option<Arc<Rules>>> = Mutex::new(None);
static ENABLED: Mutex<bool> = Mutex::new(true);
/// Sites the person allowed ads on (from the Browser and TV bars).
static ALLOWED_SITES: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn allowed_sites() -> Vec<String> {
    ALLOWED_SITES.lock().map(|a| a.clone()).unwrap_or_default()
}

/// Whether a page on `host` is on a site the person allowed ads on.
pub fn site_allowed(host: &str, sites: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    sites.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

/// The cleaned list of allowed sites ("www." dropped, hosts only).
pub fn clean_sites(sites: &[String]) -> Vec<String> {
    let mut out: Vec<String> = sites.iter().map(|s| s.trim().to_ascii_lowercase().trim_start_matches("www.").to_string()).filter(|s| valid_host(s)).collect();
    out.sort();
    out.dedup();
    out
}

impl Rules {
    /// A script that hides ad elements on the page it runs in (Windows, where WebView2 has no
    /// built-in hiding): the general rules and the page's site's own, unless ads are allowed there.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn hiding_script(&self, allowed_sites: &[String]) -> String {
        let css = |selectors: &[String]| selectors.chunks(200).map(|c| format!("{}{{display:none!important}}", c.join(","))).collect::<Vec<_>>().join("\n");
        let mut by_site: HashMap<&str, Vec<String>> = HashMap::new();
        for (sites, sel) in &self.hide_on {
            for site in sites {
                by_site.entry(site.as_str()).or_default().push(sel.clone());
            }
        }
        let by_site: HashMap<&str, String> = by_site.into_iter().map(|(k, v)| (k, css(&v))).collect();
        format!(
            r#"(function(){{if(window.__bdHide)return;window.__bdHide=1;var h=location.hostname.toLowerCase(),a={allowed},s={sites},css={general};
function on(d){{return h===d||h.slice(-d.length-1)==="."+d}}
for(var i=0;i<a.length;i++)if(on(a[i]))return;
for(var d in s)if(on(d))css+="\n"+s[d];
function add(){{var e=document.createElement("style");e.textContent=css;(document.head||document.documentElement).appendChild(e)}}
if(document.documentElement)add();else document.addEventListener("DOMContentLoaded",add)}})();"#,
            allowed = serde_json::to_string(allowed_sites).unwrap_or_else(|_| "[]".into()),
            sites = serde_json::to_string(&by_site).unwrap_or_else(|_| "{}".into()),
            general = serde_json::to_string(&css(&self.hide)).unwrap_or_else(|_| "\"\"".into()),
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// When the lists were last downloaded (ms since 1970), 0 if never.
    pub updated: u64,
    pub servers: usize,
    pub hiding: usize,
    pub error: Option<String>,
}

static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("adblock"))
}

pub fn rules() -> Option<Arc<Rules>> {
    if !enabled() {
        return None;
    }
    RULES.lock().ok().and_then(|r| r.clone())
}

pub fn enabled() -> bool {
    ENABLED.lock().map(|e| *e).unwrap_or(true)
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load(dir: &Path) -> Option<Rules> {
    let mut rules = Rules::default();
    let mut any = false;
    for (name, _) in LISTS {
        if let Ok(text) = fs::read_to_string(dir.join(format!("{name}.txt"))) {
            parse(&text, &mut rules);
            any = true;
        }
    }
    any.then_some(rules)
}

fn download(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).user_agent("BridgeDeck ad blocker").build().map_err(|e| e.to_string())?;
    for (name, urls) in LISTS {
        let mut got = Err(format!("Couldn't download {name}"));
        for url in urls {
            got = client.get(url).send().and_then(|r| r.error_for_status()).and_then(|r| r.text()).map_err(|e| format!("Couldn't download {name}: {e}"));
            if got.as_ref().is_ok_and(|t| t.starts_with("[Adblock") || t.contains("! Title:")) {
                break;
            }
        }
        let text = got?;
        if !text.starts_with("[Adblock") && !text.contains("! Title:") {
            return Err(format!("{name} didn't look like a block list"));
        }
        let part = dir.join(format!("{name}.part"));
        fs::write(&part, text).map_err(|e| e.to_string())?;
        fs::rename(&part, dir.join(format!("{name}.txt"))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Loads the lists (downloading them when missing or a few days old) and applies the rules to the
/// pages that are open. Runs in the background.
pub fn refresh(app: &AppHandle, force: bool) -> Result<(), String> {
    let dir = dir(app).ok_or("No app data folder")?;
    let updated = modified_ms(&dir.join("easylist.txt"));
    let age = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0).saturating_sub(updated);
    let mut result = Ok(());
    if force || updated == 0 || age > REFRESH.as_millis() as u64 {
        result = download(&dir);
    }
    if let Some(rules) = load(&dir) {
        if let Ok(mut stored) = RULES.lock() {
            *stored = Some(Arc::new(rules));
        }
        platform::rules_changed(app);
    }
    if let Ok(mut last) = LAST_ERROR.lock() {
        *last = result.as_ref().err().cloned();
    }
    result
}

pub fn init(app: &AppHandle, on: bool) {
    if let Ok(mut e) = ENABLED.lock() {
        *e = on;
    }
    let app = app.clone();
    std::thread::spawn(move || { let _ = refresh(&app, false); });
}

pub fn status(app: &AppHandle) -> Status {
    let stored = RULES.lock().ok().and_then(|r| r.clone());
    Status {
        enabled: enabled(),
        updated: dir(app).map(|d| modified_ms(&d.join("easylist.txt"))).unwrap_or(0),
        servers: stored.as_ref().map(|r| r.server_rules()).unwrap_or(0),
        hiding: stored.as_ref().map(|r| r.hide.len() + r.hide_on.len()).unwrap_or(0),
        error: LAST_ERROR.lock().ok().and_then(|e| e.clone()),
    }
}

/// Adds the blocker to a browser, TV or ChatGPT page once it exists.
pub fn attach(app: &AppHandle, label: &str) {
    platform::attach(app, label);
}

#[tauri::command]
pub fn adblock_status(app: AppHandle) -> Status {
    status(&app)
}

/// Set when the person changed something (on/off, an allowed site): the pages reload once the new
/// rules are in place, to show the change.
static RELOAD: Mutex<bool> = Mutex::new(false);

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn reload_if_asked(app: &AppHandle) {
    let asked = RELOAD.lock().map(|mut r| std::mem::take(&mut *r)).unwrap_or(false);
    if asked {
        for label in page_labels(app) {
            if let Some(view) = app.get_webview(&label) {
                let _ = view.eval("location.reload()");
            }
        }
    }
}

fn ask_reload() {
    if let Ok(mut r) = RELOAD.lock() {
        *r = true;
    }
}

/// Sets the sites ads are allowed on; pages reload to show the change.
#[tauri::command]
pub fn adblock_allow_sites(app: AppHandle, sites: Vec<String>) -> Status {
    let sites = clean_sites(&sites);
    let changed = ALLOWED_SITES.lock().map(|mut a| if *a != sites { *a = sites; true } else { false }).unwrap_or(false);
    if changed {
        ask_reload();
        platform::rules_changed(&app);
    }
    status(&app)
}

#[tauri::command]
pub fn adblock_set(app: AppHandle, enabled: bool) -> Status {
    let changed = ENABLED.lock().map(|mut e| if *e != enabled { *e = enabled; true } else { false }).unwrap_or(false);
    if changed {
        ask_reload();
        platform::rules_changed(&app);
    }
    status(&app)
}

#[tauri::command]
pub async fn adblock_update(app: AppHandle) -> Result<Status, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&worker, true)).await.map_err(|e| e.to_string())??;
    Ok(status(&app))
}

/// The labels of the pages the blocker applies to.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn page_labels(app: &AppHandle) -> Vec<String> {
    app.webviews().into_keys().filter(|l| l.starts_with("browser-") || l == "chatgpt").collect()
}

// ---- Windows: refuse requests to listed servers ----
#[cfg(windows)]
mod platform {
    use super::*;
    use webview2_com::{AddScriptToExecuteOnDocumentCreatedCompletedHandler, Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler};
    use windows::core::{Interface, HSTRING, PWSTR};

    fn take(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let s = unsafe { p.to_string() }.unwrap_or_default();
        unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _)) };
        s
    }

    fn host_of(url: &str) -> String {
        tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
    }

    /// WebView2's kind of request as a `kind::*` bit; `None` for pages themselves (a page or frame).
    fn kind_of(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> Option<u8> {
        Some(match context {
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => return None,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => kind::SCRIPT,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => kind::IMAGE,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => kind::STYLE,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => kind::FETCH,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => kind::MEDIA,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => kind::FONT,
            _ => kind::OTHER,
        })
    }

    static ATTACHED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    pub fn attach(app: &AppHandle, label: &str) {
        if ATTACHED.lock().map(|a| a.iter().any(|l| l == label)).unwrap_or(true) {
            return;
        }
        let Some(view) = app.get_webview(label) else { return };
        let label = label.to_string();
        let (app2, label2) = (app.clone(), label.clone());
        let _ = view.with_webview(move |page| unsafe {
            let Ok(webview) = page.controller().CoreWebView2() else { return };
            let env = page.environment();
            let filter = HSTRING::from("*");
            let added = match webview.cast::<ICoreWebView2_22>() {
                Ok(w) => w.AddWebResourceRequestedFilterWithRequestSourceKinds(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL),
                Err(_) => webview.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL),
            };
            if added.is_err() {
                return;
            }
            let handler = WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                let Some(rules) = super::rules() else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Request()?.Uri(&mut uri)?;
                let uri = take(uri);
                let mut source = PWSTR::null();
                sender.Source(&mut source)?;
                let page = take(source);
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                args.ResourceContext(&mut context)?;
                // A page (or frame) itself: frames count as frames; the page being opened isn't blocked.
                let kind = match kind_of(context) { Some(k) => k, None if uri == page => return Ok(()), None => kind::FRAME };
                let Ok(url) = tauri::Url::parse(&uri) else { return Ok(()) };
                let path = match url.query() { Some(q) => format!("{}?{q}", url.path()), None => url.path().to_string() };
                let page_host = host_of(&page);
                if super::site_allowed(&page_host, &super::allowed_sites()) {
                    return Ok(());
                }
                let request = Request { host: url.host_str().unwrap_or_default(), path: &path, page_host: &page_host, kind };
                if rules.blocks_request(&request) {
                    let response = env.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked"), &HSTRING::from(""))?;
                    args.SetResponse(&response)?;
                }
                Ok(())
            }));
            let mut token = Default::default();
            if webview.add_WebResourceRequested(&handler, &mut token).is_ok() {
                install_hiding(&app2, &label2);
                if let Ok(mut a) = ATTACHED.lock() {
                    a.push(label);
                }
            }
        });
    }

    /// The hiding script each page has (WebView2's id for it), so it can be replaced.
    static SCRIPTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

    /// Puts the current hiding script on a page (replacing the one before), or none when off.
    fn install_hiding(app: &AppHandle, label: &str) {
        let Some(view) = app.get_webview(label) else { return };
        let script = super::rules().map(|r| r.hiding_script(&super::allowed_sites()));
        let label = label.to_string();
        let _ = view.with_webview(move |page| unsafe {
            let Ok(webview) = page.controller().CoreWebView2() else { return };
            let old = SCRIPTS.lock().ok().and_then(|mut s| s.iter().position(|(l, _)| *l == label).map(|i| s.remove(i).1));
            if let Some(id) = old {
                let _ = webview.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id));
            }
            let Some(script) = script else { return };
            let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
                if result.is_ok() {
                    if let Ok(mut s) = SCRIPTS.lock() {
                        s.push((label, id));
                    }
                }
                Ok(())
            }));
            let _ = webview.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler);
        });
    }

    /// Requests are checked against the current rules every time, so only the hiding scripts need
    /// replacing (pages reload to show it).
    pub fn rules_changed(app: &AppHandle) {
        for label in super::page_labels(app) {
            install_hiding(app, &label);
        }
        super::reload_if_asked(app);
    }
}

// ---- macOS: WebKit applies the rules as a Safari content blocker ----
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSError, NSString};
    use sha2::Digest;
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};

    const IDENTIFIER: &str = "bridgedeck-adblock";

    /// The compiled list (lives on the main thread; WebKit objects aren't sent between threads).
    struct Compiled(Option<Retained<WKContentRuleList>>);
    unsafe impl Send for Compiled {}
    static COMPILED: Mutex<Compiled> = Mutex::new(Compiled(None));
    /// Pages that have the current list.
    static ATTACHED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// Puts the compiled list on a page, or takes it off when the blocker is off.
    unsafe fn apply(webview: &WKWebView) {
        let controller = webview.configuration().userContentController();
        controller.removeAllContentRuleLists();
        if super::enabled() {
            if let Some(list) = COMPILED.lock().ok().and_then(|c| c.0.clone()) {
                controller.addContentRuleList(&list);
            }
        }
    }

    pub fn attach(app: &AppHandle, label: &str) {
        let Some(view) = app.get_webview(label) else { return };
        let label = label.to_string();
        let _ = view.with_webview(move |page| unsafe {
            let webview: &WKWebView = &*(page.inner() as *const WKWebView);
            apply(webview);
            if let Ok(mut a) = ATTACHED.lock() {
                if !a.contains(&label) {
                    a.push(label);
                }
            }
        });
    }

    /// Which version of the rules is compiled (an identifier with a hash of the list).
    static COMPILED_ID: Mutex<String> = Mutex::new(String::new());

    fn reattach_all(app: &AppHandle) {
        for label in super::page_labels(app) {
            attach(app, &label);
        }
        super::reload_if_asked(app);
    }

    /// Gets WebKit's list for the current rules: the one compiled at an earlier launch when the
    /// rules haven't changed, else compiled now (in the background; WebKit calls back when done).
    /// Then applies it, or takes it off when the blocker is off, on every page.
    pub fn rules_changed(app: &AppHandle) {
        let Some(rules) = RULES.lock().ok().and_then(|r| r.clone()) else { return };
        let app = app.clone();
        std::thread::spawn(move || {
            let allowed = super::allowed_sites();
            let json = rules.safari_list(true, &allowed);
            let digest = sha2::Sha256::digest(json.as_bytes());
            let id = format!("{IDENTIFIER}-{}", digest.iter().take(6).map(|b| format!("{b:02x}")).collect::<String>());
            let current = COMPILED_ID.lock().map(|c| *c == id).unwrap_or(false);
            let main = app.clone();
            let _ = main.run_on_main_thread(move || unsafe {
                if current {
                    reattach_all(&app);
                } else {
                    load_or_compile(&app, id, json, rules);
                }
            });
        });
    }

    unsafe fn load_or_compile(app: &AppHandle, id: String, json: String, rules: Arc<Rules>) {
        let Some(mtm) = objc2::MainThreadMarker::new() else { return };
        let Some(store) = WKContentRuleListStore::defaultStore(mtm) else { return };
        // Lists from earlier versions of the rules are removed.
        let (keep, old_store) = (id.clone(), store.clone());
        let cleanup = RcBlock::new(move |ids: *mut NSArray<NSString>| {
            let Some(ids) = ids.as_ref() else { return };
            for old in ids.iter() {
                let old = old.to_string();
                if old.starts_with(IDENTIFIER) && old != keep {
                    old_store.removeContentRuleListForIdentifier_completionHandler(Some(&NSString::from_str(&old)), None);
                }
            }
        });
        store.getAvailableContentRuleListIdentifiers(Some(&cleanup));
        let app2 = app.clone();
        let id2 = id.clone();
        let found = RcBlock::new(move |list: *mut WKContentRuleList, _error: *mut NSError| {
            if list.is_null() {
                compile(&app2, &id2, &json, &rules, true);
                return;
            }
            store_compiled(&app2, &id2, list);
        });
        store.lookUpContentRuleListForIdentifier_completionHandler(Some(&NSString::from_str(&id)), Some(&found));
    }

    unsafe fn store_compiled(app: &AppHandle, id: &str, list: *mut WKContentRuleList) {
        if let Ok(mut c) = COMPILED.lock() {
            c.0 = Retained::retain(list);
        }
        if let Ok(mut c) = COMPILED_ID.lock() {
            *c = id.to_string();
        }
        reattach_all(app);
    }

    unsafe fn compile(app: &AppHandle, id: &str, json: &str, rules: &Arc<Rules>, with_hiding: bool) {
        let Some(mtm) = objc2::MainThreadMarker::new() else { return };
        let Some(store) = WKContentRuleListStore::defaultStore(mtm) else { return };
        let (app2, rules2, id2) = (app.clone(), rules.clone(), id.to_string());
        let done = RcBlock::new(move |list: *mut WKContentRuleList, _error: *mut NSError| {
            if list.is_null() {
                // A rule WebKit won't take: try again with blocking only.
                if with_hiding {
                    let json = rules2.safari_list(false, &super::allowed_sites());
                    compile(&app2, &id2, &json, &rules2, false);
                }
                return;
            }
            store_compiled(&app2, &id2, list);
        });
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(id)),
            Some(&NSString::from_str(json)),
            Some(&done),
        );
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    pub fn attach(_app: &AppHandle, _label: &str) {}
    pub fn rules_changed(_app: &AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "[Adblock Plus 2.0]\n! Title: EasyList\n||ads.example.com^\n||tracker.net^$third-party\n||bad.com^$script\n||site.com^$domain=x.com\n||pop.com^$popup\n@@||ok.ads.example.com^\n||cdn.com/path/ad.js\n##.ad-banner\n##div[id^=\"google_ads\"]\n##.x:has(.y)\nnews.com##.promo\n#@#.ad-banner\nexample.org#@#.foo\n";

    #[test]
    fn reads_server_and_hiding_rules() {
        let mut rules = Rules::default();
        parse(LIST, &mut rules);
        assert_eq!(rules.block["ads.example.com"], vec![NetRule { path: None, third_party: false, kinds: 0 }]);
        assert!(rules.block["tracker.net"][0].third_party);
        assert_eq!(rules.block["bad.com"][0].kinds, kind::SCRIPT);
        assert_eq!(rules.block["cdn.com"][0].path.as_deref(), Some("/path/ad.js"));
        assert!(!rules.block.contains_key("site.com"), "rules for some sites only aren't used");
        assert!(rules.allow.contains_key("ok.ads.example.com"));
        assert_eq!(rules.hide, vec!["div[id^=\"google_ads\"]".to_string()], "unhidden and :has() selectors are left out");
        assert_eq!(rules.hide_on, vec![(vec!["news.com".to_string()], ".promo".to_string())]);
    }

    #[test]
    fn blocks_listed_servers_and_their_subdomains() {
        let mut rules = Rules::default();
        parse(LIST, &mut rules);
        assert!(rules.blocks("ads.example.com", "news.com"));
        assert!(rules.blocks("x.ads.example.com", "news.com"));
        assert!(!rules.blocks("ok.ads.example.com", "news.com"), "exceptions win");
        assert!(!rules.blocks("example.com", "news.com"));
        assert!(rules.blocks("pixel.tracker.net", "news.com"), "third party");
        assert!(!rules.blocks("tracker.net", "www.tracker.net"), "first party is let through");
        let req = |host, path, kind| Request { host, path, page_host: "news.com", kind };
        assert!(rules.blocks_request(&req("bad.com", "/x.js", kind::SCRIPT)));
        assert!(!rules.blocks_request(&req("bad.com", "/x.png", kind::IMAGE)), "script-only rule");
        assert!(rules.blocks_request(&req("cdn.com", "/path/ad.js?v=2", kind::SCRIPT)));
        assert!(!rules.blocks_request(&req("cdn.com", "/path/app.js", kind::SCRIPT)), "other paths load");
        assert!(!rules.blocks("pop.com", "news.com"), "pop-up rules aren't used");
    }

    #[test]
    fn paths_with_wildcards() {
        assert!(path_matches("/ads/*/banner", "/ads/123/banner.gif"));
        assert!(!path_matches("/ads/*/banner", "/news/123/banner.gif"));
        assert!(path_matches("/pagead/", "/pagead/js/adsbygoogle.js"));
    }

    #[test]
    fn makes_a_safari_list() {
        let mut rules = Rules::default();
        parse(LIST, &mut rules);
        let list: Vec<serde_json::Value> = serde_json::from_str(&rules.safari_list(true, &[])).unwrap();
        assert_eq!(list[0]["trigger"]["url-filter"], "^[htpsw]+://([a-z0-9-]+\\.)*ads\\.example\\.com[/:?]");
        assert!(list.iter().any(|r| r["trigger"]["load-type"][0] == "third-party"));
        assert!(list.iter().any(|r| r["trigger"]["resource-type"][0] == "script"));
        assert!(list.iter().any(|r| r["trigger"]["url-filter"] == "^[htpsw]+://([a-z0-9-]+\\.)*cdn\\.com(:[0-9]+)?/path/ad\\.js"));
        assert_eq!(list.last().unwrap()["action"]["type"], "ignore-previous-rules");
        assert!(list.iter().any(|r| r["action"]["type"] == "css-display-none" && r["trigger"]["if-domain"][0] == "*news.com"));
        let allowing: Vec<serde_json::Value> = serde_json::from_str(&rules.safari_list(true, &["news.com".into()])).unwrap();
        assert_eq!(allowing.last().unwrap()["trigger"]["if-domain"][0], "*news.com");
        assert_eq!(allowing.last().unwrap()["action"]["type"], "ignore-previous-rules");
        let script = rules.hiding_script(&["ok.org".into()]);
        assert!(script.contains("display:none!important") && script.contains("\"ok.org\"") && script.contains(".promo"));
        assert!(site_allowed("www.news.com", &clean_sites(&["www.News.com".into()])) && !site_allowed("othernews.com", &["news.com".into()]));
        let no_hiding: Vec<serde_json::Value> = serde_json::from_str(&rules.safari_list(false, &[])).unwrap();
        assert!(no_hiding.iter().all(|r| r["action"]["type"] != "css-display-none"));
    }
}

#[cfg(test)]
mod real_lists {
    use super::*;
    /// `BD_LISTS=<folder with easylist.txt and easyprivacy.txt> cargo test real_lists -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_lists() {
        let dir = PathBuf::from(std::env::var("BD_LISTS").unwrap());
        let t = std::time::Instant::now();
        let rules = load(&dir).unwrap();
        let json = rules.safari_list(true, &[]);
        let n: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        println!("servers {} rules {} allow {} hide {} hide_on {} | safari rules {} ({} KB) in {:?}", rules.block.len(), rules.server_rules(), rules.allow.len(), rules.hide.len(), rules.hide_on.len(), n.len(), json.len() / 1024, t.elapsed());
        for (h, p) in [("ad.doubleclick.net", "cnn.com"), ("doubleclick.net", "cnn.com"), ("pagead2.googlesyndication.com", "cnn.com"), ("googlesyndication.com", "cnn.com"), ("www.google-analytics.com", "cnn.com"), ("www.youtube.com", "youtube.com"), ("i.ytimg.com", "youtube.com"), ("cdn.jsdelivr.net", "x.com"), ("fonts.googleapis.com", "x.com"), ("chatgpt.com", "chatgpt.com"), ("www.netflix.com", "netflix.com")] {
            println!("{h} on {p}: {}", if rules.blocks(h, p) { "BLOCKED" } else { "ok" });
        }
    }
}
