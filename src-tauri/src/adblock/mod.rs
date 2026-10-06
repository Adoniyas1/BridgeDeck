//! The ad and pop-up blocker for the Browser tab, the TV tab and the ChatGPT panel.
//!
//! Lists (downloaded and kept up to date here, never bundled): EasyList and EasyPrivacy,
//! uBlock Origin's own lists (ads, privacy, malware, quick fixes and their exceptions), Peter
//! Lowe's ad servers, and, unless turned off, cookie banners and other annoyances.
//!
//! - `filters`: reading the lists and checking requests, pop-ups and pages against them;
//! - `safari`: on macOS, the rules as content-blocker lists WebKit applies itself;
//! - `page`: the script each page gets: the pop-up guard, uBlock-style scriptlets (which beat
//!   YouTube's and many sites' ad and anti-ad-blocker code) and, on Windows, element hiding.
//!   Windows checks every request the page makes here; macOS leaves blocking to WebKit.
//!
//! Pages pick up their script when they're made, so a change the person makes (on/off, a site
//! allowed, the lists) bumps a generation number and the Browser remakes its pages (browser.rs).

// Request checking runs on Windows; WebKit does it itself on macOS.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod filters;
pub mod page;
pub mod safari;

pub use filters::{kind, Request, Rules};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager};

/// What a list is for (cookie banners and the like can be turned off).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    Ads,
    Annoyances,
}

pub struct List {
    pub name: &'static str,
    pub group: Group,
    /// Where to get it, in order of preference.
    pub urls: &'static [&'static str],
    /// A list that may not exist (uBlock's lists by year).
    pub optional: bool,
}

const UBO: &str = "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/";
const EASYLIST: &str = "https://raw.githubusercontent.com/easylist/easylist/gh-pages/";

macro_rules! list {
    ($name:expr, $group:ident, [$($url:expr),+]) => { List { name: $name, group: Group::$group, urls: &[$($url),+], optional: false } };
    ($name:expr, $group:ident, [$($url:expr),+], optional) => { List { name: $name, group: Group::$group, urls: &[$($url),+], optional: true } };
}

