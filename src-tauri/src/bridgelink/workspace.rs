//! The AI workspace (roadmap Phase 3): several AI agents on several devices working on shared tasks.
//!
//! - **Agents** say hello to their own computer's BridgeDeck (`POST /ai/agents/hello`) and are shown on
//!   every paired device.
//! - **Rooms** group a task's conversation, participants and to-do items. **Claims** say which agent is
//!   editing which file, so two agents don't change the same file at once.
//! - Each device keeps the whole workspace and pushes its view to its paired devices over the encrypted
//!   link (`/ai/state`) when something changes and every minute. Rooms and claims merge by last update;
//!   a device's agents are whatever that device last reported.
//!
//! Everything here is data. BridgeDeck never runs anything because of workspace content.

use super::*;

const AGENT_ONLINE_MS: u64 = 5 * 60_000;
const REMOTE_STALE_MS: u64 = 3 * 60_000;
const CLAIM_TTL_MS: u64 = 2 * 60 * 60_000;
const MAX_ROOMS: usize = 200;
const MAX_TASKS: usize = 200;
const MAX_CLAIMS: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    pub last_seen: u64,
    /// Filled in when listing: seen recently.
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub local: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub assignee: Option<String>,
    /// "todo" | "doing" | "done"
    pub status: String,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// "open" | "in-progress" | "done"
    pub status: String,
    #[serde(default)]
    pub participants: Vec<String>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    /// Removed rooms are kept (without tasks) so the removal reaches every device.
    #[serde(default)]
    pub removed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub path: String,
    pub agent: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub room: Option<String>,
    pub claimed_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub released: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub agents: Vec<Agent>,
    pub rooms: Vec<Room>,
    pub claims: Vec<Claim>,
}

#[derive(Default)]
pub(super) struct Workspace {
    local_agents: HashMap<String, Agent>,
    /// Keyed by (device id, agent name).
    remote_agents: HashMap<(String, String), Agent>,
    remote_seen: HashMap<String, u64>,
    rooms: HashMap<String, Room>,
    claims: HashMap<String, Claim>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    rooms: Vec<Room>,
    claims: Vec<Claim>,
}

/// Ids from the network must already be clean; a mangled id would create a second copy of a room.
fn exact_id(value: &str) -> Option<String> {
    clean_id(value).filter(|id| id == value)
}

fn clean_status(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value) { value.to_string() } else { fallback.to_string() }
}

/// Paths are compared as written, with `\` treated as `/` so Mac and Windows agents agree.
fn clean_path(path: &str) -> Result<String, String> {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() || path.len() > 400 || path.chars().any(char::is_control) {
        return Err("Invalid file path".into());
    }
    Ok(path)
}

impl Workspace {
    pub(super) fn load(dir: &Path) -> Self {
        let persisted = load_json::<Persisted>(&dir.join("ai-workspace.json")).unwrap_or_default();
        Self {
            rooms: persisted.rooms.into_iter().map(|r| (r.id.clone(), r)).collect(),
            claims: persisted.claims.into_iter().map(|c| (c.path.clone(), c)).collect(),
            ..Default::default()
        }
    }

    fn save(&self, dir: Option<&PathBuf>) {
        let Some(dir) = dir else { return };
        let persisted = Persisted { rooms: self.rooms.values().cloned().collect(), claims: self.claims.values().cloned().collect() };
        if let Ok(raw) = serde_json::to_string(&persisted) {
            let _ = secure_write(&dir.join("ai-workspace.json"), &raw);
        }
    }

    pub(super) fn hello(&mut self, name: &str, status: &str, device_id: &str, device_name: &str, now: u64) -> Agent {
        let name = clean_label(name, "agent");
        let agent = Agent {
            name: name.clone(),
            status: clean_text(status, "", 120),
            device_id: device_id.into(),
            device_name: device_name.into(),
            last_seen: now,
            online: true,
            local: true,
        };
        self.local_agents.insert(name, agent.clone());
        agent
    }

