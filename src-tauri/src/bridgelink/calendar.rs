//! Calendar events, kept on every paired computer, and (on the Mac) a read-only view of Apple
//! Calendar and Reminders that the paired PC can see too.
//!
//! Sync works like notes (see `notes.rs`): every change gets the next number in this store's
//! sequence, a paired computer pulls "everything after N" page by page (`POST /calendar/pull`), and a
//! local change pokes it (`POST /calendar/poke`). An event is merged whole: the newer edit wins.
//! Repeating events are stored once with their rule; the UI expands them into occurrences.

use super::*;

const MAX_EVENTS: usize = 20_000;
const MAX_TEXT: usize = 10_000;
const MAX_SKIPS: usize = 500;
const PAGE_BYTES: usize = 600 * 1024;
/// Largest `.ics` file BridgeDeck reads or writes.
const MAX_ICS: u64 = 8 * 1024 * 1024;
const FREQS: &[&str] = &["daily", "weekly", "monthly", "yearly"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Repeat {
    /// "daily", "weekly", "monthly" or "yearly".
    pub freq: String,
    #[serde(default)]
    pub interval: u32,
    /// Weekly: the weekdays it happens on, 0 = Sunday.
    #[serde(default)]
    pub days: Vec<u8>,
    /// Last day it can happen (ms), or none.
    #[serde(default)]
    pub until: Option<i64>,
    /// How many times it happens, or none.
    #[serde(default)]
    pub count: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Start and end in ms since 1970. All-day events run from local midnight to local midnight.
    #[serde(default)]
    pub start: i64,
    #[serde(default)]
    pub end: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub notes: String,
    /// One of the UI's colour names.
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub repeat: Option<Repeat>,
    /// Starts of occurrences removed from a repeating event.
    #[serde(default)]
    pub skip: Vec<i64>,
    /// Minutes before the start to remind, or none.
    #[serde(default)]
    pub reminder: Option<i64>,
    #[serde(default)]
    pub updated: u64,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub seq: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    events: Vec<Event>,
    seq: u64,
    seen: HashMap<String, u64>,
    #[serde(default)]
    share_apple: bool,
}

#[derive(Default)]
pub struct CalendarStore {
    events: HashMap<String, Event>,
    seq: u64,
    seen: HashMap<String, u64>,
    /// This Mac lets its paired computers see Apple Calendar and Reminders.
    share_apple: bool,
}

fn clean_text(value: &str, max: usize) -> String {
    value.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).take(max).collect()
}

fn clean_line(value: &str, max: usize) -> String {
    clean_text(value, max).replace(['\n', '\t'], " ").trim().to_string()
}

fn sanitize(event: Event) -> Option<Event> {
    let id: String = event.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    if id.is_empty() {
        return None;
    }
    let repeat = event.repeat.filter(|r| FREQS.contains(&r.freq.as_str())).map(|r| Repeat {
        freq: r.freq,
        interval: r.interval.clamp(1, 999),
        days: {
            let mut days: Vec<u8> = r.days.into_iter().filter(|d| *d < 7).collect();
            days.sort_unstable();
            days.dedup();
            days
        },
        until: r.until,
        count: r.count.map(|c| c.clamp(1, 10_000)),
    });
    let mut skip = event.skip;
    skip.truncate(MAX_SKIPS);
    Some(Event {
        id,
        title: clean_line(&event.title, 300),
        start: event.start,
        end: event.end.max(event.start),
        all_day: event.all_day,
        location: clean_line(&event.location, 300),
        notes: clean_text(&event.notes, MAX_TEXT),
        color: event.color.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect(),
        repeat,
        skip,
        reminder: event.reminder.map(|m| m.clamp(0, 60 * 24 * 28)),
        updated: event.updated,
        by: clean_line(&event.by, 64),
        deleted: event.deleted,
        seq: 0,
    })
}