pub const LISTS: &[List] = &[
    list!("easylist", Ads, [concat!("https://raw.githubusercontent.com/easylist/easylist/gh-pages/", "easylist.txt"), "https://easylist.to/easylist/easylist.txt"]),
    list!("easyprivacy", Ads, [concat!("https://raw.githubusercontent.com/easylist/easylist/gh-pages/", "easyprivacy.txt"), "https://easylist.to/easylist/easyprivacy.txt"]),
    list!("ublock", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters.txt")]),
    list!("ublock-2020", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2020.txt")], optional),
    list!("ublock-2021", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2021.txt")], optional),
    list!("ublock-2022", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2022.txt")], optional),
    list!("ublock-2023", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2023.txt")], optional),
    list!("ublock-2024", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2024.txt")], optional),
    list!("ublock-2025", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2025.txt")], optional),
    list!("ublock-2026", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2026.txt")], optional),
    list!("ublock-2027", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/filters-2027.txt")], optional),
    list!("ublock-badware", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/badware.txt")]),
    list!("ublock-privacy", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/privacy.txt")]),
    list!("ublock-quick-fixes", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/quick-fixes.txt")]),
    list!("ublock-unbreak", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/unbreak.txt")]),
    list!("peter-lowe", Ads, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "thirdparties/pgl.yoyo.org/as/serverlist"), "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext"]),
    list!("ublock-cookies", Annoyances, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/annoyances-cookies.txt")]),
    list!("ublock-annoyances", Annoyances, [concat!("https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/", "filters/annoyances-others.txt")]),
    list!("fanboy-annoyances", Annoyances, [concat!("https://raw.githubusercontent.com/easylist/easylist/gh-pages/", "fanboy-annoyance.txt"), "https://easylist.to/easylist/fanboy-annoyance.txt"]),
];
const _: (&str, &str) = (UBO, EASYLIST);

/// Lists older than this are fetched again (they change daily; a few days is plenty).
const REFRESH: Duration = Duration::from_secs(4 * 24 * 3600);

// ---- Settings and rules in memory ----

static RULES: Mutex<Option<Arc<Rules>>> = Mutex::new(None);
static ENABLED: Mutex<bool> = Mutex::new(true);
static ANNOYANCES: Mutex<bool> = Mutex::new(true);
static POPUPS: Mutex<bool> = Mutex::new(true);
/// Sites the person allowed ads on, and sites allowed to open pop-ups.
static ALLOWED_SITES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static POPUP_SITES: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Bumped when a change needs pages remade with a new script.
static GENERATION: AtomicU64 = AtomicU64::new(1);

fn get<T: Clone>(m: &Mutex<T>, default: T) -> T {
    m.lock().map(|v| v.clone()).unwrap_or(default)
}

/// Sets a setting; true if it changed.
fn set<T: PartialEq>(m: &Mutex<T>, value: T) -> bool {
    m.lock().map(|mut v| if *v != value { *v = value; true } else { false }).unwrap_or(false)
}

pub fn enabled() -> bool {
    get(&ENABLED, true)
}

pub fn allowed_sites() -> Vec<String> {
    get(&ALLOWED_SITES, Vec::new())
}

pub fn rules() -> Option<Arc<Rules>> {
    if !enabled() {
        return None;
    }
    RULES.lock().ok().and_then(|r| r.clone())
}

/// The page-script generation pages were made with is compared with this.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Relaxed)
}

/// Pages need remaking with a new script: the Browser and TV tabs hear it and show their pages
/// again, which remakes them (browser.rs).
fn bump(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    let _ = tauri::Emitter::emit(app, "adblock-changed", generation());
}

/// Whether a page on `host` is on one of `sites` (or under one).
pub fn site_allowed(host: &str, sites: &[String]) -> bool {
    filters::on_site(&host.to_ascii_lowercase(), sites)
}

/// A cleaned list of sites ("www." dropped, hosts only).
pub fn clean_sites(sites: &[String]) -> Vec<String> {
    let mut out: Vec<String> = sites.iter().map(|s| s.trim().to_ascii_lowercase().trim_start_matches("www.").to_string()).filter(|s| filters::valid_host(s)).collect();
    out.sort();
    out.dedup();
    out
}

/// The script for a new page (`hiding`: with element hiding, for Windows); empty when there's
/// nothing to run.
pub fn page_script(hiding: bool) -> String {
    let rules = rules();
    page::script(rules.as_deref(), &allowed_sites(), false, hiding)
}

/// The pop-up guard every frame of a page gets, while pop-ups are blocked.
pub fn popup_guard() -> Option<&'static str> {
    get(&POPUPS, true).then_some(page::POPUP_GUARD)
}

/// Pop-up decisions for browser.rs.
#[derive(Debug, PartialEq, Eq)]
pub enum Popup {
    Allow,
    /// Blocked: an ad, or opened by a page's script without the person clicking a link to it.
    Block,
}

/// Whether a new window to `url`, opened by a page on `opener_host`, may open. `scripted`: the
/// page's script opened it, not a link the person clicked (the pop-up guard says so).
pub fn popup(url: &str, opener_host: &str, scripted: bool) -> Popup {
    if !get(&POPUPS, true) || site_allowed(opener_host, &get(&POPUP_SITES, Vec::new())) {
        return Popup::Allow;
    }
    let lower = url.to_ascii_lowercase();
    let host = tauri::Url::parse(&lower).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    if host.is_empty() {
        return Popup::Allow;
    }
    if let Some(rules) = rules() {
        if !site_allowed(opener_host, &allowed_sites()) && rules.blocks(&Request { url: &lower, host: &host, page_host: opener_host, kind: kind::POPUP }) {
            return Popup::Block;
        }
    }
    // A script opening another site's page: the usual ad pop-up (or pop-under).
    if scripted && filters::site(&host) != filters::site(&opener_host.to_ascii_lowercase()) {
        return Popup::Block;
    }
    Popup::Allow
}

// ---- The lists on disk ----

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// When the lists were last downloaded (ms since 1970), 0 if never.
    pub updated: u64,
    pub lists: usize,
    pub servers: usize,
    pub hiding: usize,
    pub scriptlets: usize,
    pub annoyances: bool,
    pub popups: bool,
    pub error: Option<String>,
}

static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("adblock"))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn wanted() -> impl Iterator<Item = &'static List> {
    let annoyances = get(&ANNOYANCES, true);
    LISTS.iter().filter(move |l| l.group == Group::Ads || annoyances)
}

fn load(dir: &Path) -> Option<(Rules, usize)> {
    let mut rules = Rules::default();
    let mut count = 0;
    for list in wanted() {
        if let Ok(text) = fs::read_to_string(dir.join(format!("{}.txt", list.name))) {
            rules.add_list(&text);
            count += 1;
        }
    }
    (count > 0).then_some((rules, count))
}

/// Whether downloaded text is a block list (not an error page).
fn looks_like_list(text: &str) -> bool {
    text.starts_with("[Adblock") || text.contains("! Title:") || text.contains("\n127.0.0.1 ") || text.contains("\n0.0.0.0 ")
}

/// Downloads the lists that are missing or old. A list that can't be fetched keeps its last copy;
/// the error is reported.
fn download(dir: &Path, force: bool) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).user_agent("BridgeDeck ad blocker").build().map_err(|e| e.to_string())?;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut errors = Vec::new();
    for list in wanted() {
        let path = dir.join(format!("{}.txt", list.name));
        let missing_marker = dir.join(format!("{}.missing", list.name));
        let fresh = |p: &Path| { let m = modified_ms(p); m > 0 && now.saturating_sub(m) < REFRESH.as_millis() as u64 };
        if !force && (fresh(&path) || fresh(&missing_marker)) {
            continue;
        }
        let mut got: Result<String, String> = Err(format!("Couldn't download {}", list.name));
        let mut not_found = false;
        for url in list.urls {
            got = client.get(*url).send().and_then(|r| {
                not_found = r.status() == reqwest::StatusCode::NOT_FOUND;
                r.error_for_status()
            }).and_then(|r| r.text()).map_err(|e| format!("Couldn't download {}: {e}", list.name));
            if got.as_ref().is_ok_and(|t| looks_like_list(t)) {
                break;
            }
        }
        match got {
            Ok(text) if looks_like_list(&text) => {
                let part = dir.join(format!("{}.part", list.name));
                fs::write(&part, text).and_then(|_| fs::rename(&part, &path)).map_err(|e| e.to_string())?;
                let _ = fs::remove_file(&missing_marker);
            }
            // uBlock's list for a year that hasn't started: checked again in a few days.
            _ if list.optional && not_found => {
                let _ = fs::write(&missing_marker, "");
            }
            Ok(_) => errors.push(format!("{} didn't look like a block list", list.name)),
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

static LIST_COUNT: Mutex<usize> = Mutex::new(0);

/// Loads the lists (downloading what's missing or a few days old) and applies the rules to the
/// pages that are open. Runs in the background.
pub fn refresh(app: &AppHandle, force: bool) -> Result<(), String> {
    let dir = dir(app).ok_or("No app data folder")?;
    let result = download(&dir, force);
    if let Some((rules, count)) = load(&dir) {
        if let Ok(mut stored) = RULES.lock() {
            *stored = Some(Arc::new(rules));
        }
        set(&LIST_COUNT, count);
        platform::rules_changed(app);
    }
    if let Ok(mut last) = LAST_ERROR.lock() {
        *last = result.as_ref().err().cloned();
    }
    result
}

pub fn init(app: &AppHandle, on: bool) {
    set(&ENABLED, on);
    let app = app.clone();
    std::thread::spawn(move || { let _ = refresh(&app, false); });
}

pub fn status(app: &AppHandle) -> Status {
    let stored = RULES.lock().ok().and_then(|r| r.clone());
    let updated = dir(app).map(|d| LISTS.iter().map(|l| modified_ms(&d.join(format!("{}.txt", l.name)))).max().unwrap_or(0)).unwrap_or(0);
    Status {
        enabled: enabled(),
        updated,
        lists: get(&LIST_COUNT, 0),
        servers: stored.as_ref().map(|r| r.network_rules()).unwrap_or(0),
        hiding: stored.as_ref().map(|r| r.hiding_rules()).unwrap_or(0),
        scriptlets: stored.as_ref().map(|r| r.scriptlets.iter().filter(|s| page::SUPPORTED.contains(&s.value.name.as_str())).count()).unwrap_or(0),
        annoyances: get(&ANNOYANCES, true),
        popups: get(&POPUPS, true),
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

/// Set when the person changed something: on macOS the pages reload once WebKit has the new lists.
static RELOAD: Mutex<bool> = Mutex::new(false);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn reload_if_asked(app: &AppHandle) {
    if std::mem::take(&mut *RELOAD.lock().unwrap_or_else(|e| e.into_inner())) {
        for label in page_labels(app) {
            if let Some(view) = app.get_webview(&label) {
                let _ = view.eval("location.reload()");
            }
        }
    }
}

/// A change the person made: pages are remade with the new script (browser.rs), and on macOS
/// reload again once WebKit has the new lists.
fn changed_by_person(app: &AppHandle) {
    bump(app);
    set(&RELOAD, true);
    platform::rules_changed(app);
}

/// Sets the sites ads are allowed on.
#[tauri::command]
pub fn adblock_allow_sites(app: AppHandle, sites: Vec<String>) -> Status {
    if set(&ALLOWED_SITES, clean_sites(&sites)) {
        changed_by_person(&app);
    }
    status(&app)
}

#[tauri::command]
pub fn adblock_set(app: AppHandle, enabled: bool) -> Status {
    if set(&ENABLED, enabled) {
        changed_by_person(&app);
    }
    status(&app)
}

/// The other settings: cookie banners and annoyances, pop-up blocking and the sites allowed to
/// open pop-ups.
#[tauri::command]
pub fn adblock_options(app: AppHandle, annoyances: bool, popups: bool, popup_sites: Vec<String>) -> Status {
    set(&POPUP_SITES, clean_sites(&popup_sites));
    if set(&POPUPS, popups) {
        bump(&app);
    }
    if set(&ANNOYANCES, annoyances) {
        let worker = app.clone();
        std::thread::spawn(move || {
            let _ = refresh(&worker, false);
            changed_by_person(&worker);
        });
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

// ---- Windows: each request a page makes is checked here ----
#[cfg(windows)]
mod platform {
    use super::*;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler};
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
        tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default()
    }

    /// WebView2's kind of request as a `kind::*` bit; `None` for pages and frames themselves.
    fn kind_of(context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> Option<u16> {
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
                // The page being opened counts as a page (only `document` rules block it); frames as frames.
                let kind = match kind_of(context) { Some(k) => k, None if uri == page => kind::DOCUMENT, None => kind::FRAME };
                let page_host = host_of(&page);
                if super::site_allowed(&page_host, &super::allowed_sites()) {
                    return Ok(());
                }
                let lower = uri.to_ascii_lowercase();
                let host = host_of(&lower);
                if host.is_empty() {
                    return Ok(());
                }
                if rules.blocks(&Request { url: &lower, host: &host, page_host: &page_host, kind }) {
                    let response = env.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked by BridgeDeck"), &HSTRING::from(""))?;
                    args.SetResponse(&response)?;
                }
                Ok(())
            }));
            let mut token = Default::default();
            if webview.add_WebResourceRequested(&handler, &mut token).is_ok() {
                if let Ok(mut a) = ATTACHED.lock() {
                    a.push(label);
                }
            }
        });
    }

    /// Requests are checked against the current rules each time, and pages get their script
    /// when they're made: nothing to redo here.
    pub fn rules_changed(_app: &AppHandle) {}
}

// ---- macOS: WebKit applies the rules as Safari content-blocker lists ----
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSError, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebView};
    use sha2::Digest;

    const PREFIX: &str = "bridgedeck-adblock";

    /// The compiled lists (main thread only; WebKit objects aren't sent between threads).
    struct Compiled(Vec<Retained<WKContentRuleList>>);
    unsafe impl Send for Compiled {}
    static COMPILED: Mutex<Compiled> = Mutex::new(Compiled(Vec::new()));
    /// The identifiers of the compiled lists, and a counter that makes older compiles give up.
    static COMPILED_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static ROUND: AtomicU64 = AtomicU64::new(0);

    /// Puts the compiled lists on a page, or takes them off when the blocker is off.
    unsafe fn apply(webview: &WKWebView) {
        let controller = webview.configuration().userContentController();
        controller.removeAllContentRuleLists();
        if super::enabled() {
            if let Ok(c) = COMPILED.lock() {
                for list in &c.0 {
                    controller.addContentRuleList(list);
                }
            }
        }
    }

    pub fn attach(app: &AppHandle, label: &str) {
        let Some(view) = app.get_webview(label) else { return };
        let _ = view.with_webview(move |page| unsafe {
            let webview: &WKWebView = &*(page.inner() as *const WKWebView);
            apply(webview);
        });
    }

    fn reattach_all(app: &AppHandle) {
        for label in super::page_labels(app) {
            attach(app, &label);
        }
        super::reload_if_asked(app);
    }

    struct Job {
        id: String,
        json: String,
        /// For hiding lists: the same list with simple selectors only, if WebKit refuses the first.
        fallback: Option<String>,
    }

    /// Gets WebKit's lists for the current rules: those compiled at an earlier launch when they
    /// haven't changed, else compiled now (in the background; WebKit calls back when done). Then
    /// puts them on every page.
    pub fn rules_changed(app: &AppHandle) {
        let Some(rules) = RULES.lock().ok().and_then(|r| r.clone()) else { return };
        let app = app.clone();
        std::thread::spawn(move || {
            let allowed = super::allowed_sites();
            let full = super::safari::lists(&rules, &allowed, false);
            let simple = super::safari::lists(&rules, &allowed, true);
            let jobs: Vec<Job> = full.into_iter().map(|l| {
                let digest = sha2::Sha256::digest(l.json.as_bytes());
                let id = format!("{PREFIX}-{}-{}", l.name, digest.iter().take(6).map(|b| format!("{b:02x}")).collect::<String>());
                let fallback = l.hiding.then(|| simple.iter().find(|s| s.name == l.name).map(|s| s.json.clone())).flatten();
                Job { id, json: l.json, fallback }
            }).collect();
            let ids: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
            let same = COMPILED_IDS.lock().map(|c| *c == ids).unwrap_or(false);
            let round = ROUND.fetch_add(1, Ordering::Relaxed) + 1;
            let main = app.clone();
            let _ = main.run_on_main_thread(move || unsafe {
                if same {
                    reattach_all(&app);
                } else {
                    load_or_compile(app, round, jobs);
                }
            });
        });
    }

    /// Results as they arrive: one slot per list.
    struct Pending {
        round: u64,
        ids: Vec<String>,
        lists: Vec<Option<Retained<WKContentRuleList>>>,
        left: usize,
    }
    unsafe impl Send for Pending {}
    static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

    unsafe fn load_or_compile(app: AppHandle, round: u64, jobs: Vec<Job>) {
        let Some(mtm) = objc2::MainThreadMarker::new() else { return };
        let Some(store) = WKContentRuleListStore::defaultStore(mtm) else { return };
        let ids: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
        // Lists from earlier versions of the rules are removed.
        let (keep, old_store) = (ids.clone(), store.clone());
        let cleanup = RcBlock::new(move |found: *mut NSArray<NSString>| {
            let Some(found) = found.as_ref() else { return };
            for old in found.iter() {
                let old = old.to_string();
                if old.starts_with(PREFIX) && !keep.contains(&old) {
                    old_store.removeContentRuleListForIdentifier_completionHandler(Some(&NSString::from_str(&old)), None);
                }
            }
        });
        store.getAvailableContentRuleListIdentifiers(Some(&cleanup));
        if let Ok(mut p) = PENDING.lock() {
            *p = Some(Pending { round, ids, lists: jobs.iter().map(|_| None).collect(), left: jobs.len() });
        }
        for (slot, job) in jobs.into_iter().enumerate() {
            let (app2, store2) = (app.clone(), store.clone());
            let id = NSString::from_str(&job.id);
            let found = RcBlock::new(move |list: *mut WKContentRuleList, _error: *mut NSError| {
                if list.is_null() {
                    compile(&app2, &store2, round, slot, &job.id, &job.json, job.fallback.clone());
                } else {
                    done(&app2, round, slot, list);
                }
            });
            store.lookUpContentRuleListForIdentifier_completionHandler(Some(&id), Some(&found));
        }
    }

    unsafe fn compile(app: &AppHandle, store: &Retained<WKContentRuleListStore>, round: u64, slot: usize, id: &str, json: &str, fallback: Option<String>) {
        let (app2, store2, id2) = (app.clone(), store.clone(), id.to_string());
        let finished = RcBlock::new(move |list: *mut WKContentRuleList, _error: *mut NSError| {
            if list.is_null() {
                // A rule WebKit won't take: a hiding list is tried with simple selectors; else left out.
                match fallback.clone() {
                    Some(simple) => compile(&app2, &store2, round, slot, &id2, &simple, None),
                    None => done(&app2, round, slot, std::ptr::null_mut()),
                }
                return;
            }
            done(&app2, round, slot, list);
        });
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(Some(&NSString::from_str(id)), Some(&NSString::from_str(json)), Some(&finished));
    }

    /// One list is ready (or left out). When all are, they go on the pages.
    unsafe fn done(app: &AppHandle, round: u64, slot: usize, list: *mut WKContentRuleList) {
        let finished = {
            let Ok(mut pending) = PENDING.lock() else { return };
            let Some(p) = pending.as_mut().filter(|p| p.round == round) else { return };
            if p.lists[slot].is_none() && p.left > 0 {
                p.lists[slot] = Retained::retain(list);
                p.left -= 1;
            }
            if p.left > 0 {
                return;
            }
            pending.take()
        };
        let Some(p) = finished else { return };
        if let Ok(mut c) = COMPILED.lock() {
            c.0 = p.lists.into_iter().flatten().collect();
        }
        if let Ok(mut c) = COMPILED_IDS.lock() {
            *c = p.ids;
        }
        reattach_all(app);
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

    #[test]
    fn pop_ups() {
        let mut rules = Rules::default();
        rules.add_list(filters::tests::LIST);
        *RULES.lock().unwrap() = Some(Arc::new(rules));
        set(&ENABLED, true);
        assert_eq!(popup("https://pop.com/x", "news.com", false), Popup::Block, "listed pop-up");
        assert_eq!(popup("https://ads.example.com/x", "news.com", false), Popup::Block, "ad server");
        assert_eq!(popup("https://other.org/", "news.com", true), Popup::Block, "a script opening another site");
        assert_eq!(popup("https://other.org/", "news.com", false), Popup::Allow, "a link the person clicked");
        assert_eq!(popup("https://help.news.com/", "www.news.com", true), Popup::Allow, "the same site");
        set(&POPUP_SITES, vec!["news.com".into()]);
        assert_eq!(popup("https://pop.com/x", "news.com", true), Popup::Allow, "pop-ups allowed on the site");
        set(&POPUP_SITES, vec![]);
        set(&POPUPS, false);
        assert_eq!(popup("https://other.org/", "news.com", true), Popup::Allow, "blocker off");
        set(&POPUPS, true);
        assert!(site_allowed("www.news.com", &clean_sites(&["www.News.com".into()])) && !site_allowed("othernews.com", &["news.com".into()]));
        assert!(LISTS.iter().all(|l| l.urls.iter().all(|u| u.starts_with("https://"))));
    }
}

#[cfg(test)]
mod real_lists {
    use super::*;
    /// `BD_LISTS=<folder with the lists as <name>.txt> cargo test real_lists -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_lists() {
        let dir = PathBuf::from(std::env::var("BD_LISTS").unwrap());
        let t = std::time::Instant::now();
        let (rules, count) = load(&dir).unwrap();
        println!("{count} lists in {:?}: network {} (hosts {}, addresses {}), allow {}, hide {} + {} on sites, scriptlets {} (supported {})", t.elapsed(), rules.network_rules(), rules.host_block.len(), rules.url_block.len(), rules.host_allow.len() + rules.url_allow.len(), rules.hide.len(), rules.hide_on.len(), rules.scriptlets.len(), rules.scriptlets.iter().filter(|s| page::SUPPORTED.contains(&s.value.name.as_str())).count());
        let t = std::time::Instant::now();
        let lists = safari::lists(&rules, &[], false);
        for l in &lists {
            let n: Vec<serde_json::Value> = serde_json::from_str(&l.json).unwrap();
            println!("safari {}: {} rules, {} KB", l.name, n.len(), l.json.len() / 1024);
        }
        println!("safari lists in {:?}", t.elapsed());
        let mac = page::script(Some(&rules), &[], true, false);
        let win = page::script(Some(&rules), &[], true, true);
        println!("page script: mac {} KB, windows {} KB", mac.len() / 1024, win.len() / 1024);
        if let Ok(out) = std::env::var("BD_SCRIPTS") {
            fs::write(format!("{out}/mac.js"), &mac).unwrap();
            fs::write(format!("{out}/win.js"), &win).unwrap();
        }
        let t = std::time::Instant::now();
        let checks = [
            ("https://ad.doubleclick.net/ddm/x", "cnn.com", kind::IMAGE),
            ("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "cnn.com", kind::SCRIPT),
            ("https://www.google-analytics.com/analytics.js", "cnn.com", kind::SCRIPT),
            ("https://www.youtube.com/watch?v=x", "youtube.com", kind::DOCUMENT),
            ("https://i.ytimg.com/vi/x/hq.jpg", "youtube.com", kind::IMAGE),
            ("https://www.youtube.com/api/stats/ads?x", "youtube.com", kind::FETCH),
            ("https://cdn.jsdelivr.net/npm/x", "x.com", kind::SCRIPT),
            ("https://fonts.googleapis.com/css", "x.com", kind::STYLE),
            ("https://chatgpt.com/backend-api/x", "chatgpt.com", kind::FETCH),
            ("https://www.netflix.com/browse", "netflix.com", kind::DOCUMENT),
            ("https://example.com/ads/banner.gif", "news.com", kind::IMAGE),
            ("https://s.amazon-adsystem.com/x", "imdb.com", kind::SCRIPT),
        ];
        for (url, page, kind) in checks {
            let host = url.split("://").nth(1).unwrap().split(['/', '?']).next().unwrap();
            println!("{url} on {page}: {}", if rules.blocks(&Request { url, host, page_host: page, kind }) { "BLOCKED" } else { "ok" });
        }
        for (url, page) in [("https://www.popads.net/x", "movies.example"), ("https://adsterra.com/x", "x.com"), ("https://www.wikipedia.org/", "x.com")] {
            let host = url.split("://").nth(1).unwrap().split(['/', '?']).next().unwrap();
            println!("pop-up {url}: {}", if rules.blocks(&Request { url, host, page_host: page, kind: kind::POPUP }) { "BLOCKED" } else { "ok" });
        }
        // An ordinary request (no rule matches): what every request on Windows costs.
        let t2 = std::time::Instant::now();
        for _ in 0..10_000 {
            rules.blocks(&Request { url: "https://cdn.example.org/assets/app/main-4f3a.js?v=12", host: "cdn.example.org", page_host: "example.org", kind: kind::SCRIPT });
        }
        println!("checks: {:?} total; 10k ordinary requests in {:?}", t.elapsed(), t2.elapsed());
    }
}