    /// Everything, with `online` worked out for `now`.
    pub(super) fn state(&self, now: u64) -> WorkspaceState {
        let mut agents: Vec<Agent> = self.local_agents.values().cloned().map(|mut a| {
            a.online = now.saturating_sub(a.last_seen) < AGENT_ONLINE_MS;
            a.local = true;
            a
        }).collect();
        agents.extend(self.remote_agents.values().cloned().map(|mut a| {
            let device_fresh = self.remote_seen.get(&a.device_id).is_some_and(|at| now.saturating_sub(*at) < REMOTE_STALE_MS);
            a.online = device_fresh && now.saturating_sub(a.last_seen) < AGENT_ONLINE_MS;
            a.local = false;
            a
        }));
        agents.sort_by(|a, b| b.online.cmp(&a.online).then(a.name.cmp(&b.name)));
        let mut rooms: Vec<Room> = self.rooms.values().filter(|r| !r.removed).cloned().collect();
        rooms.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut claims: Vec<Claim> = self.claims.values().filter(|c| !c.released && now.saturating_sub(c.updated_at) < CLAIM_TTL_MS).cloned().collect();
        claims.sort_by(|a, b| a.path.cmp(&b.path));
        WorkspaceState { agents, rooms, claims }
    }

    /// What this device tells its paired devices: its own agents, and every room and claim it knows.
    fn wire(&self) -> WorkspaceState {
        WorkspaceState {
            agents: self.local_agents.values().cloned().collect(),
            rooms: self.rooms.values().cloned().collect(),
            claims: self.claims.values().cloned().collect(),
        }
    }

    /// Merges a paired device's view. Returns true when rooms or claims changed.
    pub(super) fn merge(&mut self, device_id: &str, device_name: &str, state: WorkspaceState, now: u64) -> bool {
        self.remote_agents.retain(|(device, _), _| device != device_id);
        for agent in state.agents.into_iter().take(50) {
            let name = clean_label(&agent.name, "agent");
            self.remote_agents.insert((device_id.to_string(), name.clone()), Agent {
                name,
                status: clean_text(&agent.status, "", 120),
                device_id: device_id.into(),
                device_name: device_name.into(),
                last_seen: agent.last_seen.min(now),
                online: false,
                local: false,
            });
        }
        self.remote_seen.insert(device_id.to_string(), now);
        let mut changed = false;
        for room in state.rooms.into_iter().take(MAX_ROOMS) {
            let Some(id) = exact_id(&room.id) else { continue };
            let newer = self.rooms.get(&id).is_none_or(|existing| room.updated_at > existing.updated_at);
            if newer {
                self.rooms.insert(id.clone(), sanitize_room(room, &id));
                changed = true;
            }
        }
        for claim in state.claims.into_iter().take(MAX_CLAIMS) {
            let Ok(path) = clean_path(&claim.path) else { continue };
            let newer = self.claims.get(&path).is_none_or(|existing| claim.updated_at > existing.updated_at);
            if newer {
                self.claims.insert(path.clone(), Claim { path, agent: clean_label(&claim.agent, "agent"), device_name: clean_text(&claim.device_name, "", 64), room: claim.room.as_deref().and_then(clean_id), ..claim });
                changed = true;
            }
        }
        changed
    }