impl CalendarStore {
    pub(super) fn load(dir: &Path) -> Self {
        let persisted = load_json::<Persisted>(&dir.join("calendar.json")).unwrap_or_default();
        Self { events: persisted.events.into_iter().map(|e| (e.id.clone(), e)).collect(), seq: persisted.seq, seen: persisted.seen, share_apple: persisted.share_apple }
    }

    pub(super) fn save(&self, dir: Option<&PathBuf>) {
        let Some(dir) = dir else { return };
        let persisted = Persisted { events: self.events.values().cloned().collect(), seq: self.seq, seen: self.seen.clone(), share_apple: self.share_apple };
        if let Ok(raw) = serde_json::to_string(&persisted) {
            let _ = secure_write(&dir.join("calendar.json"), &raw);
        }
    }

    fn bump(&mut self, id: &str) {
        self.seq += 1;
        let seq = self.seq;
        if let Some(event) = self.events.get_mut(id) {
            event.seq = seq;
        }
    }

    pub fn list(&self) -> Vec<Event> {
        let mut events: Vec<Event> = self.events.values().filter(|e| !e.deleted).cloned().collect();
        events.sort_by_key(|e| e.start);
        events
    }

    /// Adds or replaces an event edited here.
    pub fn save_from_ui(&mut self, event: Event, device: &str, now: u64) -> Result<Event, String> {
        let event = sanitize(event).ok_or("Invalid event")?;
        if !self.events.contains_key(&event.id) && self.events.len() >= MAX_EVENTS {
            return Err("There are too many events; delete some first".into());
        }
        if let Some(current) = self.events.get(&event.id) {
            let same = Event { updated: current.updated, by: current.by.clone(), seq: current.seq, ..event.clone() };
            if &same == current {
                return Ok(current.clone());
            }
        }
        let stored = Event { updated: now.max(self.events.get(&event.id).map(|e| e.updated + 1).unwrap_or(0)), by: device.into(), deleted: false, ..event };
        let id = stored.id.clone();
        self.events.insert(id.clone(), stored);
        self.bump(&id);
        Ok(self.events[&id].clone())
    }

    pub fn delete(&mut self, id: &str, device: &str, now: u64) -> bool {
        let Some(event) = self.events.get_mut(id) else { return false };
        if event.deleted {
            return false;
        }
        // Only the marker stays, so the deletion spreads and the details don't linger.
        *event = Event { id: event.id.clone(), deleted: true, updated: now.max(event.updated + 1), by: device.into(), ..Default::default() };
        self.bump(id);
        true
    }

    /// Merges an event from a paired computer: the newer edit wins. True if anything changed.
    pub fn merge(&mut self, incoming: Event) -> bool {
        let Some(incoming) = sanitize(incoming) else { return false };
        let id = incoming.id.clone();
        match self.events.get(&id) {
            Some(current) if !((incoming.updated, incoming.by.as_str()) > (current.updated, current.by.as_str())) => false,
            None if self.events.len() >= MAX_EVENTS => false,
            _ => {
                self.events.insert(id.clone(), incoming);
                self.bump(&id);
                true
            }
        }
    }

