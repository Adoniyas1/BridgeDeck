//! Block lists in Adblock Plus / uBlock Origin syntax: what's read from them and how a request,
//! a pop-up or a page is checked against them.
//!
//! Read:
//! - network rules: `||host^`, `||host/path`, `|https://…`, `/plain/path*` with `*` and `^`;
//!   options `third-party`/`1p`, request kinds (and `~kind`), `domain=`/`from=`, `important`,
//!   `popup`, `document`, `all`, `badfilter`; `@@` exceptions, including `generichide`;
//! - hosts-file lines (`0.0.0.0 ads.example.com`);
//! - element hiding: `##sel`, `site##sel`, `site#@#sel`, with standard CSS (`:not`, `:has`, …);
//! - scriptlets: `site##+js(name, args…)` and their `#@#+js` exceptions.
//!
//! Left out (they'd need more than a request check): regular-expression rules, redirects, header
//! and parameter rewriting, HTML filtering and uBlock's procedural selectors (`:has-text` and so on).

use std::collections::{HashMap, HashSet};

/// Kinds of request a rule can be limited to (none set = every kind of request a page makes).
pub mod kind {
    pub const SCRIPT: u16 = 1;
    pub const IMAGE: u16 = 2;
    pub const STYLE: u16 = 4;
    pub const FETCH: u16 = 8;
    pub const FRAME: u16 = 16;
    pub const MEDIA: u16 = 32;
    pub const FONT: u16 = 64;
    pub const OTHER: u16 = 128;
    /// The page itself (only rules that say `document` block a whole page).
    pub const DOCUMENT: u16 = 256;
    /// A new window (only rules that say `popup`, and plain server rules, block pop-ups).
    pub const POPUP: u16 = 512;
    pub const NETWORK: u16 = 255;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Party {
    Any,
    Third,
    First,
}

/// One network rule.
#[derive(Clone, Debug, PartialEq)]
pub struct NetRule {
    /// For server rules: what follows the server ("" = anything). For address rules: the whole
    /// pattern. Lowercase; `*` matches anything, `^` a separator or the end.
    pub pattern: String,
    /// Address rules: the pattern starts at the start of the address (`|`).
    pub anchor_start: bool,
    /// The pattern ends at the end of the address (`|`).
    pub anchor_end: bool,
    pub party: Party,
    /// `kind::*` bits; 0 = every network kind.
    pub kinds: u16,
    /// Only on pages of these sites…
    pub domains: Vec<String>,
    /// …and never on these.
    pub not_domains: Vec<String>,
    /// Wins over exceptions.
    pub important: bool,
}

/// A scriptlet call: its name (aliases resolved) and arguments.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Scriptlet {
    pub name: String,
    pub args: Vec<String>,
}

/// A rule limited to some sites: where it applies and where it doesn't.
#[derive(Clone, Debug, PartialEq)]
pub struct Sited<T> {
    pub sites: Vec<String>,
    pub not_sites: Vec<String>,
    pub value: T,
}

#[derive(Default, Debug)]
pub struct Rules {
    /// Server rules, by server: refused, and let through.
    pub host_block: HashMap<String, Vec<NetRule>>,
    pub host_allow: HashMap<String, Vec<NetRule>>,
    /// Address rules, found by a word they contain (`index`), or checked always (`loose`).
    pub url_block: Vec<NetRule>,
    pub url_allow: Vec<NetRule>,
    index_block: HashMap<String, Vec<u32>>,
    index_allow: HashMap<String, Vec<u32>>,
    loose_block: Vec<u32>,
    loose_allow: Vec<u32>,
    /// Elements hidden on every site, and on some sites.
    pub hide: Vec<String>,
    pub hide_on: Vec<Sited<String>>,
    /// `site#@#sel`: generic selectors not applied on these sites.
    pub unhide_on: HashMap<String, Vec<String>>,
    /// Sites where general hiding is off (`$generichide`, `$elemhide`).
    pub no_generic_hide: Vec<String>,
    /// Sites where all hiding is off (`$elemhide`).
    pub no_hide: Vec<String>,
    pub scriptlets: Vec<Sited<Scriptlet>>,
    /// `site#@#+js(…)`: scriptlets not run on a site (an empty name = none at all).
    pub scriptlet_exceptions: Vec<(String, String)>,
    /// Lines read, for the counts in Settings.
    pub lines: usize,
}

pub fn valid_host(host: &str) -> bool {
    host.len() <= 253 && host.contains('.') && !host.starts_with('.') && !host.ends_with('.') && !host.contains("..")
        && host.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_')
}

