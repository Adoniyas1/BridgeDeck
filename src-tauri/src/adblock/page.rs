//! The script each web page gets before its own scripts run:
//! - the pop-up guard: a window a page opens from script, rather than from a link the person
//!   clicked, is sent through `bridgedeck.invalid/popup?u=…` so BridgeDeck can decide (browser.rs);
//! - the scriptlets the lists give for the page's site (scriptlets.js), and a YouTube ad skipper;
//! - on Windows, element hiding (WebKit does its own on macOS from the content-blocker lists).
//!
//! Per-site data is kept as text the page searches for its own site only, so a page doesn't
//! parse the rules of every other site.

use super::filters::Rules;
use std::collections::{BTreeMap, HashMap};


const SCRIPTLETS: &str = include_str!("scriptlets.js");

/// The scriptlets scriptlets.js has (others in the lists are skipped).
pub const SUPPORTED: &[&str] = &[
    "set-constant", "trusted-set-constant", "trusted-set", "abort-on-property-read", "abort-on-property-write", "abort-current-script",
    "prevent-addEventListener", "prevent-setTimeout", "prevent-setInterval", "adjust-setTimeout", "adjust-setInterval",
    "prevent-window-open", "prevent-fetch", "prevent-xhr", "remove-attr", "remove-class", "remove-node-text", "rpnt", "replace-node-text",
    "trusted-rpnt", "noeval", "noeval-if", "set-cookie", "trusted-set-cookie", "remove-cookie", "cookie-remover", "set-local-storage-item",
    "trusted-set-local-storage-item", "set-session-storage-item", "trusted-set-session-storage-item", "trusted-click-element", "json-prune",
    "json-prune-fetch-response", "json-prune-xhr-response", "trusted-replace-fetch-response", "trusted-rpfr", "trusted-replace-xhr-response",
    "nowebrtc", "nobab", "nofab", "popads-dummy",
];

/// Window-opening guard (all frames: ad frames open most pop-ups).
pub const POPUP_GUARD: &str = r#"(function(){
if(window.__bdPopups)return;window.__bdPopups=1;
var lastLink=null,lastAt=0,open=window.open;
addEventListener('click',function(e){if(!e.isTrusted)return;lastAt=Date.now();var a=e.target&&e.target.closest&&e.target.closest('a[href]');lastLink=a?a.href:null},true);
function wrap(url){try{var u=new URL(String(url),location.href);if(!/^https?:$/.test(u.protocol))return url;
if(lastLink&&lastLink===u.href&&Date.now()-lastAt<2000)return url;
return 'https://bridgedeck.invalid/popup?u='+encodeURIComponent(u.href)}catch(e){return url}}
window.open=function(url){var a=Array.prototype.slice.call(arguments);if(url)a[0]=wrap(url);return open.apply(this,a)};
var click=HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click=function(){var t=(this.target||'').toLowerCase();
if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'&&Date.now()-lastAt>2000){window.open(this.href);return}
return click.apply(this,arguments)};
})();"#;

/// YouTube: skips and silences the ads that still get through, and hides ad boxes.
const YOUTUBE: &str = r#"function(){
var css='#player-ads,#masthead-ad,ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,ytd-banner-promo-renderer,ytd-statement-banner-renderer,ytd-promoted-sparkles-web-renderer,ytd-display-ad-renderer,ytd-companion-slot-renderer,ytd-merch-shelf-renderer,.ytp-ad-overlay-container,.ytp-ad-overlay-slot,ytd-rich-item-renderer:has(ytd-ad-slot-renderer){display:none!important}';
var add=function(){var s=document.createElement('style');s.textContent=css;(document.head||document.documentElement).appendChild(s)};
if(document.documentElement)add();else document.addEventListener('DOMContentLoaded',add);
var normal=null,muted=false;
setInterval(function(){
var skip=document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern');if(skip)skip.click();
var player=document.querySelector('.html5-video-player');if(!player)return;var v=player.querySelector('video');if(!v)return;
if(player.classList.contains('ad-showing')||player.classList.contains('ad-interrupting')){
if(normal===null)normal=v.playbackRate;if(!v.muted){v.muted=true;muted=true}
if(isFinite(v.duration)&&v.duration>0&&v.currentTime<v.duration-0.2)v.currentTime=v.duration-0.1;
v.playbackRate=16;
}else if(normal!==null){v.playbackRate=normal;normal=null;if(muted){v.muted=false;muted=false}}
},250);
}"#;