    pub fn changes_since(&self, since: u64) -> CalendarPullAnswer {
        let since = if since > self.seq { 0 } else { since };
        let mut changed: Vec<&Event> = self.events.values().filter(|e| e.seq > since).collect();
        changed.sort_by_key(|e| e.seq);
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut upto = since;
        for event in changed {
            let size = serde_json::to_string(event).map(|s| s.len()).unwrap_or(0);
            if !events.is_empty() && bytes + size > PAGE_BYTES {
                return CalendarPullAnswer { events, upto, more: true };
            }
            bytes += size;
            upto = event.seq;
            events.push(event.clone());
        }
        CalendarPullAnswer { events, upto, more: false }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPullAnswer {
    pub events: Vec<Event>,
    pub upto: u64,
    pub more: bool,
}

#[derive(Deserialize)]
struct PullRequest {
    since: u64,
}

pub(super) fn answer_pull(manager: &BridgeLinkManager, body: &str) -> Result<String, String> {
    let request: PullRequest = serde_json::from_str(body).map_err(|_| "Invalid calendar request".to_string())?;
    let runtime = manager.lock()?;
    serde_json::to_string(&runtime.calendar.changes_since(request.since)).map_err(|e| e.to_string())
}

pub(super) fn pull_from(manager: &BridgeLinkManager, instance_id: &str) -> Result<usize, String> {
    let mut merged = 0;
    for _ in 0..50 {
        let since = manager.lock()?.calendar.seen.get(instance_id).copied().unwrap_or(0);
        let answer = peer::pull_calendar(manager, instance_id, since)?;
        let mut runtime = manager.lock()?;
        let mut changed = false;
        for event in answer.events {
            changed |= runtime.calendar.merge(event);
        }
        runtime.calendar.seen.insert(instance_id.to_string(), answer.upto);
        runtime.calendar.save(runtime.storage_dir.as_ref());
        if changed {
            merged += 1;
            if let Some(app) = runtime.app.clone() {
                use tauri::Emitter;
                let _ = app.emit("calendar-changed", ());
            }
        }
        if !answer.more {
            break;
        }
    }
    Ok(merged)
}

pub(super) fn pull_all(manager: &BridgeLinkManager) {
    let peers: Vec<String> = manager.lock().map(|r| r.paired.keys().cloned().collect()).unwrap_or_default();
    for peer in peers {
        let _ = pull_from(manager, &peer);
    }
}

fn changed(manager: &BridgeLinkManager) {
    let peers = match manager.lock() {
        Ok(runtime) => {
            runtime.calendar.save(runtime.storage_dir.as_ref());
            runtime.paired.keys().cloned().collect::<Vec<_>>()
        }
        Err(_) => return,
    };
    let manager = manager.clone();
    thread::spawn(move || {
        for peer in peers {
            let _ = peer::poke_calendar(&manager, &peer);
        }
    });
}

pub(super) fn local<T>(manager: &BridgeLinkManager, change: impl FnOnce(&mut CalendarStore, &str, u64) -> Result<T, String>) -> Result<T, String> {
    let value = {
        let mut runtime = manager.lock()?;
        let device = runtime.instance_id.clone();
        let mut calendar = std::mem::take(&mut runtime.calendar);
        let result = change(&mut calendar, &device, now_ms());
        runtime.calendar = calendar;
        result?
    };
    changed(manager);
    Ok(value)
}

#[tauri::command]
pub fn calendar_list(manager: State<'_, BridgeLinkManager>) -> Result<Vec<Event>, String> {
    Ok(manager.lock()?.calendar.list())
}

#[tauri::command]
pub fn calendar_save(event: Event, manager: State<'_, BridgeLinkManager>) -> Result<Event, String> {
    local(&manager, |calendar, device, now| calendar.save_from_ui(event, device, now))
}

#[tauri::command]
pub fn calendar_delete(id: String, manager: State<'_, BridgeLinkManager>) -> Result<bool, String> {
    local(&manager, |calendar, device, now| Ok(calendar.delete(&id, device, now)))
}

/// Adds events read from an `.ics` file. Returns how many were added or changed.
#[tauri::command]
pub fn calendar_import(events: Vec<Event>, manager: State<'_, BridgeLinkManager>) -> Result<usize, String> {
    local(&manager, |calendar, device, now| {
        let mut count = 0;
        for event in events {
            if calendar.save_from_ui(event, device, now).is_ok() {
                count += 1;
            }
        }
        Ok(count)
    })
}

fn ics_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
        Some(ext) if ext == "ics" || ext == "ical" || ext == "ifb" => Ok(path),
        _ => Err("Choose an .ics calendar file".into()),
    }
}