/// A site in a `domain=` list or before `##`: a host, or an entity like `google.*`.
fn valid_site(site: &str) -> bool {
    match site.strip_suffix(".*") {
        Some(entity) => !entity.is_empty() && entity.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'),
        None => valid_host(site) || site == "localhost",
    }
}

/// Splits `a.com,~b.com` (or `|`-separated) into the sites it's for and the ones it isn't.
fn site_list(text: &str, separator: char) -> Option<(Vec<String>, Vec<String>)> {
    let (mut yes, mut no) = (Vec::new(), Vec::new());
    for site in text.split(separator).map(str::trim).filter(|s| !s.is_empty()) {
        let (negated, site) = match site.strip_prefix('~') { Some(s) => (true, s), None => (false, site) };
        let site = site.to_ascii_lowercase();
        if !valid_site(&site) {
            return None;
        }
        if negated { no.push(site) } else { yes.push(site) }
    }
    Some((yes, no))
}

/// uBlock's procedural and style operators, which aren't CSS.
const NOT_CSS: &[&str] = &[
    ":has-text(", ":-abp-", ":contains(", ":matches-css", ":matches-attr(", ":matches-prop(", ":matches-path(", ":matches-media(",
    ":min-text-length(", ":upward(", ":xpath(", ":remove(", ":remove-attr(", ":remove-class(", ":style(", ":watch-attr(",
    ":others(", ":if(", ":if-not(", ":nth-ancestor(", ":shadow", "::", ":-webkit-", ":after", ":before",
];
/// CSS pseudo-classes both WebKit and Chromium hide with.
const CSS_PSEUDO: &[&str] = &[
    ":not(", ":has(", ":is(", ":where(", ":nth-child(", ":nth-last-child(", ":nth-of-type(", ":nth-last-of-type(",
    ":first-child", ":last-child", ":only-child", ":first-of-type", ":last-of-type", ":only-of-type", ":empty", ":root",
    ":checked", ":disabled", ":enabled", ":link", ":visited", ":hover", ":focus", ":target",
];

/// A selector the page's CSS engine will take: standard CSS, nothing procedural.
pub fn css_selector(sel: &str) -> bool {
    if sel.is_empty() || sel.len() > 1000 || sel.starts_with('^') || sel.starts_with('+') || sel.contains('{') || sel.contains('}') {
        return false;
    }
    if NOT_CSS.iter().any(|op| sel.contains(op)) {
        return false;
    }
    // Every pseudo-class has to be a known one.
    let mut rest = sel;
    while let Some(i) = rest.find(':') {
        let tail = &rest[i..];
        // A colon inside an attribute value (`[href^="https:"]`) isn't a pseudo-class.
        let before = &sel[..sel.len() - tail.len()];
        let in_attr = before.matches('[').count() > before.matches(']').count();
        if !in_attr && !CSS_PSEUDO.iter().any(|p| tail.starts_with(p)) {
            return false;
        }
        rest = &tail[1..];
    }
    let balanced = |o: char, c: char| sel.matches(o).count() == sel.matches(c).count();
    balanced('(', ')') && balanced('[', ']') && sel.matches('"').count() % 2 == 0
}

/// The strictest kind of selector (plain elements, classes, ids, attributes), which even old
/// WebKit versions take; used when a list with fuller CSS is refused.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn simple_selector(sel: &str) -> bool {
    !sel.is_empty() && sel.len() <= 200
        && !sel.contains(':') && !sel.contains(',') && !sel.contains('{') && !sel.contains('\\')
        && sel.chars().all(|c| c.is_ascii_alphanumeric() || " #.-_[]=\"'^$*~|>+()".contains(c))
        && sel.matches('[').count() == sel.matches(']').count()
        && sel.matches('"').count() % 2 == 0 && sel.matches('\'').count() % 2 == 0
}