    pub(super) fn create_room(&mut self, title: &str, author: &str, participants: Vec<String>, now: u64) -> Result<Room, String> {
        if self.rooms.len() >= MAX_ROOMS {
            // Forget removals everyone has had a week to hear about.
            self.rooms.retain(|_, r| !r.removed || now.saturating_sub(r.updated_at) < 7 * 24 * 60 * 60_000);
        }
        if self.rooms.len() >= MAX_ROOMS {
            return Err("Too many rooms; mark finished ones done and remove them".into());
        }
        let title = clean_text(title, "", 120);
        if title.is_empty() {
            return Err("A room needs a title".into());
        }
        let mut participants: Vec<String> = participants.iter().map(|p| clean_label(p, "agent")).collect();
        let author = clean_label(author, "human");
        if !participants.contains(&author) {
            participants.insert(0, author.clone());
        }
        participants.dedup();
        let room = Room { id: Uuid::new_v4().to_string(), title, created_by: author, created_at: now, updated_at: now, status: "open".into(), participants, tasks: Vec::new(), removed: false };
        self.rooms.insert(room.id.clone(), room.clone());
        Ok(room)
    }

    pub(super) fn update_room(&mut self, id: &str, title: Option<&str>, status: Option<&str>, participants: Option<Vec<String>>, now: u64) -> Result<Room, String> {
        let room = self.rooms.get_mut(id).filter(|r| !r.removed).ok_or("Room not found")?;
        if let Some(title) = title.map(|t| clean_text(t, "", 120)).filter(|t| !t.is_empty()) {
            room.title = title;
        }
        if let Some(status) = status {
            room.status = clean_status(status, &["open", "in-progress", "done"], &room.status.clone());
        }
        if let Some(participants) = participants {
            room.participants = participants.iter().map(|p| clean_label(p, "agent")).collect();
            room.participants.dedup();
        }
        room.updated_at = now;
        Ok(room.clone())
    }

    pub(super) fn remove_room(&mut self, id: &str, now: u64) -> bool {
        let Some(room) = self.rooms.get_mut(id) else { return false };
        room.removed = true;
        room.tasks.clear();
        room.participants.clear();
        room.updated_at = now;
        true
    }

    pub(super) fn add_task(&mut self, room_id: &str, title: &str, assignee: Option<&str>, now: u64) -> Result<Task, String> {
        let room = self.rooms.get_mut(room_id).filter(|r| !r.removed).ok_or("Room not found")?;
        if room.tasks.len() >= MAX_TASKS {
            return Err("This room has too many tasks".into());
        }
        let title = clean_text(title, "", 200);
        if title.is_empty() {
            return Err("A task needs a title".into());
        }
        let task = Task { id: Uuid::new_v4().to_string(), title, assignee: assignee.filter(|a| !a.trim().is_empty()).map(|a| clean_label(a, "agent")), status: "todo".into(), updated_at: now };
        room.tasks.push(task.clone());
        room.updated_at = now;
        Ok(task)
    }

    pub(super) fn update_task(&mut self, room_id: &str, task_id: &str, status: Option<&str>, assignee: Option<Option<&str>>, title: Option<&str>, now: u64) -> Result<Task, String> {
        let room = self.rooms.get_mut(room_id).ok_or("Room not found")?;
        let task = room.tasks.iter_mut().find(|t| t.id == task_id).ok_or("Task not found")?;
        if let Some(status) = status {
            task.status = clean_status(status, &["todo", "doing", "done"], &task.status.clone());
        }
        if let Some(assignee) = assignee {
            task.assignee = assignee.filter(|a| !a.trim().is_empty()).map(|a| clean_label(a, "agent"));
        }
        if let Some(title) = title.map(|t| clean_text(t, "", 200)).filter(|t| !t.is_empty()) {
            task.title = title;
        }
        task.updated_at = now;
        let task = task.clone();
        room.updated_at = now;
        Ok(task)
    }

