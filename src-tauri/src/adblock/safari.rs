//! The rules as Safari content-blocker lists, which WebKit applies itself on macOS.
//!
//! WebKit builds these lists inside BridgeDeck itself, and big lists of wildcard patterns can take
//! it gigabytes and bring the app down, so the lists are kept to what it builds comfortably:
//! server rules and plain address rules (wildcard address rules are left to the page script and
//! uBlock's scriptlets), in parts of 40,000, plus general and per-site hiding. A hiding list WebKit
//! refuses is tried again with only the simplest selectors. After a crash, `Mode::Basic` keeps
//! just the plain server rules.

// Used on macOS only.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use super::filters::{kind, simple_selector, NetRule, Party, Rules};
use serde_json::{json, Value};

/// Rules per list (WebKit's limit is 150,000; smaller lists build with far less memory).
const PER_LIST: usize = 40_000;

/// How much goes into the lists.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Everything WebKit builds comfortably, CSS hiding as written.
    Full,
    /// The same with only the simplest selectors (when WebKit refuses a hiding list).
    Simple,
    /// After WebKit crashed building the lists: plain server rules only, no hiding.
    Basic,
}
/// Selectors per hiding rule.
const PER_HIDE_RULE: usize = 150;

/// The `^` separator as WebKit understands it (no negated classes or alternation there).
const SEPARATOR: &str = "[/:?=&;,#]";

fn escape(c: char) -> String {
    if ".?+()[]{}|\\$".contains(c) { format!("\\{c}") } else { c.to_string() }
}

/// A rule's pattern as a WebKit regular expression part.
fn regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '*' => out.push_str(".*"),
            // A trailing separator is "a separator or the end": left out (slightly broader).
            '^' if i + 1 == chars.len() => {}
            '^' => out.push_str(SEPARATOR),
            c => out.push_str(&escape(c)),
        }
    }
    out
}

/// The trigger for a network rule (server rule when `host` is given), or none when WebKit can't
/// express it (pop-up-only rules, entity sites, non-ASCII).
fn trigger(host: Option<&str>, rule: &NetRule, mode: Mode) -> Option<Value> {
    // Wildcards make WebKit's matcher grow fast: those rules are left out.
    if !rule.pattern.is_ascii() || rule.pattern.contains('*') {
        return None;
    }
    if mode == Mode::Basic && (host.is_none() || !rule.pattern.is_empty() || rule.kinds != 0 || !rule.domains.is_empty() || !rule.not_domains.is_empty()) {
        return None;
    }
    if host.is_none() && rule.pattern.trim_matches('^').len() < 6 {
        return None;
    }
    let filter = match host {
        Some(host) => {
            let host = host.replace('.', "\\.");
            let tail = rule.pattern.strip_prefix('^').unwrap_or(&rule.pattern);
            let tail = if tail.is_empty() { "[/:?]".to_string() } else { format!("{}{}", if rule.pattern.starts_with('^') { SEPARATOR } else { "" }, regex(tail)) };
            format!("^[htpsw]+://([a-z0-9-]+\\.)*{host}{tail}{}", if rule.anchor_end { "$" } else { "" })
        }
        None => {
            let body = regex(&rule.pattern);
            if body.trim_matches(['.', '*']).is_empty() {
                return None;
            }
            format!("{}{body}{}", if rule.anchor_start { "^" } else { "" }, if rule.anchor_end { "$" } else { "" })
        }
    };
    let mut t = json!({ "url-filter": filter });
    match rule.party {
        Party::Third => t["load-type"] = json!(["third-party"]),
        Party::First => t["load-type"] = json!(["first-party"]),
        Party::Any => {}
    }
    let kinds = rule.kinds & !kind::POPUP;
    if rule.kinds != 0 && kinds == 0 {
        return None;
    }
    if kinds != 0 {
        let names = [(kind::SCRIPT, "script"), (kind::IMAGE, "image"), (kind::STYLE, "style-sheet"), (kind::FETCH, "fetch"), (kind::FRAME, "document"), (kind::DOCUMENT, "document"), (kind::MEDIA, "media"), (kind::FONT, "font"), (kind::OTHER, "other")];
        let mut types: Vec<&str> = names.iter().filter(|(bit, _)| kinds & bit != 0).map(|(_, n)| *n).collect();
        if kinds & kind::FETCH != 0 {
            types.push("raw");
        }
        types.dedup();
        t["resource-type"] = json!(types);
    }
    let sites = |list: &[String]| -> Vec<String> { list.iter().filter(|s| !s.ends_with(".*")).map(|s| format!("*{s}")).collect() };
    if !rule.domains.is_empty() {
        let yes = sites(&rule.domains);
        if yes.is_empty() {
            return None;
        }
        t["if-domain"] = json!(yes);
    } else if !rule.not_domains.is_empty() {
        let no = sites(&rule.not_domains);
        if !no.is_empty() {
            t["unless-domain"] = json!(no);
        }
    }
    Some(t)
}