#[tauri::command]
pub fn calendar_read_ics(path: String) -> Result<String, String> {
    let path = ics_path(&path)?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_ICS {
        return Err("That calendar file is too big (over 8 MB)".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read it: {e}"))
}

#[tauri::command]
pub fn calendar_write_ics(path: String, contents: String) -> Result<(), String> {
    let path = ics_path(&path)?;
    if contents.len() as u64 > MAX_ICS {
        return Err("Too many events to export at once".into());
    }
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't save it: {e}"))
}

// ---- Apple Calendar and Reminders (read-only, on the Mac) ----

/// An Apple Calendar event occurrence or a Reminder with a due date.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppleItem {
    pub id: String,
    /// "event" or "reminder".
    pub kind: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub calendar: String,
    #[serde(default)]
    pub location: String,
    /// The computer it came from.
    #[serde(default)]
    pub from: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleAnswer {
    pub items: Vec<AppleItem>,
    /// Problems reaching Apple Calendar (permission) or a paired Mac.
    pub errors: Vec<String>,
}

#[derive(Deserialize)]
struct AppleRequest {
    from: i64,
    to: i64,
}

/// Reads Apple Calendar events and incomplete Reminders between two times through EventKit, from
/// a JavaScript for Automation script. The first time, macOS asks to allow BridgeDeck.
#[cfg(target_os = "macos")]
const APPLE_SCRIPT: &str = r#"
ObjC.import('EventKit');
ObjC.import('Foundation');
function wait(isDone, seconds) {
  const until = $.NSDate.dateWithTimeIntervalSinceNow(seconds);
  while (!isDone() && $.NSDate.date.compare(until) < 0) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
}
function allow(store, type) {
  const status = $.EKEventStore.authorizationStatusForEntityType(type);
  if (status === 3 || status === 4) return true;
  if (status !== 0) return false;
  let done = false, granted = false;
  const finish = (ok, error) => { granted = ok; done = true; };
  if (type === 0 && store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(finish);
  else if (type === 1 && store.respondsToSelector('requestFullAccessToRemindersWithCompletion:')) store.requestFullAccessToRemindersWithCompletion(finish);
  else store.requestAccessToEntityTypeCompletion(type, finish);
  wait(() => done, 120);
  return granted;
}
function text(value) { const s = ObjC.unwrap(value); return typeof s === 'string' ? s : ''; }
function run(argv) {
  const from = $.NSDate.dateWithTimeIntervalSince1970(Number(argv[0]) / 1000);
  const to = $.NSDate.dateWithTimeIntervalSince1970(Number(argv[1]) / 1000);
  const store = $.EKEventStore.alloc.init;
  const items = [], errors = [];
  if (allow(store, 0)) {
    const events = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(from, to, null));
    for (let i = 0; i < events.count; i++) {
      const e = events.objectAtIndex(i);
      const start = Math.round(e.startDate.timeIntervalSince1970 * 1000);
      items.push({ id: text(e.eventIdentifier) + '@' + start, kind: 'event', title: text(e.title), start, end: Math.round(e.endDate.timeIntervalSince1970 * 1000),
        allDay: !!e.allDay, calendar: text(e.calendar.title), location: text(e.location) });
    }
  } else errors.push('calendar');
  if (allow(store, 1)) {
    let done = false;
    store.fetchRemindersMatchingPredicateCompletion(store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars(from, to, null), (found) => {
      const list = found || [];
      for (let i = 0; i < list.count; i++) {
        const r = list.objectAtIndex(i);
        const due = $.NSCalendar.currentCalendar.dateFromComponents(r.dueDateComponents);
        if (!due || due.isNil()) continue;
        const start = Math.round(due.timeIntervalSince1970 * 1000);
        const timed = r.dueDateComponents.hour !== $.NSDateComponentUndefined;
        items.push({ id: text(r.calendarItemIdentifier), kind: 'reminder', title: text(r.title), start, end: start, allDay: !timed, calendar: text(r.calendar.title), location: '' });
      }
      done = true;
    });
    wait(() => done, 30);
  } else errors.push('reminders');
  return JSON.stringify({ items, errors });
}
"#;

#[cfg(target_os = "macos")]
pub fn apple_items(from: i64, to: i64) -> Result<AppleAnswer, String> {
    use std::io::Read;
    let mut child = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", APPLE_SCRIPT, &from.to_string(), &to.to_string()])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't read Apple Calendar: {e}"))?;
    // The first run waits for the permission prompt; after that it takes well under a second.
    let deadline = std::time::Instant::now() + Duration::from_secs(150);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return Err("Apple Calendar didn't answer in time".into());
            }
        }
    }
    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut err);
    }
    #[derive(Deserialize)]
    struct Raw {
        items: Vec<AppleItem>,
        errors: Vec<String>,
    }
    let raw: Raw = serde_json::from_str(out.trim()).map_err(|_| format!("Apple Calendar: {}", err.trim().chars().take(300).collect::<String>()))?;
    let errors = raw
        .errors
        .iter()
        .map(|e| format!("Allow BridgeDeck to see your {}: System Settings → Privacy & Security → {} → BridgeDeck (full access).", if e == "calendar" { "calendars" } else { "reminders" }, if e == "calendar" { "Calendars" } else { "Reminders" }))
        .collect();
    let items = raw.items.into_iter().take(5_000).map(|i| AppleItem { title: clean_line(&i.title, 300), calendar: clean_line(&i.calendar, 100), location: clean_line(&i.location, 300), ..i }).collect();
    Ok(AppleAnswer { items, errors })
}

