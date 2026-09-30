//! Reads the Mac's Contacts database directly (read-only), so names and photos show in Messages
//! without the Contacts framework. Covers every account (iCloud, On My Mac, Exchange): each is an
//! `AddressBook-v22.abcddb` under `~/Library/Application Support/AddressBook/Sources/<id>/`.
//! Needs the same Full Disk Access as chat.db. Editing goes through the Contacts app (`save_apple_contact`).

use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{collections::HashMap, path::{Path, PathBuf}};

/// Photos larger than this are left out (the list is sent to other devices).
const MAX_AVATAR_BYTES: usize = 48 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub address: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    /// The Contacts app's id, "<UUID>:ABPerson".
    pub id: String,
    pub first_name: String,
    pub last_name: String,
    pub nickname: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub phone_numbers: Vec<Address>,
    pub emails: Vec<Address>,
}

/// Every Contacts database for this user.
pub fn databases(home: &Path) -> Vec<PathBuf> {
    let root = home.join("Library/Application Support/AddressBook");
    let mut found = vec![root.join("AddressBook-v22.abcddb")];
    if let Ok(entries) = std::fs::read_dir(root.join("Sources")) {
        found.extend(entries.flatten().map(|e| e.path().join("AddressBook-v22.abcddb")));
    }
    found.into_iter().filter(|p| p.is_file()).collect()
}

/// Contacts from one database.
pub fn read(db: &Connection) -> rusqlite::Result<Vec<Contact>> {
    let mut phones: HashMap<i64, Vec<Address>> = HashMap::new();
    let mut statement = db.prepare("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL ORDER BY ZORDERINGINDEX")?;
    for row in statement.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (owner, address) = row?;
        phones.entry(owner).or_default().push(Address { address });
    }
    let mut emails: HashMap<i64, Vec<Address>> = HashMap::new();
    let mut statement = db.prepare("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL ORDER BY ZORDERINGINDEX")?;
    for row in statement.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (owner, address) = row?;
        emails.entry(owner).or_default().push(Address { address });
    }
    let mut statement = db.prepare(
        "SELECT Z_PK, ZUNIQUEID, COALESCE(ZFIRSTNAME, ''), COALESCE(ZLASTNAME, ''), COALESCE(ZNICKNAME, ''), COALESCE(ZORGANIZATION, ''), ZTHUMBNAILIMAGEDATA
         FROM ZABCDRECORD WHERE ZUNIQUEID LIKE '%:ABPerson'",
    )?;
    let rows = statement.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, Option<Vec<u8>>>(6)?))
    })?;
    let mut contacts = Vec::new();
    for row in rows {
        let (pk, id, first_name, last_name, nickname, organization, thumbnail) = row?;
        let phone_numbers = phones.remove(&pk).unwrap_or_default();
        let emails = emails.remove(&pk).unwrap_or_default();
        if phone_numbers.is_empty() && emails.is_empty() {
            continue; // nothing Messages could match
        }
        let name = format!("{first_name} {last_name}").trim().to_string();
        let display_name = if name.is_empty() { organization } else { name };
        contacts.push(Contact { id, first_name, last_name, nickname, display_name, avatar: thumbnail.as_deref().and_then(avatar), phone_numbers, emails });
    }
    Ok(contacts)
}

/// Contacts stores thumbnails as JPEG, sometimes after a one-byte header.
fn avatar(data: &[u8]) -> Option<String> {
    let jpeg = data.windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]).map(|at| &data[at..])?;
    (jpeg.len() <= MAX_AVATAR_BYTES).then(|| base64::engine::general_purpose::STANDARD.encode(jpeg))
}

/// All contacts from every account, without duplicates.
pub fn all(home: &Path) -> Result<Vec<Contact>, String> {
    let paths = databases(home);
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = std::collections::HashSet::new();
    let mut contacts = Vec::new();
    let mut last_error = None;
    for path in paths {
        let result = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).and_then(|db| read(&db));
        match result {
            Ok(list) => contacts.extend(list.into_iter().filter(|c| seen.insert(c.id.clone()))),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    match (contacts.is_empty(), last_error) {
        (true, Some(error)) => Err(format!("Could not read Contacts: {error}")),
        _ => Ok(contacts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contacts_with_numbers_emails_and_photos() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZUNIQUEID TEXT, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZTHUMBNAILIMAGEDATA BLOB);
             CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZORDERINGINDEX INTEGER);
             CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZORDERINGINDEX INTEGER);
             INSERT INTO ZABCDRECORD VALUES (1, 'AAAA-1:ABPerson', 'Ada', 'Lovelace', NULL, NULL, X'01FFD8FFE000104A464946');
             INSERT INTO ZABCDRECORD VALUES (2, 'BBBB-2:ABPerson', NULL, NULL, NULL, 'Acme Dentist', NULL);
             INSERT INTO ZABCDRECORD VALUES (3, 'CCCC-3:ABPerson', 'No', 'Numbers', NULL, NULL, NULL);
             INSERT INTO ZABCDRECORD VALUES (4, 'DDDD-4:ABGroup', 'Family', NULL, NULL, NULL, NULL);
             INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+1 (555) 123-4567', 0), (2, 2, '555-0100', 0), (3, 4, '1', 0);
             INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'ada@example.com', 0);",
        )
        .unwrap();
        let list = read(&db).unwrap();
        assert_eq!(list.len(), 2, "people without numbers or emails, and groups, are skipped");
        let ada = &list[0];
        assert_eq!(ada.id, "AAAA-1:ABPerson");
        assert_eq!(ada.display_name, "Ada Lovelace");
        assert_eq!(ada.phone_numbers[0].address, "+1 (555) 123-4567");
        assert_eq!(ada.emails[0].address, "ada@example.com");
        assert!(ada.avatar.as_deref().unwrap().starts_with("/9j/"), "JPEG without the header byte");
        assert_eq!(list[1].display_name, "Acme Dentist");
        let json = serde_json::to_value(&list[1]).unwrap();
        assert!(json.get("avatar").is_none() && json.get("phoneNumbers").is_some());
    }
}