/// A site key with its labels reversed ("www.youtube.com" → "com.youtube.www", "google.*" →
/// "*.google"), so all of a site's entries sort together and the page finds them in one search.
fn reversed(key: &str) -> String {
    key.rsplit('.').collect::<Vec<_>>().join(".")
}

/// Per-site data: `\n{reversed site}\t{kind}{value}` lines, sorted. Kinds: `s` scriptlets to
/// run (ids), `n` scriptlets not to run there, `x` scriptlet exceptions (names), `h` selectors to
/// hide, `u` general selectors not hidden there, `i` site selectors not hidden there, `g` no
/// general hiding, `e` no hiding at all.
#[derive(Default)]
struct Sites(Vec<(String, char, String)>);

impl Sites {
    fn add(&mut self, site: &str, kind: char, value: String) {
        let key = if site == "*" { "*".to_string() } else { reversed(site) };
        self.0.push((key, kind, value));
    }

    fn blob(mut self) -> String {
        self.0.sort();
        let mut out = String::from("\n");
        for (key, kind, value) in self.0 {
            out.push_str(&key);
            out.push('\t');
            out.push(kind);
            out.push_str(&value);
            out.push('\n');
        }
        out
    }
}

fn clean(s: &str) -> bool {
    !s.contains(['\n', '\t', '\u{1}'])
}

/// The scriptlet calls (as JSON text, parsed by a page only if its site has any) and per-site data.
fn scriptlet_data(rules: &Rules, sites: &mut Sites) -> String {
    let mut calls: Vec<Vec<String>> = Vec::new();
    let mut ids: HashMap<Vec<String>, usize> = HashMap::new();
    let mut on: BTreeMap<(String, char), Vec<usize>> = BTreeMap::new();
    for rule in &rules.scriptlets {
        if !SUPPORTED.contains(&rule.value.name.as_str()) || rule.value.args.iter().any(|a| !clean(a)) {
            continue;
        }
        let call: Vec<String> = std::iter::once(rule.value.name.clone()).chain(rule.value.args.iter().cloned()).collect();
        let next = calls.len();
        let id = *ids.entry(call.clone()).or_insert_with(|| { calls.push(call); next });
        let targets = if rule.sites.is_empty() { vec!["*".to_string()] } else { rule.sites.clone() };
        for site in targets {
            on.entry((site, 's')).or_default().push(id);
        }
        for site in &rule.not_sites {
            on.entry((site.clone(), 'n')).or_default().push(id);
        }
    }
    for ((site, kind), mut list) in on {
        list.sort();
        list.dedup();
        sites.add(&site, kind, serde_json::to_string(&list).unwrap_or_default());
    }
    let mut except: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (site, name) in &rules.scriptlet_exceptions {
        except.entry(site.clone()).or_default().push(name.clone());
    }
    for (site, names) in except {
        sites.add(&site, 'x', serde_json::to_string(&names).unwrap_or_default());
    }
    serde_json::to_string(&calls).unwrap_or_default()
}