/// uBlock's short names for scriptlets.
fn scriptlet_name(name: &str) -> &str {
    let name = name.trim().trim_end_matches(".js");
    match name {
        "set" | "set-constant" => "set-constant",
        "aopr" | "abort-on-property-read" => "abort-on-property-read",
        "aopw" | "abort-on-property-write" => "abort-on-property-write",
        "acs" | "abort-current-script" | "abort-current-inline-script" | "acis" => "abort-current-script",
        "aeld" | "addEventListener-defuser" | "prevent-addEventListener" => "prevent-addEventListener",
        "nostif" | "no-setTimeout-if" | "prevent-setTimeout" | "setTimeout-defuser" => "prevent-setTimeout",
        "nosiif" | "no-setInterval-if" | "prevent-setInterval" | "setInterval-defuser" => "prevent-setInterval",
        "nowoif" | "no-window-open-if" | "prevent-window-open" | "window.open-defuser" => "prevent-window-open",
        "no-fetch-if" | "prevent-fetch" => "prevent-fetch",
        "no-xhr-if" | "prevent-xhr" => "prevent-xhr",
        "ra" | "remove-attr" => "remove-attr",
        "rc" | "remove-class" => "remove-class",
        "rmnt" | "remove-node-text" => "remove-node-text",
        "nano-sib" | "nano-setInterval-booster" => "adjust-setInterval",
        "nano-stb" | "nano-setTimeout-booster" => "adjust-setTimeout",
        "noeval" => "noeval",
        "noeval-if" | "prevent-eval-if" => "noeval-if",
        "nobab" | "bab-defuser" => "nobab",
        "nofab" | "fuckadblock.js-3.2.0" => "nofab",
        "popads-dummy" => "popads-dummy",
        other => other,
    }
}

/// Splits `name, arg1, arg2` (commas in arguments are written `\,`; arguments may be quoted).
pub fn scriptlet_args(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    // Inside a quoted argument (its quote character): commas are part of it.
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&',') => {
                current.push(',');
                chars.next();
            }
            '"' | '\'' if quote.is_none() && current.trim().is_empty() => {
                quote = Some(c);
                current.push(c);
            }
            c if Some(c) == quote => {
                quote = None;
                current.push(c);
            }
            ',' if quote.is_none() => out.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    out.push(current);
    out.into_iter()
        .map(|a| {
            let a = a.trim();
            let quoted = a.len() >= 2 && ((a.starts_with('"') && a.ends_with('"')) || (a.starts_with('\'') && a.ends_with('\'')));
            if quoted { a[1..a.len() - 1].to_string() } else { a.to_string() }
        })
        .collect()
}

#[derive(Default)]
struct Options {
    party: Option<Party>,
    kinds: u16,
    not_kinds: u16,
    domains: Vec<String>,
    not_domains: Vec<String>,
    important: bool,
    badfilter: bool,
    /// `generichide`, `elemhide`… on an exception: (no generic hiding, no hiding at all).
    hide_off: (bool, bool),
}

/// The options after `$`, if every one is understood (unknown ones mean the rule isn't used).
fn options(text: &str) -> Option<Options> {
    let mut o = Options::default();
    for option in text.split(',').map(str::trim) {
        let (negated, name) = match option.strip_prefix('~') { Some(n) => (true, n), None => (false, option) };
        let bit = match name {
            "script" => kind::SCRIPT,
            "image" => kind::IMAGE,
            "stylesheet" | "css" => kind::STYLE,
            "xmlhttprequest" | "xhr" | "ping" | "websocket" | "beacon" => kind::FETCH,
            "subdocument" | "frame" => kind::FRAME,
            "media" => kind::MEDIA,
            "font" => kind::FONT,
            "object" | "other" | "object-subrequest" => kind::OTHER,
            "document" | "doc" => kind::DOCUMENT,
            "popup" | "popunder" => kind::POPUP,
            "all" => kind::NETWORK | kind::DOCUMENT | kind::POPUP,
            _ => 0,
        };
        if bit != 0 {
            if negated { o.not_kinds |= bit } else { o.kinds |= bit }
            continue;
        }
        match name {
            "third-party" | "3p" | "strict3p" => o.party = Some(if negated { Party::First } else { Party::Third }),
            "first-party" | "1p" | "strict1p" => o.party = Some(if negated { Party::Third } else { Party::First }),
            "important" => o.important = true,
            "badfilter" => o.badfilter = true,
            "match-case" | "_" | "__" | "___" => {}
            "generichide" | "ghide" | "specifichide" | "shide" => o.hide_off.0 = true,
            "elemhide" | "ehide" => o.hide_off = (true, true),
            _ => {
                let (key, value) = name.split_once('=')?;
                match key {
                    "domain" | "from" => {
                        let (yes, no) = site_list(value, '|')?;
                        o.domains = yes;
                        o.not_domains = no;
                    }
                    _ => return None,
                }
            }
        }
    }
    Some(o)
}

/// Characters that make up a word in an address (for finding address rules quickly).
fn word_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'%'
}

/// Words common to nearly every address, useless for finding rules.
const COMMON: &[&str] = &["http", "https", "www", "com", "js", "html", "net", "org", "php"];

