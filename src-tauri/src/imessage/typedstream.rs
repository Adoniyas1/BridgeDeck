//! Text from `message.attributedBody`: an `NSAttributedString` archived with `NSArchiver`
//! ("typedstream"). Since macOS Ventura, Messages often leaves `message.text` empty and keeps the
//! text only here.
//!
//! BridgeDeck's own decoder (D11: the common open-source one is GPL). It doesn't parse the whole
//! archive: the string is the first `NSString`/`NSMutableString` object, written as the type
//! encoding `+` (a C string with a length) followed by the length and the UTF-8 bytes:
//!
//! ```text
//! … 84 84 84 08 "NSString" 01 94 84 01 2B <length> <bytes> 86 …
//! ```
//!
//! Lengths use typedstream's integer encoding: one signed byte, or 0x81 + i16 LE, or 0x82 + i32 LE.

const TAG_I16: u8 = 0x81;
const TAG_I32: u8 = 0x82;
/// "new type" tag, type-string length 1, `+`.
const STRING_TYPE: [u8; 3] = [0x84, 0x01, b'+'];

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

/// Reads a typedstream integer at `at`; returns (value, bytes used).
fn read_int(data: &[u8], at: usize) -> Option<(usize, usize)> {
    match *data.get(at)? {
        TAG_I16 => {
            let bytes = data.get(at + 1..at + 3)?;
            Some((u16::from_le_bytes([bytes[0], bytes[1]]) as usize, 3))
        }
        TAG_I32 => {
            let bytes = data.get(at + 1..at + 5)?;
            let value = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            (value >= 0).then_some((value as usize, 5))
        }
        byte if byte < 0x80 => Some((byte as usize, 1)),
        _ => None,
    }
}

/// The message text in an `attributedBody` blob, if there is one.
pub fn text(data: &[u8]) -> Option<String> {
    if !data.starts_with(b"\x04\x0bstreamtyped") {
        return None;
    }
    let class = find(data, b"NSString", 0).or_else(|| find(data, b"NSMutableString", 0))?;
    // The string's type and bytes follow the class name closely; don't wander into other objects.
    let marker = find(data, &STRING_TYPE, class)?;
    if marker > class + 32 {
        return None;
    }
    let (length, used) = read_int(data, marker + STRING_TYPE.len())?;
    let start = marker + STRING_TYPE.len() + used;
    let bytes = data.get(start..start.checked_add(length)?)?;
    let text = String::from_utf8_lossy(bytes).into_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
pub(crate) fn archive(text: &str) -> Vec<u8> {
    // The shape Messages writes (class chain NSAttributedString → NSObject, then NSString).
    let mut data = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01\x40\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+".to_vec();
    let bytes = text.as_bytes();
    if bytes.len() < 0x80 {
        data.push(bytes.len() as u8);
    } else if bytes.len() <= u16::MAX as usize {
        data.push(TAG_I16);
        data.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
    } else {
        data.push(TAG_I32);
        data.extend_from_slice(&(bytes.len() as i32).to_le_bytes());
    }
    data.extend_from_slice(bytes);
    // Attribute runs follow (an NSDictionary with __kIMMessagePartAttributeName etc.).
    data.extend_from_slice(b"\x86\x84\x02iI\x01\x05\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x01\x92\x84\x96\x96\x1d__kIMMessagePartAttributeName\x86\x86");
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text() {
        assert_eq!(text(&archive("Hello")).as_deref(), Some("Hello"));
    }

    #[test]
    fn long_and_unicode_text() {
        let long = "🙂 Café ".repeat(60);
        assert!(long.len() > 0x80);
        assert_eq!(text(&archive(&long)).as_deref(), Some(long.as_str()));
        let huge = "x".repeat(70_000);
        assert_eq!(text(&archive(&huge)).map(|t| t.len()), Some(70_000));
    }

    #[test]
    fn mutable_strings_too() {
        let bytes = archive("Hi");
        let at = find(&bytes, b"\x08NSString", 0).unwrap();
        let mut mutable = bytes[..at].to_vec();
        mutable.extend_from_slice(b"\x0fNSMutableString");
        mutable.extend_from_slice(&bytes[at + 9..]);
        assert_eq!(text(&mutable).as_deref(), Some("Hi"));
    }

    #[test]
    fn garbage_is_none() {
        assert_eq!(text(b""), None);
        assert_eq!(text(b"bplist00whatever"), None);
        let mut truncated = archive("Hello world");
        truncated.truncate(truncated.len() - 80);
        assert_eq!(text(&truncated), None);
        let mut bad_len = archive("Hi");
        let at = find(&bad_len, &STRING_TYPE, 0).unwrap() + 3;
        bad_len[at] = 0x90;
        assert_eq!(text(&bad_len), None);
    }
}