fn ignore_for(sites: &[String]) -> Vec<Value> {
    sites.iter().map(|s| json!({ "trigger": { "url-filter": ".*", "if-domain": [format!("*{s}")] }, "action": { "type": "ignore-previous-rules" } })).collect()
}

/// A named content-blocker list.
pub struct List {
    pub name: String,
    pub json: String,
    /// A hiding list (tried again with simple selectors if WebKit refuses it).
    pub hiding: bool,
}

/// Every list for the rules. `allowed`: sites the person allowed ads on (nothing applies there).
/// `simple`: hiding lists with only the simplest selectors.
pub fn lists(rules: &Rules, allowed: &[String], mode: Mode) -> Vec<List> {
    let mut out = Vec::new();
    let blocks = |important: bool| -> Vec<Value> {
        let mut hosts: Vec<_> = rules.host_block.iter().collect();
        hosts.sort_by(|a, b| a.0.cmp(b.0));
        let by_host = hosts.into_iter().flat_map(|(h, list)| list.iter().map(move |r| (Some(h.as_str()), r)));
        let by_url = rules.url_block.iter().map(|r| (None, r));
        by_host.chain(by_url).filter(|(_, r)| r.important == important).filter_map(|(h, r)| trigger(h, r, mode)).map(|t| json!({ "trigger": t, "action": { "type": "block" } })).collect()
    };
    let mut exceptions: Vec<Value> = {
        let mut hosts: Vec<_> = rules.host_allow.iter().collect();
        hosts.sort_by(|a, b| a.0.cmp(b.0));
        let by_host = hosts.into_iter().flat_map(|(h, list)| list.iter().map(move |r| (Some(h.as_str()), r)));
        let by_url = rules.url_allow.iter().map(|r| (None, r));
        by_host.chain(by_url).filter_map(|(h, r)| trigger(h, r, mode)).map(|t| json!({ "trigger": t, "action": { "type": "ignore-previous-rules" } })).collect()
    };
    exceptions.extend(ignore_for(allowed));
    let room = PER_LIST.saturating_sub(exceptions.len()).max(10_000);
    for (i, part) in blocks(false).chunks(room).enumerate() {
        let mut list = part.to_vec();
        list.extend(exceptions.iter().cloned());
        out.push(List { name: format!("net{i}"), json: Value::Array(list).to_string(), hiding: false });
    }
    let important = blocks(true);
    if !important.is_empty() {
        let mut list = important;
        list.extend(ignore_for(allowed));
        out.push(List { name: "important".into(), json: Value::Array(list).to_string(), hiding: false });
    }

    if mode == Mode::Basic {
        return out;
    }
    // `:has()` only builds on recent WebKit; it's left out rather than risk the whole list.
    let usable = |s: &String| if mode == Mode::Simple { simple_selector(s) } else { !s.contains(":has(") };
    // General hiding: selectors some sites unhide get rules of their own that skip those sites.
    let mut unhidden_on: std::collections::HashMap<&str, Vec<String>> = std::collections::HashMap::new();
    for (site, selectors) in &rules.unhide_on {
        if site != "*" {
            for s in selectors {
                unhidden_on.entry(s.as_str()).or_default().push(format!("*{site}"));
            }
        }
    }
    let plain: Vec<&String> = rules.hide.iter().filter(|s| usable(s) && !unhidden_on.contains_key(s.as_str())).collect();
    let mut general: Vec<Value> = plain.chunks(PER_HIDE_RULE).map(|c| {
        let selector = c.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        json!({ "trigger": { "url-filter": ".*" }, "action": { "type": "css-display-none", "selector": selector } })
    }).collect();
    for s in rules.hide.iter().filter(|s| usable(s)) {
        if let Some(sites) = unhidden_on.get(s.as_str()) {
            general.push(json!({ "trigger": { "url-filter": ".*", "unless-domain": sites }, "action": { "type": "css-display-none", "selector": s } }));
        }
    }
    if !general.is_empty() {
        general.extend(ignore_for(&rules.no_generic_hide));
        general.extend(ignore_for(allowed));
        out.push(List { name: "hide".into(), json: Value::Array(general).to_string(), hiding: true });
    }
    let specific: Vec<Value> = rules.hide_on.iter().filter(|h| usable(&h.value)).filter_map(|h| {
        let yes: Vec<String> = h.sites.iter().filter(|s| !s.ends_with(".*")).map(|s| format!("*{s}")).collect();
        (!yes.is_empty()).then(|| json!({ "trigger": { "url-filter": ".*", "if-domain": yes }, "action": { "type": "css-display-none", "selector": h.value } }))
    }).collect();
    for (i, part) in specific.chunks(PER_LIST).enumerate() {
        let mut list = part.to_vec();
        list.extend(ignore_for(&rules.no_hide));
        list.extend(ignore_for(allowed));
        out.push(List { name: format!("site{i}"), json: Value::Array(list).to_string(), hiding: true });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::filters::{tests::LIST, Rules};
    use super::*;

    #[test]
    fn makes_safari_lists() {
        let mut rules = Rules::default();
        rules.add_list(LIST);
        let lists = lists(&rules, &["news.com".into()], Mode::Full);
        let names: Vec<&str> = lists.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["net0", "important", "hide", "site0"]);
        let net: Vec<Value> = serde_json::from_str(&lists[0].json).unwrap();
        let filters: Vec<&str> = net.iter().filter_map(|r| r["trigger"]["url-filter"].as_str()).collect();
        assert!(filters.contains(&"^[htpsw]+://([a-z0-9-]+\\.)*ads\\.example\\.com[/:?]"));
        assert!(filters.contains(&"^[htpsw]+://([a-z0-9-]+\\.)*cdn\\.com/path/ad\\.js"));
        assert!(!filters.iter().any(|f| f.contains("banner/ads") || f.contains("track\\.")), "wildcard address rules stay out: {filters:?}");
        assert!(filters.iter().any(|f| f.contains("ad-300x250")), "plain address rules go in");
        assert!(!filters.iter().any(|f| f.contains("pop\\.com")), "pop-up rules are BridgeDeck's, not WebKit's");
        let site = net.iter().find(|r| r["trigger"]["url-filter"].as_str().unwrap().contains("site\\.com")).unwrap();
        assert_eq!(site["trigger"]["if-domain"][0], "*x.com");
        assert_eq!(net.last().unwrap()["trigger"]["if-domain"][0], "*news.com", "allowed sites last");
        assert!(net.iter().any(|r| r["action"]["type"] == "ignore-previous-rules" && r["trigger"]["url-filter"].as_str().unwrap().contains("ok\\.ads")));
        let hide: Vec<Value> = serde_json::from_str(&lists[2].json).unwrap();
        assert!(!hide[0]["action"]["selector"].as_str().unwrap().contains(":has("), "no :has() for WebKit");
        assert!(hide.iter().any(|r| r["trigger"]["unless-domain"][0] == "*news.com"));
        assert!(hide.iter().any(|r| r["trigger"]["if-domain"][0] == "*quiet.org" && r["action"]["type"] == "ignore-previous-rules"), "generichide");
        let simple = super::lists(&rules, &[], Mode::Simple);
        let hide: Vec<Value> = serde_json::from_str(&simple.iter().find(|l| l.name == "hide").unwrap().json).unwrap();
        assert!(!hide[0]["action"]["selector"].as_str().unwrap().contains(":has"));
        let basic = super::lists(&rules, &[], Mode::Basic);
        assert_eq!(basic.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["net0", "important"], "no hiding after a crash");
        let net: Vec<Value> = serde_json::from_str(&basic[0].json).unwrap();
        assert!(net.iter().filter(|r| r["action"]["type"] == "block").all(|r| r["trigger"].get("resource-type").is_none() && r["trigger"].get("if-domain").is_none()), "plain server rules only");
        assert_eq!(regex("^ad^x*"), format!("{SEPARATOR}ad{SEPARATOR}x.*"));
    }
}
