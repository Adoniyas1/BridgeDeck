//! Skill packs for Mimir: folders of skills in the SKILL.md format (instructions, references and
//! small stdlib-only Python scripts) from alirezarezvani/claude-skills (MIT), downloaded at a pinned
//! commit and unpacked into BridgeDeck's app data. Only the packs chosen in Settings are kept.
//! Mimir finds them through `MIMIR_SKILL_PACKS`, reads a skill's instructions when a task calls for
//! it, and runs its scripts in its Pyodide sandbox (no file system or shell access).

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub const SOURCE: &str = "alirezarezvani/claude-skills";
/// The commit the packs come from. Moving it is a reviewed change, never automatic.
pub const COMMIT: &str = "19392f7a08264ed00486a251f5b2098321771f94";
const STATE_FILE: &str = "packs.json";
const MAX_ARCHIVE: u64 = 200 * 1024 * 1024;
const MAX_FILE: u64 = 8 * 1024 * 1024;

/// The packs offered: (folder in the repository, title, what it's for, skills at `COMMIT`).
pub const CATALOG: &[(&str, &str, &str, u32)] = &[
    ("productivity", "Productivity", "Planning, reflection, decisions and personal workflows", 12),
    ("research", "Research", "Literature reviews, source evaluation and research methods", 10),
    ("project-management", "Project management", "Plans, roadmaps, risks, status reports and retrospectives", 9),
    ("engineering", "Engineering", "Architecture, code review, testing, debugging and tooling", 93),
    ("engineering-team", "Engineering team", "Roles across a software team: frontend, backend, QA, DevOps, security", 53),
    ("product-team", "Product", "Product strategy, discovery, specs and UX research", 17),
    ("research-ops", "Research operations", "Running studies, interviews and synthesis", 5),
    ("finance", "Finance", "Financial analysis, models and reporting", 5),
    ("business-growth", "Business growth", "Growth, customer success and sales", 5),
    ("business-operations", "Business operations", "Operations, processes and vendors", 7),
    ("marketing-skill", "Marketing", "Content, SEO, campaigns and brand", 49),
    ("c-level-advisor", "Executive advisor", "Strategy and leadership advice by role (CEO, CTO, CFO…)", 46),
    ("compliance-os", "Compliance", "Policies, audits and regulatory checklists", 9),
    ("ra-qm-team", "Regulatory and quality", "Medical-device regulatory affairs and quality management", 19),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackState {
    pub source: String,
    pub commit: String,
    pub installed: Vec<String>,
    pub installed_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub skills: u32,
    pub installed: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PacksStatus {
    pub source: String,
    pub commit: String,
    pub folder: String,
    pub packs: Vec<PackInfo>,
    /// Installed from an older pinned commit; installing again updates them.
    pub outdated: bool,
}

pub fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("skill-packs"))
}

pub fn read_state(dir: &Path) -> PackState {
    fs::read(dir.join(STATE_FILE)).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
}

pub fn status(dir: &Path) -> PacksStatus {
    let state = read_state(dir);
    PacksStatus {
        source: SOURCE.into(),
        commit: COMMIT.into(),
        folder: dir.to_string_lossy().to_string(),
        packs: CATALOG.iter().map(|(id, title, description, skills)| PackInfo { id: (*id).into(), title: (*title).into(), description: (*description).into(), skills: *skills, installed: state.installed.iter().any(|i| i == id) && dir.join(id).is_dir() }).collect(),
        outdated: !state.installed.is_empty() && state.commit != COMMIT,
    }
}

/// The path inside the archive, without its top folder (`claude-skills-<commit>/`), if it is
/// a plain relative path inside one of `packs`.
fn wanted_path(raw: &Path, packs: &[String]) -> Option<PathBuf> {
    let mut parts = raw.components();
    parts.next()?; // the archive's top folder
    let rest: PathBuf = parts.as_path().to_path_buf();
    if rest.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let first = rest.components().next()?.as_os_str().to_string_lossy().to_string();
    // The repository's licence travels with the packs (MIT asks for its notice to be kept).
    (packs.contains(&first) || rest == Path::new("LICENSE")).then_some(rest)
}

/// Unpacks the chosen packs from a `.tar.gz` of the repository into `dir/<pack>/`, replacing what
/// was there. Links, special files and very large files are left out.
pub fn unpack(archive: impl Read, dir: &Path, packs: &[String]) -> Result<usize, String> {
    let staging = dir.join(".incoming");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = unpack_into(archive, dir, &staging, packs);
    let _ = fs::remove_dir_all(&staging);
    result
}

fn unpack_into(archive: impl Read, dir: &Path, staging: &Path, packs: &[String]) -> Result<usize, String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    let mut count = 0;
    for entry in tar.entries().map_err(|e| format!("The download isn't a valid archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("The download is damaged: {e}"))?;
        if !entry.header().entry_type().is_file() || entry.size() > MAX_FILE {
            continue;
        }
        let Some(rel) = entry.path().ok().and_then(|p| wanted_path(&p, packs)) else { continue };
        let target = staging.join(&rel);
        fs::create_dir_all(target.parent().unwrap_or(staging)).map_err(|e| e.to_string())?;
        let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        count += 1;
    }
    if count == 0 {
        return Err("No skills were found in the download".into());
    }
    // Swap in the new packs and drop the ones no longer chosen.
    for (id, ..) in CATALOG {
        let _ = fs::remove_dir_all(dir.join(id));
    }
    if staging.join("LICENSE").is_file() {
        fs::rename(staging.join("LICENSE"), dir.join("LICENSE")).map_err(|e| e.to_string())?;
    }
    for pack in packs {
        if staging.join(pack).is_dir() {
            fs::rename(staging.join(pack), dir.join(pack)).map_err(|e| e.to_string())?;
        }
    }
    Ok(count)
}

