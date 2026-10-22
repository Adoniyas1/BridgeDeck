//! Photos to one PDF, for homework scanned on the phone: each JPEG becomes a Letter-size page (a
//! landscape one for a wide photo), scaled to fit. The JPEG goes in as it is (DCTDecode), so
//! nothing is re-encoded or lost.

use std::fmt::Write as _;

/// Width, height and colour components of a JPEG (from its frame header), or None if it isn't one.
pub fn jpeg_info(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    if bytes.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if matches!(marker, 0xD8 | 0x01 | 0xD0..=0xD7) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        // Start of frame (baseline, progressive…), not DHT/JPG/DAC.
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let f = bytes.get(i + 4..i + 10)?;
            let (h, w, comps) = (u16::from_be_bytes([f[1], f[2]]) as u32, u16::from_be_bytes([f[3], f[4]]) as u32, f[5]);
            return (w > 0 && h > 0 && matches!(comps, 1 | 3 | 4)).then_some((w, h, comps));
        }
        i += 2 + len;
    }
    None
}

/// The JPEGs as one PDF, a page each.
pub fn jpegs_to_pdf(pages: &[Vec<u8>], title: &str) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("No pages".into());
    }
    let mut out: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets: Vec<usize> = Vec::new();
    // Objects: 1 catalog, 2 pages, 3 info, then per page: page, contents, image.
    let page_ids: Vec<usize> = (0..pages.len()).map(|n| 4 + n * 3).collect();
    let mut object = |out: &mut Vec<u8>, body: &[u8]| {
        offsets.push(out.len());
        let id = offsets.len();
        out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    object(&mut out, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids: String = page_ids.iter().map(|id| format!("{id} 0 R ")).collect();
    object(&mut out, format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", pages.len()).as_bytes());
    let safe: String = title.chars().filter(|c| !matches!(c, '(' | ')' | '\\') && !c.is_control()).take(200).collect();
    object(&mut out, format!("<< /Title ({safe}) /Producer (BridgeDeck) >>").as_bytes());
    for (n, jpeg) in pages.iter().enumerate() {
        let (w, h, comps) = jpeg_info(jpeg).ok_or_else(|| format!("Page {} isn't a JPEG photo", n + 1))?;
        let (pw, ph) = if w > h { (792.0, 612.0) } else { (612.0, 792.0) };
        let scale = f64::min(pw / w as f64, ph / h as f64);
        let (iw, ih) = (w as f64 * scale, h as f64 * scale);
        let (x, y) = ((pw - iw) / 2.0, (ph - ih) / 2.0);
        let (page_id, contents_id, image_id) = (4 + n * 3, 5 + n * 3, 6 + n * 3);
        object(&mut out, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Resources << /XObject << /Im{n} {image_id} 0 R >> >> /Contents {contents_id} 0 R >>").as_bytes());
        let mut draw = String::new();
        let _ = write!(draw, "q {iw:.2} 0 0 {ih:.2} {x:.2} {y:.2} cm /Im{n} Do Q");
        object(&mut out, format!("<< /Length {} >>\nstream\n{draw}\nendstream", draw.len()).as_bytes());
        let space = match comps { 1 => "/DeviceGray", 4 => "/DeviceCMYK", _ => "/DeviceRGB" };
        // Adobe CMYK JPEGs are stored inverted.
        let decode = if comps == 4 { " /Decode [1 0 1 0 1 0 1 0]" } else { "" };
        let mut body = format!("<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace {space} /BitsPerComponent 8 /Filter /DCTDecode{decode} /Length {} >>\nstream\n", jpeg.len()).into_bytes();
        body.extend_from_slice(jpeg);
        body.extend_from_slice(b"\nendstream");
        object(&mut out, &body);
        let _ = page_id;
    }
    let xref = out.len();
    let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1);
    for o in &offsets {
        let _ = writeln!(table, "{o:010} 00000 n ");
    }
    let _ = write!(table, "trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1);
    out.extend_from_slice(table.as_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny JPEG header: SOI, an APP0, then SOF0 for `w`×`h` with 3 components.
    fn fake_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        j.extend_from_slice(&h.to_be_bytes());
        j.extend_from_slice(&w.to_be_bytes());
        j.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
        j
    }

    #[test]
    fn photos_become_pages_of_one_pdf() {
        assert_eq!(jpeg_info(&fake_jpeg(4032, 3024)), Some((4032, 3024, 3)));
        assert_eq!(jpeg_info(b"\x89PNG"), None);
        let pdf = jpegs_to_pdf(&[fake_jpeg(3024, 4032), fake_jpeg(4032, 3024)], "EE 310 HW (4)").unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF-1.4") && text.trim_end().ends_with("%%EOF"));
        assert!(text.contains("/Count 2") && text.contains("/MediaBox [0 0 612 792]") && text.contains("/MediaBox [0 0 792 612]"));
        assert!(text.contains("/Title (EE 310 HW 4)"));
        // The cross-reference offsets point at the objects (offsets are in bytes, not text).
        let tail = String::from_utf8_lossy(&pdf[pdf.len() - 40..]).to_string();
        let xref_at: usize = tail.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
        assert!(pdf[xref_at..].starts_with(b"xref"));
        let table = String::from_utf8_lossy(&pdf[xref_at..]).to_string();
        let mut n = 0;
        for line in table.lines().skip(3).take_while(|l| l.ends_with(" n ")) {
            n += 1;
            let at: usize = line[..10].parse().unwrap();
            assert!(pdf[at..].starts_with(format!("{n} 0 obj").as_bytes()), "{line}");
        }
        assert_eq!(n, 3 + 2 * 3);
        assert!(jpegs_to_pdf(&[b"not a jpeg".to_vec()], "x").is_err());
        assert!(jpegs_to_pdf(&[], "x").is_err());
    }
}