    /// Claims `path` for `agent`. Fails while another agent holds an active claim on it.
    pub(super) fn claim(&mut self, path: &str, agent: &str, room: Option<&str>, device_id: &str, device_name: &str, now: u64) -> Result<Claim, String> {
        let path = clean_path(path)?;
        let agent = clean_label(agent, "agent");
        if let Some(existing) = self.claims.get(&path) {
            let active = !existing.released && now.saturating_sub(existing.updated_at) < CLAIM_TTL_MS;
            if active && existing.agent != agent {
                return Err(format!("{path} is being edited by {} on {}", existing.agent, if existing.device_name.is_empty() { "another device" } else { &existing.device_name }));
            }
        }
        if self.claims.len() >= MAX_CLAIMS {
            self.claims.retain(|_, c| !c.released && now.saturating_sub(c.updated_at) < CLAIM_TTL_MS);
        }
        let claim = Claim { path: path.clone(), agent, device_id: device_id.into(), device_name: device_name.into(), room: room.and_then(clean_id), claimed_at: now, updated_at: now, released: false };
        self.claims.insert(path, claim.clone());
        Ok(claim)
    }

    /// Releases a claim. `agent: None` lets the person at the computer release anyone's claim.
    pub(super) fn release(&mut self, path: &str, agent: Option<&str>, now: u64) -> Result<(), String> {
        let path = clean_path(path)?;
        let claim = self.claims.get_mut(&path).ok_or("That file isn't claimed")?;
        if let Some(agent) = agent {
            if claim.agent != clean_label(agent, "agent") {
                return Err(format!("{path} is claimed by {}, not {agent}", claim.agent));
            }
        }
        claim.released = true;
        claim.updated_at = now;
        Ok(())
    }
}

fn sanitize_room(room: Room, id: &str) -> Room {
    Room {
        id: id.to_string(),
        title: clean_text(&room.title, "Untitled", 120),
        created_by: clean_label(&room.created_by, "agent"),
        status: clean_status(&room.status, &["open", "in-progress", "done"], "open"),
        participants: room.participants.iter().take(50).map(|p| clean_label(p, "agent")).collect(),
        tasks: room
            .tasks
            .into_iter()
            .take(MAX_TASKS)
            .filter_map(|t| {
                let id = exact_id(&t.id)?;
                Some(Task { id, title: clean_text(&t.title, "Task", 200), assignee: t.assignee.as_deref().map(|a| clean_label(a, "agent")), status: clean_status(&t.status, &["todo", "doing", "done"], "todo"), updated_at: t.updated_at })
            })
            .collect(),
        ..room
    }
}

/// Whether `message` is for `agent`: not written by it, and addressed to everyone or to it.
pub(super) fn is_for(message: &AiMessage, agent: &str) -> bool {
    message.author != agent && (message.to.is_empty() || message.to.iter().any(|to| to == agent))
}

/// Saves after a local change and tells the paired devices.
pub(super) fn changed(manager: &BridgeLinkManager) {
    if let Ok(runtime) = manager.lock() {
        runtime.workspace.save(runtime.storage_dir.as_ref());
    }
    let manager = manager.clone();
    thread::spawn(move || push(&manager));
}

/// Sends this device's workspace view to every paired device (best effort).
pub(super) fn push(manager: &BridgeLinkManager) {
    let (peers, body) = match manager.lock() {
        Ok(runtime) => (runtime.paired.keys().cloned().collect::<Vec<_>>(), serde_json::to_string(&runtime.workspace.wire()).unwrap_or_default()),
        Err(_) => return,
    };
    for peer in peers {
        let _ = peer::push_workspace(manager, &peer, body.clone());
    }
}

/// A paired device's view arrived.
pub(super) fn receive(manager: &BridgeLinkManager, device_id: &str, device_name: &str, body: &str) -> Result<(), String> {
    let state = serde_json::from_str::<WorkspaceState>(body).map_err(|_| "Invalid workspace".to_string())?;
    let mut runtime = manager.lock()?;
    if runtime.workspace.merge(device_id, device_name, state, now_ms()) {
        runtime.workspace.save(runtime.storage_dir.as_ref());
        if let Some(app) = runtime.app.clone() {
            use tauri::Emitter;
            let _ = app.emit("ai-workspace", ());
        }
    }
    Ok(())
}