/// The best word to find an address rule by: the longest whole word in it (bounded by separators
/// or anchors, not by `*`), or none.
fn best_word(rule: &NetRule) -> Option<String> {
    let p = rule.pattern.as_bytes();
    let mut best: Option<&[u8]> = None;
    let mut i = 0;
    while i < p.len() {
        if !word_char(p[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < p.len() && word_char(p[i]) {
            i += 1;
        }
        let left_ok = if start == 0 { rule.anchor_start } else { p[start - 1] != b'*' };
        let right_ok = if i == p.len() { rule.anchor_end } else { p[i] != b'*' };
        let word = &p[start..i];
        if left_ok && right_ok && word.len() >= 2 && best.is_none_or(|b| word.len() > b.len()) && !COMMON.contains(&std::str::from_utf8(word).unwrap_or("")) {
            best = Some(word);
        }
    }
    best.map(|w| String::from_utf8_lossy(w).into_owned())
}

/// Whether `pattern` matches `text`: `*` any run, `^` one separator character or the end.
/// `start`/`end`: the match must begin/finish at the text's start/end.
pub fn glob(pattern: &str, text: &str, start: bool, end: bool) -> bool {
    // Quick no: the pattern's longest literal piece isn't in the address.
    let longest = pattern.split(['*', '^']).max_by_key(|p| p.len()).unwrap_or("");
    if !longest.is_empty() && !text.contains(longest) {
        return false;
    }
    // Matching anywhere is matching from the start after a `*`.
    let owned;
    let p = if start { pattern.as_bytes() } else { owned = format!("*{pattern}"); owned.as_bytes() };
    let t = text.as_bytes();
    let separator = |c: u8| !(c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'%'));
    let (mut pi, mut ti) = (0usize, 0usize);
    // Where to retry from after a `*`: (pattern position after it, text position).
    let mut star: Option<(usize, usize)> = None;
    loop {
        if pi == p.len() {
            if !end || ti == t.len() {
                return true;
            }
        } else if p[pi] == b'*' {
            star = Some((pi, ti));
            pi += 1;
            continue;
        } else if ti < t.len() && (p[pi] == t[ti] || (p[pi] == b'^' && separator(t[ti]))) {
            pi += 1;
            ti += 1;
            continue;
        } else if ti == t.len() && p[pi] == b'^' {
            // `^` also matches the end of the address.
            pi += 1;
            continue;
        }
        match star {
            Some((sp, st)) if st < t.len() => {
                pi = sp + 1;
                ti = st + 1;
                star = Some((sp, st + 1));
            }
            _ => return false,
        }
    }
}

/// `host` and every parent domain of it ("a.b.example.com", "b.example.com", "example.com").
pub fn suffixes(host: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(host);
    std::iter::from_fn(move || {
        let current = rest?;
        rest = current.split_once('.').map(|(_, r)| r).filter(|r| r.contains('.'));
        Some(current)
    })
}

/// Second-level names under which sites register ("bbc.co.uk" is a site, "co.uk" isn't).
const SECOND_LEVEL: &[&str] = &["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "ltd", "plc", "sch"];

/// The site a host belongs to: its registered name ("news.bbc.co.uk" → "bbc.co.uk").
pub fn site(host: &str) -> &str {
    let labels: Vec<&str> = host.rsplit('.').collect();
    let keep = if labels.len() >= 3 && labels[0].len() == 2 && SECOND_LEVEL.contains(&labels[1]) { 3 } else { 2 };
    if labels.len() <= keep {
        return host;
    }
    let cut: usize = labels[..keep].iter().map(|l| l.len() + 1).sum::<usize>() - 1;
    &host[host.len() - cut..]
}

/// Whether `host` is one of `sites` or under one (an entity `google.*` matches any ending).
pub fn on_site(host: &str, sites: &[String]) -> bool {
    sites.iter().any(|s| match s.strip_suffix(".*") {
        Some(entity) => {
            let registered = site(host);
            let name = registered.split('.').next().unwrap_or("");
            let before = &host[..host.len() - registered.len()];
            let label_name = format!("{before}{name}");
            label_name == entity || label_name.ends_with(&format!(".{entity}"))
        }
        None => host == s || (host.len() > s.len() && host.ends_with(s.as_str()) && host.as_bytes()[host.len() - s.len() - 1] == b'.'),
    })
}

/// A request, pop-up or page being checked.
pub struct Request<'a> {
    /// The whole address, lowercase.
    pub url: &'a str,
    pub host: &'a str,
    /// The page it's for (the opener, for a pop-up).
    pub page_host: &'a str,
    /// One `kind::*` bit, or 0 when not known.
    pub kind: u16,
}

impl NetRule {
    fn applies(&self, request: &Request, third_party: bool) -> bool {
        let party_ok = match self.party {
            Party::Any => true,
            Party::Third => third_party,
            Party::First => !third_party,
        };
        let kind_ok = match request.kind {
            0 => self.kinds == 0 || self.kinds & kind::NETWORK != 0,
            kind::POPUP | kind::DOCUMENT => self.kinds & request.kind != 0,
            k => self.kinds == 0 || self.kinds & k != 0,
        };
        party_ok && kind_ok
            && (self.domains.is_empty() || on_site(request.page_host, &self.domains))
            && (self.not_domains.is_empty() || !on_site(request.page_host, &self.not_domains))
    }
}

/// Words of an address, for finding address rules.
fn words(url: &str) -> HashSet<&str> {
    url.split(|c: char| !(c.is_ascii_alphanumeric() || c == '%')).filter(|w| w.len() >= 2).collect()
}

impl Rules {
    /// Reads one list into the rules. `badfilter` rules from it remove the rules they name.
    pub fn add_list(&mut self, text: &str) {
        let mut bad: HashSet<String> = HashSet::new();
        for line in text.lines() {
            let line = line.trim();
            if let Some(i) = line.rfind("$") {
                let opts = &line[i + 1..];
                if opts.split(',').any(|o| o == "badfilter") {
                    let rest: Vec<&str> = opts.split(',').filter(|o| *o != "badfilter").collect();
                    bad.insert(if rest.is_empty() { line[..i].to_string() } else { format!("{}${}", &line[..i], rest.join(",")) });
                }
            }
        }
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('!') || line.starts_with('[') || (line.starts_with('#') && !line.starts_with("##") && !line.starts_with("#@#")) || bad.contains(line) {
                continue;
            }
            self.lines += 1;
            self.add_line(line);
        }
        self.finish();
    }

    fn add_line(&mut self, line: &str) {
        // Hosts-file lines.
        for prefix in ["0.0.0.0 ", "127.0.0.1 ", "::1 ", "::"] {
            if let Some(host) = line.strip_prefix(prefix) {
                let host = host.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if valid_host(&host) && host != "localhost" {
                    self.host_block.entry(host).or_default().push(NetRule { pattern: String::new(), anchor_start: false, anchor_end: false, party: Party::Any, kinds: 0, domains: vec![], not_domains: vec![], important: false });
                }
                return;
            }
        }
        if let Some(i) = line.find("#@#") {
            let (sites, what) = (&line[..i], &line[i + 3..]);
            let Some((yes, _)) = site_list(sites, ',') else { return };
            if let Some(js) = what.strip_prefix("+js(").and_then(|s| s.strip_suffix(')')) {
                let name = scriptlet_args(js).into_iter().next().map(|n| scriptlet_name(&n).to_string()).unwrap_or_default();
                let sites = if yes.is_empty() { vec!["*".to_string()] } else { yes };
                for site in sites {
                    self.scriptlet_exceptions.push((site, name.clone()));
                }
            } else if css_selector(what) {
                if yes.is_empty() {
                    self.unhide_on.entry("*".into()).or_default().push(what.to_string());
                }
                for site in yes {
                    self.unhide_on.entry(site).or_default().push(what.to_string());
                }
            }
            return;
        }
        if let Some(i) = line.find("##") {
            let (sites, what) = (&line[..i], &line[i + 2..]);
            let Some((yes, no)) = site_list(sites, ',') else { return };
            if let Some(js) = what.strip_prefix("+js(").and_then(|s| s.strip_suffix(')')) {
                let mut args = scriptlet_args(js);
                if args.is_empty() || args[0].is_empty() {
                    return;
                }
                let name = scriptlet_name(&args.remove(0)).to_string();
                self.scriptlets.push(Sited { sites: yes, not_sites: no, value: Scriptlet { name, args } });
            } else if css_selector(what) {
                if yes.is_empty() && no.is_empty() {
                    self.hide.push(what.to_string());
                } else if !yes.is_empty() {
                    self.hide_on.push(Sited { sites: yes, not_sites: no, value: what.to_string() });
                } else {
                    // `~site##sel`: hidden everywhere but there.
                    self.hide.push(what.to_string());
                    for site in no {
                        self.unhide_on.entry(site).or_default().push(what.to_string());
                    }
                }
            }
            return;
        }
        if line.contains("#?#") || line.contains("#$#") || line.contains("#%#") || line.contains("$$") {
            return;
        }
        let (exception, rest) = match line.strip_prefix("@@") { Some(r) => (true, r), None => (false, line) };
        // Regular expressions aren't used.
        if rest.starts_with('/') && rest.len() > 2 && rest[1..].contains('/') && (rest.ends_with('/') || rest.contains("/$")) {
            return;
        }
        let (pattern, opts) = match rest.rfind('$') {
            Some(i) if !rest[i + 1..].is_empty() && !rest[i + 1..].contains('/') => (&rest[..i], options(&rest[i + 1..])),
            _ => (rest, Some(Options::default())),
        };
        let Some(o) = opts else { return };
        if o.badfilter {
            return;
        }
        if o.hide_off != (false, false) {
            // `@@||site^$generichide`: hiding is off there.
            if exception {
                if let Some(host) = pattern.strip_prefix("||").map(|p| p.trim_end_matches(['^', '/', '|']).to_ascii_lowercase()) {
                    if valid_host(&host) {
                        self.no_generic_hide.push(host.clone());
                        if o.hide_off.1 {
                            self.no_hide.push(host);
                        }
                    }
                }
            }
            if o.kinds == 0 && o.not_kinds == 0 {
                return;
            }
        }
        let mut kinds = o.kinds;
        if o.not_kinds != 0 {
            kinds = (if kinds == 0 { kind::NETWORK } else { kinds }) & !o.not_kinds;
            if kinds == 0 {
                return;
            }
        }
        let pattern = pattern.to_ascii_lowercase();
        if !pattern.is_ascii() || pattern.is_empty() || pattern == "*" || pattern == "|" {
            return;
        }
        let base = NetRule { pattern: String::new(), anchor_start: false, anchor_end: false, party: o.party.unwrap_or(Party::Any), kinds, domains: o.domains, not_domains: o.not_domains, important: o.important && !exception };
        if let Some(rest) = pattern.strip_prefix("||") {
            let split = rest.find(['^', '/', '*', '|', ':', '?']).unwrap_or(rest.len());
            let host = &rest[..split];
            if !valid_host(host) {
                return;
            }
            let mut tail = &rest[split..];
            let anchor_end = tail.ends_with('|');
            tail = tail.trim_end_matches('|');
            let tail = match tail {
                "" | "^" => "",
                t => t,
            };
            let rule = NetRule { pattern: tail.to_string(), anchor_end, ..base };
            let into = if exception { &mut self.host_allow } else { &mut self.host_block };
            into.entry(host.to_string()).or_default().push(rule);
            return;
        }
        let anchor_start = pattern.starts_with('|');
        let anchor_end = pattern.ends_with('|') && pattern.len() > 1;
        let body = pattern.trim_start_matches('|').trim_end_matches('|').to_string();
        // Too short to be safe ("ad" would match half the web).
        if body.trim_matches(['*', '^']).len() < 4 && !anchor_start {
            return;
        }
        let rule = NetRule { pattern: body, anchor_start, anchor_end, ..base };
        if exception { self.url_allow.push(rule) } else { self.url_block.push(rule) }
    }

    /// Builds the word indexes and tidies the hiding rules (call after the last list).
    pub fn finish(&mut self) {
        fn index(rules: &[NetRule]) -> (HashMap<String, Vec<u32>>, Vec<u32>) {
            let mut map: HashMap<String, Vec<u32>> = HashMap::new();
            let mut loose = Vec::new();
            for (i, rule) in rules.iter().enumerate() {
                match best_word(rule) {
                    Some(word) => map.entry(word).or_default().push(i as u32),
                    None => loose.push(i as u32),
                }
            }
            (map, loose)
        }
        (self.index_block, self.loose_block) = index(&self.url_block);
        (self.index_allow, self.loose_allow) = index(&self.url_allow);
        let unhidden: HashSet<String> = self.unhide_on.get("*").cloned().unwrap_or_default().into_iter().collect();
        let mut seen = HashSet::new();
        self.hide.retain(|s| !unhidden.contains(s) && seen.insert(s.clone()));
        self.hide.sort();
    }

    fn matching<'r>(&'r self, request: &Request, allow: bool) -> Vec<&'r NetRule> {
        let third_party = site(request.host) != site(request.page_host);
        let (hosts, list, index, loose) = if allow {
            (&self.host_allow, &self.url_allow, &self.index_allow, &self.loose_allow)
        } else {
            (&self.host_block, &self.url_block, &self.index_block, &self.loose_block)
        };
        let host = request.host;
        // What follows the host in the address ("/path?q", ":8080/…").
        let after_host = request.url.find(host).map(|i| &request.url[i + host.len()..]).unwrap_or("");
        let by_host = suffixes(host).flat_map(move |h| hosts.get(h).into_iter().flatten()).filter(move |r| r.pattern.is_empty() || glob(&r.pattern, after_host, true, r.anchor_end));
        let mut candidates: Vec<u32> = loose.clone();
        for word in words(request.url) {
            if let Some(found) = index.get(word) {
                candidates.extend_from_slice(found);
            }
        }
        let by_url = candidates.into_iter().map(move |i| &list[i as usize]).filter(move |r| glob(&r.pattern, request.url, r.anchor_start, r.anchor_end));
        by_host.chain(by_url).filter(|r| r.applies(request, third_party)).collect()
    }

    /// Whether a request (or pop-up, or page, by its kind) is refused.
    pub fn blocks(&self, request: &Request) -> bool {
        let mut blocked = false;
        for rule in self.matching(request, false) {
            if rule.important {
                return true;
            }
            blocked = true;
        }
        if !blocked {
            // Pop-ups to ad servers: plain server rules count too.
            if request.kind == kind::POPUP {
                let third_party = site(request.host) != site(request.page_host);
                let plain = suffixes(request.host).any(|h| self.host_block.get(h).is_some_and(|rules| rules.iter().any(|r| r.kinds == 0 && r.pattern.is_empty() && r.domains.is_empty() && (r.party != Party::First || !third_party))));
                if !plain {
                    return false;
                }
            } else {
                return false;
            }
        }
        self.matching(request, true).is_empty()
    }

    pub fn network_rules(&self) -> usize {
        self.host_block.values().map(Vec::len).sum::<usize>() + self.url_block.len()
    }

    pub fn hiding_rules(&self) -> usize {
        self.hide.len() + self.hide_on.len()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const LIST: &str = "[Adblock Plus 2.0]\n! Title: Test\n||ads.example.com^\n||tracker.net^$third-party\n||bad.com^$script\n||site.com^$domain=x.com|~y.x.com\n||pop.com^$popup\n@@||ok.ads.example.com^\n||cdn.com/path/ad.js\n/banner/ads/*$image\n|https://track.*/pixel.gif|\n-ad-300x250.\n@@||cdn.com/path/ad.js?keep$script\n||imp.com^$important\n@@||imp.com^\n||gone.com^\n||gone.com^$badfilter\n||page.ads^$document\n0.0.0.0 hosted.example\n##.ad-banner\n##div[id^=\"google_ads\"]\n##.x:has(.y)\n##.z:has-text(Ad)\nnews.com##.promo\n~news.com##.everywhere-else\n#@#.ad-banner\nexample.org#@#.foo\nyoutube.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)\nexample.*##+js(aopr, popunder)\nexample.org#@#+js()\n@@||quiet.org^$generichide\n";

    fn rules() -> Rules {
        let mut rules = Rules::default();
        rules.add_list(LIST);
        rules
    }

    fn check(rules: &Rules, url: &str, page: &str, kind: u16) -> bool {
        let host = url.split("://").nth(1).unwrap().split(['/', ':', '?']).next().unwrap();
        rules.blocks(&Request { url, host, page_host: page, kind })
    }

    #[test]
    fn reads_rules() {
        let r = rules();
        assert_eq!(r.host_block["ads.example.com"][0].pattern, "");
        assert_eq!(r.host_block["tracker.net"][0].party, Party::Third);
        assert_eq!(r.host_block["bad.com"][0].kinds, kind::SCRIPT);
        assert_eq!((r.host_block["site.com"][0].domains.clone(), r.host_block["site.com"][0].not_domains.clone()), (vec!["x.com".to_string()], vec!["y.x.com".to_string()]));
        assert!(!r.host_block.contains_key("gone.com"), "badfilter removes the rule it names");
        assert!(r.host_block.contains_key("hosted.example"), "hosts-file lines");
        assert_eq!(r.url_block.len(), 3);
        assert!(r.hide.contains(&".x:has(.y)".to_string()) && !r.hide.iter().any(|s| s.contains("has-text")), "CSS yes, procedural no");
        assert!(!r.hide.contains(&".ad-banner".to_string()), "unhidden everywhere");
        assert_eq!(r.hide_on[0].value, ".promo");
        assert_eq!(r.unhide_on["news.com"], vec![".everywhere-else".to_string()]);
        assert_eq!(r.scriptlets[0].value, Scriptlet { name: "set-constant".into(), args: vec!["ytInitialPlayerResponse.adPlacements".into(), "undefined".into()] });
        assert_eq!(r.scriptlets[1].sites, vec!["example.*".to_string()]);
        assert_eq!(r.scriptlet_exceptions, vec![("example.org".to_string(), String::new())]);
        assert_eq!(r.no_generic_hide, vec!["quiet.org".to_string()]);
    }

    #[test]
    fn checks_requests() {
        let r = rules();
        assert!(check(&r, "https://ads.example.com/x", "news.com", kind::SCRIPT));
        assert!(check(&r, "https://a.ads.example.com/x", "news.com", kind::IMAGE));
        assert!(!check(&r, "https://ok.ads.example.com/x", "news.com", kind::IMAGE), "exceptions win");
        assert!(check(&r, "https://px.tracker.net/p", "news.com", kind::IMAGE));
        assert!(!check(&r, "https://tracker.net/p", "www.tracker.net", kind::IMAGE), "first party");
        assert!(check(&r, "https://bad.com/x.js", "news.com", kind::SCRIPT) && !check(&r, "https://bad.com/x.png", "news.com", kind::IMAGE));
        assert!(check(&r, "https://site.com/a", "x.com", kind::IMAGE) && !check(&r, "https://site.com/a", "y.x.com", kind::IMAGE) && !check(&r, "https://site.com/a", "z.com", kind::IMAGE), "domain=");
        assert!(check(&r, "https://cdn.com/path/ad.js?v=2", "news.com", kind::SCRIPT) && !check(&r, "https://cdn.com/path/app.js", "news.com", kind::SCRIPT));
        assert!(!check(&r, "https://cdn.com/path/ad.js?keep", "news.com", kind::SCRIPT), "exception with a path");
        assert!(check(&r, "https://img.site.org/banner/ads/1.jpg", "news.com", kind::IMAGE) && !check(&r, "https://img.site.org/banner/ads/1.jpg", "news.com", kind::SCRIPT));
        assert!(check(&r, "https://track.foo.org/pixel.gif", "news.com", kind::IMAGE) && !check(&r, "https://track.foo.org/pixel.gif?x", "news.com", kind::IMAGE), "anchored both ends");
        assert!(check(&r, "https://x.org/img/sale-ad-300x250.png", "news.com", kind::IMAGE));
        assert!(check(&r, "https://imp.com/a", "news.com", kind::SCRIPT), "important beats the exception");
        assert!(!check(&r, "https://page.ads/", "news.com", kind::SCRIPT) && check(&r, "https://page.ads/", "news.com", kind::DOCUMENT));
        assert!(!check(&r, "https://ads.example.com/", "news.com", kind::DOCUMENT), "pages need a document rule");
    }

    #[test]
    fn checks_popups() {
        let r = rules();
        assert!(check(&r, "https://pop.com/landing", "news.com", kind::POPUP));
        assert!(!check(&r, "https://pop.com/a.js", "news.com", kind::SCRIPT), "popup rules leave requests alone");
        assert!(check(&r, "https://ads.example.com/click", "news.com", kind::POPUP), "ad servers can't open pop-ups");
        assert!(!check(&r, "https://wikipedia.org/", "news.com", kind::POPUP));
    }

    #[test]
    fn patterns_and_sites() {
        assert!(glob("/ads/*/banner", "https://x.com/ads/123/banner.gif", false, false));
        assert!(!glob("/ads/*/banner", "https://x.com/news/123/banner.gif", false, false));
        assert!(glob("^ad^", "https://x.com/ad/1", false, false) && glob("^ad^", "https://x.com/ad", false, false) && !glob("^ad^", "https://x.com/add/", false, false));
        assert!(glob("https://*.net/p", "https://a.b.net/p", true, true));
        assert_eq!(site("news.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site("a.b.example.com"), "example.com");
        assert_eq!(site("example.com"), "example.com");
        assert!(on_site("www.google.co.uk", &["google.*".into()]) && on_site("google.com", &["google.*".into()]) && !on_site("notgoogle.com", &["google.*".into()]));
        assert!(on_site("a.x.com", &["x.com".into()]) && !on_site("ax.com", &["x.com".into()]));
        assert!(css_selector("div[id^=\"ad\"]:not(.keep) > a[href^=\"https://x\"]") && !css_selector(".a:has-text(x)") && !css_selector(".a::after") && !css_selector(".a:foo"));
        assert_eq!(scriptlet_args("set, a.b, 'x, y', c\\,d"), vec!["set", "a.b", "x, y", "c,d"]);
    }
}