/// A general selector that's just a class or an id: hidden only when the page has that class or
/// id (most of the 40,000 are, and a page has few of them).
fn simple(sel: &str) -> bool {
    (sel.starts_with('.') || sel.starts_with('#')) && sel.len() > 1 && sel[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Element hiding for Windows: general class/id selectors (applied as the page shows them), other
/// general selectors as CSS (a rule each, so one Chromium can't read only loses itself), and the
/// per-site ones.
fn hiding_data(rules: &Rules, sites: &mut Sites) -> (String, String) {
    let names: String = rules.hide.iter().filter(|s| simple(s)).map(|s| format!("{s}\n")).collect();
    let complex: String = rules.hide.iter().filter(|s| !simple(s) && clean(s)).map(|s| format!("\n{s}{{display:none!important}}")).collect();
    let mut by: BTreeMap<(String, char), Vec<&str>> = BTreeMap::new();
    for h in rules.hide_on.iter().filter(|h| clean(&h.value)) {
        for site in &h.sites {
            by.entry((site.clone(), 'h')).or_default().push(&h.value);
        }
        for site in &h.not_sites {
            by.entry((site.clone(), 'i')).or_default().push(&h.value);
        }
    }
    for (site, selectors) in &rules.unhide_on {
        if site != "*" {
            for s in selectors.iter().filter(|s| clean(s)) {
                by.entry((site.clone(), 'u')).or_default().push(s);
            }
        }
    }
    for ((site, kind), list) in by {
        sites.add(&site, kind, list.join("\u{1}"));
    }
    for site in &rules.no_generic_hide {
        sites.add(site, 'g', String::new());
    }
    for site in &rules.no_hide {
        sites.add(site, 'e', String::new());
    }
    (format!("\n{names}"), complex)
}

/// The page script. `rules`: none when the blocker is off or has no lists yet (the pop-up guard
/// still runs). `hiding`: include element hiding (Windows).
pub fn script(rules: Option<&Rules>, allowed: &[String], popup_guard: bool, hiding: bool) -> String {
    let mut out = String::new();
    if popup_guard {
        out.push_str(POPUP_GUARD);
    }
    let Some(rules) = rules else { return out };
    let mut sites = Sites::default();
    let calls = scriptlet_data(rules, &mut sites);
    let (names, complex) = if hiding { hiding_data(rules, &mut sites) } else { (String::new(), String::new()) };
    let json = |v: &dyn erased::Json| v.json();
    out.push_str(&format!(
        r#"(function(){{
if(window.__bdShield)return;window.__bdShield=1;
var host=location.hostname.toLowerCase(),ALLOWED={allowed};
function on(d){{return host===d||host.slice(-d.length-1)==='.'+d}}
for(var i=0;i<ALLOWED.length;i++)if(on(ALLOWED[i]))return;
var D={data};
var parts=host.split('.'),rev=parts.slice().reverse().join('.');
var two=/^(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|ltd|plc|sch)$/.test(parts[parts.length-2]||'')&&(parts[parts.length-1]||'').length===2?3:2;
var site=parts.slice(-two).reverse().join('.');
var label=parts.slice(0,Math.max(parts.length-two,0)+1).reverse().join('.');
var mine={{}};
function scan(prefix,whole){{var at=D.indexOf('\n'+prefix);while(at>=0){{var tab=D.indexOf('\t',at+1),end=D.indexOf('\n',tab);var key=D.slice(at+1,tab);
if(key.slice(0,prefix.length)!==prefix)break;
if(whole===key||whole.slice(0,key.length+1)===key+'.'){{var k=D.charAt(tab+1);(mine[k]=mine[k]||[]).push(D.slice(tab+2,end))}}
at=end<D.length-1?end:-1}}}}
scan(site,rev);scan('*.'+label.split('.')[0],'*.'+label);
var at=D.indexOf('\n*\t');while(at>=0){{var e=D.indexOf('\n',at+1),k=D.charAt(at+3);(mine[k]=mine[k]||[]).push(D.slice(at+4,e));at=D.slice(e,e+3)==='\n*\t'?e:-1}}
function each(k,f){{(mine[k]||[]).forEach(f)}}
var ids={{}},off={{}},none=false;
each('s',function(v){{JSON.parse(v).forEach(function(i){{ids[i]=1}})}});
each('n',function(v){{JSON.parse(v).forEach(function(i){{delete ids[i]}})}});
each('x',function(v){{JSON.parse(v).forEach(function(n){{if(n==='')none=true;else off[n]=1}})}});
var wanted=Object.keys(ids);
if(!none&&wanted.length){{var CALLS=JSON.parse({calls}),run=[];wanted.forEach(function(i){{var c=CALLS[i];if(c&&!off[c[0]])run.push(c)}});
if(run.length){{{scriptlets}
__bdScriptlets(run)}}}}
if(on('youtube.com'))({youtube})();
var NAMES={names},COMPLEX={complex};
if(NAMES.length>1&&!mine.e&&window.top===window){{
var unhide={{}};each('u',function(v){{v.split('\u0001').forEach(function(s){{unhide[s]=1}})}});
var notHere={{}};each('i',function(v){{v.split('\u0001').forEach(function(s){{notHere[s]=1}})}});
var general=!mine.g;
var css=general?COMPLEX:'';
for(var s in unhide)css=css.split('\n'+s+'{{display:none!important}}').join('');
each('h',function(v){{v.split('\u0001').forEach(function(s){{if(!notHere[s])css+='\n'+s+'{{display:none!important}}'}})}});
var style=null,known=null,shown={{}};
function put(text){{if(!text)return;if(!style){{style=document.createElement('style');(document.head||document.documentElement).appendChild(style)}}style.textContent+=text}}
function look(root){{if(!general)return;if(!known){{known=new Set(NAMES.split('\n'))}}var add='';
var check=function(name){{if(!shown[name]&&known.has(name)&&!unhide[name]){{shown[name]=1;add+='\n'+name+'{{display:none!important}}'}}}};
var els=root.querySelectorAll?root.querySelectorAll('[id],[class]'):[];
var visit=function(el){{if(el.id)check('#'+el.id);var c=el.classList;if(c)for(var i=0;i<c.length;i++)check('.'+c[i])}};
if(root.nodeType===1)visit(root);for(var i=0;i<els.length;i++)visit(els[i]);put(add)}}
var queued=[],timer=0;
function start(){{put(css);look(document);new MutationObserver(function(records){{records.forEach(function(r){{r.addedNodes.forEach(function(n){{if(n.nodeType===1)queued.push(n)}})}});
if(!timer)timer=setTimeout(function(){{timer=0;var q=queued;queued=[];q.forEach(look)}},150)}}).observe(document.documentElement,{{childList:true,subtree:true}})}}
if(document.documentElement&&css)put(css),css='';
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
}}
}})();"#,
        allowed = json(&allowed),
        data = json(&sites.blob()),
        calls = json(&calls),
        scriptlets = SCRIPTLETS,
        youtube = YOUTUBE,
        names = json(&names),
        complex = json(&complex),
    ));
    out
}