/// Runs a workspace change made by the person at this computer, then saves and pushes it.
fn local_change<T>(manager: &BridgeLinkManager, change: impl FnOnce(&mut Workspace, &str, &str, u64) -> Result<T, String>) -> Result<T, String> {
    let value = {
        let mut runtime = manager.lock()?;
        let (device_id, device_name) = (runtime.instance_id.clone(), runtime.display_name.clone());
        change(&mut runtime.workspace, &device_id, &device_name, now_ms())?
    };
    changed(manager);
    Ok(value)
}

#[tauri::command]
pub fn ai_workspace(manager: State<'_, BridgeLinkManager>) -> Result<WorkspaceState, String> {
    Ok(manager.lock()?.workspace.state(now_ms()))
}

#[tauri::command]
pub fn ai_room_create(title: String, participants: Vec<String>, manager: State<'_, BridgeLinkManager>) -> Result<Room, String> {
    local_change(&manager, |ws, _, _, now| ws.create_room(&title, "human", participants, now))
}

#[tauri::command]
pub fn ai_room_update(room: String, title: Option<String>, status: Option<String>, participants: Option<Vec<String>>, manager: State<'_, BridgeLinkManager>) -> Result<Room, String> {
    local_change(&manager, |ws, _, _, now| ws.update_room(&room, title.as_deref(), status.as_deref(), participants, now))
}

/// Removes a room on every device.
#[tauri::command]
pub fn ai_room_remove(room: String, manager: State<'_, BridgeLinkManager>) -> Result<bool, String> {
    local_change(&manager, |ws, _, _, now| Ok(ws.remove_room(&room, now)))
}

#[tauri::command]
pub fn ai_task_add(room: String, title: String, assignee: Option<String>, manager: State<'_, BridgeLinkManager>) -> Result<Task, String> {
    local_change(&manager, |ws, _, _, now| ws.add_task(&room, &title, assignee.as_deref(), now))
}

#[tauri::command]
pub fn ai_task_update(room: String, task: String, status: Option<String>, assignee: Option<String>, title: Option<String>, manager: State<'_, BridgeLinkManager>) -> Result<Task, String> {
    local_change(&manager, |ws, _, _, now| ws.update_task(&room, &task, status.as_deref(), assignee.as_deref().map(Some), title.as_deref(), now))
}

