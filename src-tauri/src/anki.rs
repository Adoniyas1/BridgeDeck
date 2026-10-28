//! Anki decks (.apkg) into a course's flashcards. An .apkg is a zip with the collection (SQLite;
//! zstd-compressed in newer Anki versions, `collection.anki21b`) and its media. This reads each
//! note's fields, its cards (which way, suspended or not) and every review, and saves the
//! pictures the notes use into the course's card pictures; the window turns them into card lines
//! and replays the reviews through its own scheduler (deckio.ts).

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
    path::Path,
};

const MAX_APKG: usize = 1024 * 1024 * 1024;
const MAX_ENTRY: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct AnkiReview {
    /// When (ms) and the answer: 1 again, 2 hard, 3 good, 4 easy.
    pub at: i64,
    pub ease: u8,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCard {
    /// Which card of the note: the template (0 front→back, 1 back→front) or the cloze number − 1.
    pub ord: i64,
    pub suspended: bool,
    pub reviews: Vec<AnkiReview>,
}

#[derive(Serialize, Debug)]
pub struct AnkiNote {
    pub fields: Vec<String>,
    pub tags: String,
    pub cards: Vec<AnkiCard>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnkiDeck {
    pub notes: Vec<AnkiNote>,
    /// Pictures the notes use: Anki's name → the file saved with the course's card pictures.
    pub pictures: HashMap<String, String>,
    /// Pictures that couldn't be kept (not PNG, JPEG or WebP, or missing), and sounds.
    pub left_out: usize,
}

fn read_entry(zip: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    if f.size() > MAX_ENTRY {
        return None;
    }
    let mut out = Vec::new();
    f.read_to_end(&mut out).ok()?;
    Some(out)
}

/// zstd-compressed (newer Anki) or not.
fn unzstd(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if !bytes.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) {
        return Ok(bytes);
    }
    let mut out = Vec::new();
    ruzstd::decoding::StreamingDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?.read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *b.get(*i)?;
        *i += 1;
        v |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// The media list: JSON `{"0": "name.png"}` in older decks; in newer ones a protobuf
/// (MediaEntries: repeated entries = 1, each with name = 1), where entry i is file "i".
pub fn media_names(bytes: &[u8]) -> HashMap<String, String> {
    if let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(bytes) {
        return map.into_iter().map(|(file, name)| (name, file)).collect();
    }
    let mut out = HashMap::new();
    let (mut i, mut index) = (0, 0);
    while i < bytes.len() {
        let Some(key) = varint(bytes, &mut i) else { break };
        match key & 7 {
            2 => {
                let Some(len) = varint(bytes, &mut i) else { break };
                let end = i + len as usize;
                if end > bytes.len() {
                    break;
                }
                if key >> 3 == 1 {
                    // One entry: its name is field 1.
                    let entry = &bytes[i..end];
                    let mut j = 0;
                    while j < entry.len() {
                        let Some(k) = varint(entry, &mut j) else { break };
                        match k & 7 {
                            2 => {
                                let Some(l) = varint(entry, &mut j) else { break };
                                let e = (j + l as usize).min(entry.len());
                                if k >> 3 == 1 {
                                    out.insert(String::from_utf8_lossy(&entry[j..e]).into_owned(), index.to_string());
                                }
                                j = e;
                            }
                            0 => { let _ = varint(entry, &mut j); }
                            _ => break,
                        }
                    }
                    index += 1;
                }
                i = end;
            }
            0 => { let _ = varint(bytes, &mut i); }
            _ => break,
        }
    }
    out
}

/// The pictures a field shows: `<img src="name">`.
pub fn pictures_in(field: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = field.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("<img") {
        let tag_start = from + at;
        let tag_end = lower[tag_start..].find('>').map(|e| tag_start + e).unwrap_or(lower.len());
        let tag = &field[tag_start..tag_end];
        if let Some(s) = tag.to_ascii_lowercase().find("src=") {
            let rest = &tag[s + 4..];
            let (q, rest) = match rest.chars().next() { Some(c @ ('"' | '\'')) => (Some(c), &rest[1..]), _ => (None, rest) };
            let end = match q { Some(q) => rest.find(q), None => rest.find(|c: char| c.is_whitespace() || c == '/') }.unwrap_or(rest.len());
            out.push(rest[..end].to_string());
        }
        from = tag_end;
    }
    out
}

/// Reads an .apkg; pictures are saved with `save(name, bytes)` (into the course).
pub fn read_apkg(bytes: &[u8], mut save: impl FnMut(&str, &[u8]) -> Result<String, String>) -> Result<AnkiDeck, String> {
    if bytes.len() > MAX_APKG {
        return Err("That deck is too big".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "That isn't an Anki deck (.apkg)".to_string())?;
    // Newest form first: newer exports also hold an old-style collection saying "update Anki".
    let db = ["collection.anki21b", "collection.anki21", "collection.anki2"].iter().find_map(|n| read_entry(&mut zip, n)).ok_or("No collection in that deck")?;
    let db = unzstd(db)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = std::env::temp_dir().join(format!("bridgedeck-anki-{stamp}.sqlite"));
    std::fs::write(&path, &db).map_err(|e| e.to_string())?;
    let read = (|| -> Result<(Vec<AnkiNote>, HashSet<String>), String> {
        let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
        let q = |e: rusqlite::Error| format!("That deck couldn't be read: {e}");
        let mut reviews: HashMap<i64, Vec<AnkiReview>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT id, cid, ease FROM revlog WHERE ease BETWEEN 1 AND 4 ORDER BY id").map_err(q)?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))).map_err(q)?.flatten() {
            reviews.entry(row.1).or_default().push(AnkiReview { at: row.0, ease: row.2 as u8 });
        }
        let mut cards: HashMap<i64, Vec<AnkiCard>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT id, nid, ord, queue FROM cards ORDER BY nid, ord").map_err(q)?;
        for (id, nid, ord, queue) in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))).map_err(q)?.flatten() {
            cards.entry(nid).or_default().push(AnkiCard { ord, suspended: queue == -1, reviews: reviews.remove(&id).unwrap_or_default() });
        }
        let mut notes = Vec::new();
        let mut wanted = HashSet::new();
        let mut stmt = conn.prepare("SELECT id, flds, tags FROM notes ORDER BY id").map_err(q)?;
        for (id, flds, tags) in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(q)?.flatten() {
            let fields: Vec<String> = flds.split('\u{1f}').map(str::to_string).collect();
            for f in &fields {
                wanted.extend(pictures_in(f));
            }
            notes.push(AnkiNote { fields, tags: tags.trim().to_string(), cards: cards.remove(&id).unwrap_or_default() });
        }
        Ok((notes, wanted))
    })();
    let _ = std::fs::remove_file(&path);
    let (notes, wanted) = read?;
    let names = read_entry(&mut zip, "media").map(unzstd).transpose()?.map(|m| media_names(&m)).unwrap_or_default();
    let mut pictures = HashMap::new();
    let mut left_out = 0;
    for name in wanted {
        let saved = names.get(&name).and_then(|file| read_entry(&mut zip, file)).map(unzstd).and_then(Result::ok).and_then(|bytes| save(&name, &bytes).ok());
        match saved {
            Some(file) => { pictures.insert(name, file); }
            None => left_out += 1,
        }
    }
    left_out += notes.iter().flat_map(|n| &n.fields).map(|f| f.matches("[sound:").count()).sum::<usize>();
    Ok(AnkiDeck { notes, pictures, left_out })
}