mod erased {
    pub trait Json {
        fn json(&self) -> String;
    }
    impl<T: serde::Serialize> Json for T {
        fn json(&self) -> String {
            serde_json::to_string(self).unwrap_or_else(|_| "null".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::filters::{tests::LIST, Rules};
    use super::*;

    #[test]
    fn every_scriptlet_in_the_library_is_listed() {
        let names: Vec<&str> = SCRIPTLETS.lines().filter_map(|l| l.trim().strip_prefix('\'')).filter_map(|l| l.split_once("': function").map(|(n, _)| n)).collect();
        assert!(names.len() > 30);
        for n in &names {
            assert!(SUPPORTED.contains(n), "{n} missing from SUPPORTED");
        }
        assert_eq!(names.len(), SUPPORTED.len());
    }

    #[test]
    fn builds_the_page_script() {
        let mut rules = Rules::default();
        rules.add_list(LIST);
        let script = script(Some(&rules), &["ok.org".into()], true, true);
        assert!(script.starts_with(POPUP_GUARD));
        assert!(script.contains("\\ncom.youtube\\ts[0]\\n"), "scriptlet calls by site, reversed");
        assert!(script.contains("\\n*.example\\ts[1]\\n"), "entities");
        assert!(script.contains("[[\\\"set-constant\\\",\\\"ytInitialPlayerResponse.adPlacements\\\",\\\"undefined\\\"]"), "calls as JSON text");
        assert!(script.contains("\\norg.example\\tx[\\\"\\\"]"), "exceptions");
        assert!(script.contains(".x:has(.y){display:none!important}"), "complex selectors as CSS");
        assert!(script.contains("\\ncom.news\\th.promo\\n"));
        assert!(script.contains("\\norg.quiet\\tg\\n"));
        assert!(script.contains("[\"ok.org\"]"));
        assert_eq!(super::script(None, &[], true, true), POPUP_GUARD);
        assert!(!super::script(Some(&rules), &[], false, false).contains("{display:none!important}\\n"), "no hiding data on macOS");
        assert_eq!(reversed("www.youtube.com"), "com.youtube.www");
        assert_eq!(reversed("google.*"), "*.google");
    }
}