/// The person at this computer can release any agent's claim (for example one left by a crashed agent).
#[tauri::command]
pub fn ai_claim_release(path: String, manager: State<'_, BridgeLinkManager>) -> Result<(), String> {
    local_change(&manager, |ws, _, _, now| ws.release(&path, None, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_merge_by_last_update() {
        let (mut a, mut b) = (Workspace::default(), Workspace::default());
        let room = a.create_room("Ship 0.9", "claude-mac", vec!["codex-win".into()], 100).unwrap();
        assert_eq!(room.participants, vec!["claude-mac", "codex-win"]);
        assert!(b.merge("mac", "Mac", a.wire(), 110));
        assert_eq!(b.state(110).rooms[0].title, "Ship 0.9");
        // Both change it; the later change wins everywhere.
        b.update_room(&room.id, None, Some("in-progress"), None, 200).unwrap();
        a.update_room(&room.id, Some("Ship 0.9.0"), None, None, 150).unwrap();
        assert!(!b.merge("mac", "Mac", a.wire(), 210), "older change is ignored");
        assert!(a.merge("win", "Windows", b.wire(), 220));
        assert_eq!(a.state(220).rooms[0].status, "in-progress");
        // Removing it on one device removes it everywhere.
        assert!(b.remove_room(&room.id, 300));
        assert!(a.merge("win", "Windows", b.wire(), 310));
        assert!(a.state(310).rooms.is_empty());
        assert!(a.add_task(&room.id, "late", None, 320).is_err());
    }

    #[test]
    fn tasks_live_in_rooms() {
        let mut w = Workspace::default();
        let room = w.create_room("Plan", "human", vec![], 1).unwrap();
        let task = w.add_task(&room.id, "Write tests", Some("claude-mac"), 2).unwrap();
        w.update_task(&room.id, &task.id, Some("done"), None, None, 3).unwrap();
        let room = &w.state(3).rooms[0];
        assert_eq!(room.tasks[0].status, "done");
        assert_eq!(room.tasks[0].assignee.as_deref(), Some("claude-mac"));
        assert!(w.update_task(&room.id, "nope", Some("done"), None, None, 4).is_err());
    }

    #[test]
    fn claims_block_other_agents_until_released_or_expired() {
        let mut w = Workspace::default();
        w.claim("src\\App.tsx", "claude-mac", None, "mac", "Mac", 1).unwrap();
        let error = w.claim("src/App.tsx", "codex-win", None, "win", "Windows", 2).unwrap_err();
        assert!(error.contains("claude-mac"), "{error}");
        assert!(w.claim("src/App.tsx", "claude-mac", None, "mac", "Mac", 3).is_ok(), "the owner can renew");
        assert!(w.release("src/App.tsx", Some("codex-win"), 4).is_err());
        w.release("src/App.tsx", Some("claude-mac"), 5).unwrap();
        assert!(w.claim("src/App.tsx", "codex-win", None, "win", "Windows", 6).is_ok());
        // Expired claims don't block.
        assert!(w.claim("src/App.tsx", "claude-mac", None, "mac", "Mac", 6 + CLAIM_TTL_MS).is_ok());
    }

    #[test]
    fn remote_agents_come_and_go_with_their_device() {
        let (mut mac, mut win) = (Workspace::default(), Workspace::default());
        mac.hello("claude-mac", "working on sync", "mac", "Mac", 1_000);
        win.merge("mac", "Mac", mac.wire(), 1_000);
        let agent = win.state(1_000).agents.into_iter().find(|a| a.name == "claude-mac").unwrap();
        assert!(agent.online && !agent.local);
        assert_eq!(agent.device_name, "Mac");
        // No word from the Mac for a while: its agents show as offline.
        assert!(!win.state(1_000 + REMOTE_STALE_MS + 1).agents[0].online);
        // The device's report replaces its agent list.
        win.merge("mac", "Mac", WorkspaceState::default(), 2_000);
        assert!(win.state(2_000).agents.is_empty());
    }

    #[test]
    fn untrusted_input_is_cleaned() {
        let mut w = Workspace::default();
        let evil = WorkspaceState {
            agents: vec![Agent { name: "ev il\n<b>".into(), status: "x".repeat(500), device_id: "spoof".into(), device_name: "Spoof".into(), last_seen: u64::MAX, online: true, local: true }],
            rooms: vec![Room { id: "bad id!".into(), title: "t".into(), created_by: "a".into(), created_at: 0, updated_at: 1, status: "hacked".into(), participants: vec![], tasks: vec![], removed: false }],
            claims: vec![],
        };
        w.merge("win", "Windows", evil, 10);
        let state = w.state(10);
        assert_eq!(state.agents[0].name, "evilb");
        assert_eq!(state.agents[0].device_name, "Windows", "device comes from the pairing, not the payload");
        assert!(state.agents[0].last_seen <= 10);
        assert!(state.rooms.is_empty(), "invalid room ids are dropped");
    }

    #[test]
    fn messages_are_for_everyone_or_their_recipients() {
        let base = AiMessage { id: "1".into(), channel: "c".into(), author: "claude-mac".into(), body: "b".into(), reply_to: None, direction: "in".into(), peer_instance_id: String::new(), peer_name: String::new(), created_at: 1, pending: false, to: vec![], room: None };
        assert!(is_for(&base, "codex-win"));
        assert!(!is_for(&base, "claude-mac"), "not your own messages");
        let addressed = AiMessage { to: vec!["codex-win".into()], ..base };
        assert!(is_for(&addressed, "codex-win"));
        assert!(!is_for(&addressed, "claude-win"));
    }
}