/// The deck is the request body; the course comes in `x-course`, URI-encoded.
#[tauri::command]
pub async fn anki_read(request: tauri::ipc::Request<'_>) -> Result<AnkiDeck, String> {
    let course = request.headers().get("x-course").and_then(|v| v.to_str().ok()).and_then(crate::study::percent_decode).ok_or("Missing x-course")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the deck as bytes".into()) };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::study::course_dir_in(&crate::study::current_root()?, &course)?;
        read_apkg(&bytes, |name, data| crate::study::save_card_picture(&dir, name, data))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- A sample deck, for the tests and for checking imports work on this computer ----

/// A small deck: a basic note with a picture, a reversed note reviewed twice, a cloze note with
/// a suspended card, in the old form or the new (zstd, protobuf media list).
pub(crate) fn sample_apkg(new_form: bool) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let path = std::env::temp_dir().join(format!("bd-anki-sample-{}-{new_form}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let conn = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE notes (id integer primary key, flds text, tags text);
        CREATE TABLE cards (id integer primary key, nid integer, ord integer, queue integer);
        CREATE TABLE revlog (id integer primary key, cid integer, ease integer, type integer);").map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO notes VALUES (1, ?1, ' ee ')", ["Ohm's law?<img src=\"ohm.png\">\u{1f}V = I&nbsp;R"]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO notes VALUES (2, ?1, '')", ["Capacitor\u{1f}Stores charge [sound:cap.mp3]"]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO notes VALUES (3, ?1, '')", ["The {{c1::anode}} is {{c2::positive}}\u{1f}"]).map_err(|e| e.to_string())?;
    conn.execute_batch("INSERT INTO cards VALUES (10, 1, 0, 2); INSERT INTO cards VALUES (20, 2, 0, 2); INSERT INTO cards VALUES (21, 2, 1, 0);
        INSERT INTO cards VALUES (30, 3, 0, 0); INSERT INTO cards VALUES (31, 3, 1, -1);
        INSERT INTO revlog VALUES (1700000000000, 20, 3, 0); INSERT INTO revlog VALUES (1700086400000, 20, 1, 1); INSERT INTO revlog VALUES (1700090000000, 20, 0, 4);").map_err(|e| e.to_string())?;
    drop(conn);
    let mut db = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89".to_vec();
    let mut media = br#"{"0": "ohm.png"}"#.to_vec();
    let mut picture = png.clone();
    if new_form {
        db = ruzstd::encoding::compress_to_vec(Cursor::new(db), ruzstd::encoding::CompressionLevel::Fastest);
        picture = ruzstd::encoding::compress_to_vec(Cursor::new(png), ruzstd::encoding::CompressionLevel::Fastest);
        // MediaEntries { entries: [{ name: "ohm.png", size: 33 }] }
        let entry = [&[0x0a, 7][..], b"ohm.png", &[0x10, 33]].concat();
        media = [&[0x0a, entry.len() as u8][..], &entry].concat();
        media = ruzstd::encoding::compress_to_vec(Cursor::new(media), ruzstd::encoding::CompressionLevel::Fastest);
    }
    let mut out = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        let opts = zip::write::SimpleFileOptions::default();
        if new_form {
            zip.start_file("collection.anki2", opts).map_err(|e| e.to_string())?;
            zip.write_all(b"not a deck: please update Anki").map_err(|e| e.to_string())?;
        }
        zip.start_file(if new_form { "collection.anki21b" } else { "collection.anki2" }, opts).map_err(|e| e.to_string())?;
        zip.write_all(&db).map_err(|e| e.to_string())?;
        zip.start_file("media", opts).map_err(|e| e.to_string())?;
        zip.write_all(&media).map_err(|e| e.to_string())?;
        zip.start_file("0", opts).map_err(|e| e.to_string())?;
        zip.write_all(&picture).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(out.into_inner())
}

/// Builds a small deck in both Anki formats and reads it back (Settings → About → Check new features).
#[tauri::command]
pub async fn anki_selftest() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        for new_form in [false, true] {
            let deck = read_apkg(&sample_apkg(new_form)?, |name, _| Ok(name.to_string()))?;
            let reviews: usize = deck.notes.iter().flat_map(|n| &n.cards).map(|c| c.reviews.len()).sum();
            if deck.notes.len() != 3 || reviews != 2 || deck.pictures.len() != 1 {
                return Err(format!("The {} deck read back wrong", if new_form { "new" } else { "old" }));
            }
            out.push(if new_form { "new (zstd)" } else { "old" });
        }
        Ok(format!("Read sample decks in the {} formats: 3 notes, 2 reviews and a picture each.", out.join(" and ")))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_old_and_new_decks_with_cards_reviews_and_pictures() {
        for new_form in [false, true] {
            let mut saved = Vec::new();
            let d = read_apkg(&sample_apkg(new_form).unwrap(), |name, bytes| { saved.push((name.to_string(), bytes.len())); Ok(format!("saved-{name}")) }).unwrap();
            assert_eq!(d.notes.len(), 3, "new form: {new_form}");
            assert_eq!(d.notes[0].fields, vec!["Ohm's law?<img src=\"ohm.png\">", "V = I&nbsp;R"]);
            assert_eq!(d.notes[0].tags, "ee");
            assert_eq!(d.notes[1].cards.len(), 2);
            assert_eq!(d.notes[1].cards[0].reviews, vec![AnkiReview { at: 1700000000000, ease: 3 }, AnkiReview { at: 1700086400000, ease: 1 }]);
            assert!(d.notes[2].cards[1].suspended && !d.notes[2].cards[0].suspended);
            assert_eq!(d.pictures.get("ohm.png").map(String::as_str), Some("saved-ohm.png"));
            assert_eq!(saved, vec![("ohm.png".to_string(), 33)]);
            assert_eq!(d.left_out, 1, "the sound");
        }
    }

    #[test]
    fn finds_pictures_and_refuses_other_files() {
        assert_eq!(pictures_in(r#"a <img src="x.png"> b <IMG SRC='y z.jpg' /> <img src=w.webp>"#), vec!["x.png", "y z.jpg", "w.webp"]);
        assert!(read_apkg(b"not a zip", |_, _| Ok(String::new())).is_err());
    }
}