fn save_state(dir: &Path, packs: &[String]) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let state = PackState { source: SOURCE.into(), commit: COMMIT.into(), installed: packs.to_vec(), installed_at: now };
    fs::write(dir.join(STATE_FILE), serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn download(dir: &Path, packs: &[String]) -> Result<usize, String> {
    let url = format!("https://codeload.github.com/{SOURCE}/tar.gz/{COMMIT}");
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .map_err(|e| format!("Couldn't download the skill packs: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {} for the skill packs", response.status()));
    }
    unpack(response.take(MAX_ARCHIVE), dir, packs)
}

// ---- Commands ----

#[tauri::command]
pub fn skill_packs_status(app: AppHandle) -> Result<PacksStatus, String> {
    Ok(status(&packs_dir(&app)?))
}

/// Keeps exactly `packs` (downloading them at the pinned commit); an empty list removes all.
#[tauri::command]
pub async fn skill_packs_install(app: AppHandle, packs: Vec<String>) -> Result<PacksStatus, String> {
    let dir = packs_dir(&app)?;
    let packs: Vec<String> = packs.into_iter().filter(|p| CATALOG.iter().any(|(id, ..)| id == p)).collect();
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if packs.is_empty() {
            for (id, ..) in CATALOG {
                let _ = fs::remove_dir_all(dir.join(id));
            }
        } else {
            download(&dir, &packs)?;
        }
        save_state(&dir, &packs)?;
        Ok(status(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(files: &[(&str, &[u8])], link: Option<(&str, &str)>) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *data).unwrap();
        }
        if let Some((path, target)) = link {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            builder.append_link(&mut header, path, target).unwrap();
        }
        let mut gz = builder.into_inner().unwrap();
        gz.flush().unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn only_the_chosen_packs_are_unpacked_and_nothing_escapes_the_folder() {
        let dir = std::env::temp_dir().join(format!("bd-packs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("finance")).unwrap();
        fs::write(dir.join("finance/old.md"), "old").unwrap();
        let top = format!("claude-skills-{COMMIT}");
        let data = archive(&[
            (&format!("{top}/README.md"), b"repo readme"),
            (&format!("{top}/LICENSE"), b"MIT License"),
            (&format!("{top}/productivity/reflect/skills/reflect/SKILL.md"), b"---\nname: reflect\n---\nBody"),
            (&format!("{top}/productivity/reflect/skills/reflect/scripts/tool.py"), b"print(1)"),
            (&format!("{top}/research/lit/SKILL.md"), b"---\nname: lit\n---"),
            (&format!("{top}/marketing-skill/seo/SKILL.md"), b"not chosen"),
        ], Some((&format!("{top}/productivity/escape"), "/etc/passwd")));
        let packs = vec!["productivity".to_string(), "research".to_string()];
        assert_eq!(unpack(&data[..], &dir, &packs).unwrap(), 4);
        assert_eq!(fs::read_to_string(dir.join("LICENSE")).unwrap(), "MIT License");
        assert!(dir.join("productivity/reflect/skills/reflect/scripts/tool.py").is_file());
        assert!(dir.join("research/lit/SKILL.md").is_file());
        assert!(!dir.join("marketing-skill").exists() && !dir.join("README.md").exists());
        assert!(!dir.join("productivity/escape").exists(), "links are left out");
        assert!(!dir.join("finance").exists(), "packs no longer chosen are removed");
        assert!(wanted_path(Path::new("top/../productivity/x"), &packs).is_none());
        assert!(unpack(&b"not gzip"[..], &dir, &packs).is_err());
        assert!(dir.join("productivity").is_dir(), "a failed download leaves the installed packs alone");
        assert!(!dir.join(".incoming").exists());

        save_state(&dir, &packs).unwrap();
        let shown = status(&dir);
        assert_eq!(shown.packs.iter().filter(|p| p.installed).map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["productivity", "research"]);
        assert!(!shown.outdated);
        let _ = fs::remove_dir_all(dir);
    }

    /// With BD_SKILLS_ARCHIVE pointing at a real download, checks the catalog against it.
    #[test]
    fn the_catalog_matches_a_real_archive_when_one_is_given() {
        let Ok(path) = std::env::var("BD_SKILLS_ARCHIVE") else { return };
        let dir = std::env::temp_dir().join(format!("bd-packs-real-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let packs: Vec<String> = CATALOG.iter().map(|(id, ..)| id.to_string()).collect();
        unpack(fs::File::open(path).unwrap(), &dir, &packs).unwrap();
        for (id, _, _, skills) in CATALOG {
            let mut found = 0;
            let mut stack = vec![dir.join(id)];
            while let Some(d) = stack.pop() {
                for e in fs::read_dir(&d).unwrap().flatten() {
                    if e.file_type().unwrap().is_dir() { stack.push(e.path()) } else if e.file_name() == "SKILL.md" { found += 1 }
                }
            }
            assert_eq!(found, *skills, "{id}");
        }
        let _ = fs::remove_dir_all(dir);
    }
}