#[cfg(not(target_os = "macos"))]
pub fn apple_items(_from: i64, _to: i64) -> Result<AppleAnswer, String> {
    Err("Apple Calendar is only on a Mac".into())
}

/// A paired computer asks for this Mac's Apple Calendar and Reminders.
pub(super) fn answer_apple(manager: &BridgeLinkManager, body: &str) -> Result<String, String> {
    let request: AppleRequest = serde_json::from_str(body).map_err(|_| "Invalid request".to_string())?;
    if !manager.lock()?.calendar.share_apple {
        return Err("This Mac doesn't share Apple Calendar (turn it on in its Calendar settings)".into());
    }
    if request.to - request.from > 400 * 86_400_000 {
        return Err("Ask for a shorter time span".into());
    }
    serde_json::to_string(&apple_items(request.from, request.to)?).map_err(|e| e.to_string())
}

/// Apple Calendar and Reminders between two times: this Mac's own when it shares them, and every
/// paired Mac's that shares them.
#[tauri::command]
pub async fn calendar_apple(from: i64, to: i64, manager: State<'_, BridgeLinkManager>) -> Result<AppleAnswer, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut answer = AppleAnswer { items: Vec::new(), errors: Vec::new() };
        let (share, name, peers) = {
            let runtime = manager.lock()?;
            let peers: Vec<(String, String, String)> = runtime.paired.values().map(|p| (p.instance_id.clone(), p.name.clone(), p.platform.clone())).collect();
            (runtime.calendar.share_apple, runtime.display_name.clone(), peers)
        };
        if cfg!(target_os = "macos") && share {
            match apple_items(from, to) {
                Ok(mine) => {
                    answer.items.extend(mine.items.into_iter().map(|i| AppleItem { from: name.clone(), ..i }));
                    answer.errors.extend(mine.errors);
                }
                Err(error) => answer.errors.push(error),
            }
        }
        for (id, peer_name, _) in peers.into_iter().filter(|p| p.2 == "macos") {
            match peer::peer_apple_calendar(&manager, &id, from, to) {
                Ok(theirs) => {
                    answer.items.extend(theirs.items.into_iter().map(|i| AppleItem { from: peer_name.clone(), ..i }));
                    answer.errors.extend(theirs.errors.into_iter().map(|e| format!("{peer_name}: {e}")));
                }
                Err(error) if error.contains("doesn't share") => {}
                Err(error) => answer.errors.push(format!("{peer_name}: {error}")),
            }
        }
        Ok(answer)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn calendar_apple_share(share: Option<bool>, manager: State<'_, BridgeLinkManager>) -> Result<bool, String> {
    let mut runtime = manager.lock()?;
    if let Some(share) = share {
        runtime.calendar.share_apple = share && cfg!(target_os = "macos");
        runtime.calendar.save(runtime.storage_dir.as_ref());
    }
    Ok(runtime.calendar.share_apple)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, title: &str) -> Event {
        Event { id: id.into(), title: title.into(), start: 1_000, end: 2_000, ..Default::default() }
    }

    #[test]
    fn the_newer_edit_wins_on_both_computers_and_deletions_spread() {
        let (mut mac, mut pc) = (CalendarStore::default(), CalendarStore::default());
        mac.save_from_ui(event("e1", "Dentist"), "mac", 100).unwrap();
        for e in mac.changes_since(0).events {
            pc.merge(e);
        }
        pc.save_from_ui(event("e1", "Dentist (moved)"), "pc", 200).unwrap();
        mac.save_from_ui(event("e1", "Dentist, older edit"), "mac", 150).unwrap();
        let (from_mac, from_pc) = (mac.changes_since(0).events, pc.changes_since(0).events);
        for e in from_pc {
            mac.merge(e);
        }
        for e in from_mac {
            pc.merge(e);
        }
        assert_eq!(mac.list()[0].title, "Dentist (moved)");
        assert_eq!(pc.list()[0].title, "Dentist (moved)");

        assert!(pc.delete("e1", "pc", 300));
        let since = mac.seq;
        for e in pc.changes_since(0).events {
            mac.merge(e);
        }
        assert!(mac.list().is_empty());
        assert!(mac.seq > since);
        // Merging the same thing again changes nothing.
        for e in pc.changes_since(0).events {
            assert!(!mac.merge(e));
        }
    }

    #[test]
    fn saving_an_unchanged_event_is_not_a_change() {
        let mut store = CalendarStore::default();
        let saved = store.save_from_ui(event("e1", "Gym"), "mac", 100).unwrap();
        let seq = store.seq;
        store.save_from_ui(saved, "mac", 200).unwrap();
        assert_eq!(store.seq, seq);
    }

    #[test]
    fn untrusted_events_are_cleaned() {
        let mut store = CalendarStore::default();
        let messy = Event {
            id: "../x\u{0}".into(),
            title: "a\nb\u{7}".into(),
            start: 10,
            end: 5,
            color: "red;}".into(),
            repeat: Some(Repeat { freq: "hourly".into(), ..Default::default() }),
            reminder: Some(-5),
            ..Default::default()
        };
        assert!(store.merge(messy));
        let e = &store.list()[0];
        assert_eq!(e.id, "x");
        assert_eq!(e.title, "a b");
        assert_eq!(e.end, 10);
        assert_eq!(e.color, "red");
        assert_eq!(e.repeat, None);
        assert_eq!(e.reminder, Some(0));
        let weekly = Event { id: "w".into(), repeat: Some(Repeat { freq: "weekly".into(), interval: 0, days: vec![5, 1, 9, 1], ..Default::default() }), ..Default::default() };
        store.merge(weekly);
        assert_eq!(store.events["w"].repeat.as_ref().unwrap().days, vec![1, 5]);
        assert_eq!(store.events["w"].repeat.as_ref().unwrap().interval, 1);
    }

    #[test]
    fn only_ics_files_are_read_or_written() {
        assert!(calendar_read_ics("/etc/passwd".into()).is_err());
        assert!(calendar_write_ics("/tmp/x.sh".into(), "x".into()).is_err());
        assert!(ics_path("/tmp/Work.ICS").is_ok());
    }
}
