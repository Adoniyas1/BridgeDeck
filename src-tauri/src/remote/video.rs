//! Smooth video for remote control: H.264 from the operating system's own encoder (VideoToolbox
//! on a Mac, uses the GPU; Media Foundation on Windows), decoded in the viewer's tab with WebCodecs.
//! It's used when both ends can (the viewer says so in its hello); otherwise, or if the encoder
//! fails, the session stays on JPEG tiles (codec.rs). The stream is Annex B (start codes, SPS and
//! PPS before each key frame), so the viewer needs nothing but the bytes.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "windows")]
mod windows;

/// What the viewer and host call this codec.
pub const H264: &str = "h264";
/// A key frame at least this often, so a viewer can recover from a lost or skipped frame.
pub const KEY_EVERY: u64 = 240;

pub trait VideoEncoder: Send {
    /// One frame, NV12 (`width × height`, both even). Returns Annex B bytes, which can be empty
    /// while the encoder is still filling up.
    fn encode(&mut self, nv12: &[u8], width: u32, height: u32, key: bool) -> Result<Vec<u8>, String>;
}

/// Bits per second for a frame size and the viewer's quality setting (20–95).
pub fn bitrate(width: u32, height: u32, quality: u8) -> u32 {
    let pixels = (width as u64 * height as u64).max(1);
    // About 3 Mbit/s for 1080p at normal quality; more for high, less for low.
    let per_pixel = 0.4 + (quality.clamp(20, 95) as f64 - 20.0) / 75.0 * 2.6;
    ((pixels as f64 * per_pixel) as u64).clamp(500_000, 40_000_000) as u32
}

/// The platform's encoder for frames of this size, if it has one.
pub fn encoder(width: u32, height: u32, quality: u8) -> Result<Box<dyn VideoEncoder>, String> {
    let rate = bitrate(width, height, quality);
    #[cfg(test)]
    {
        let _ = rate;
        return Ok(Box::new(tests::FakeEncoder::default()));
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return mac::Encoder::new(width, height, rate).map(|e| Box::new(e) as Box<dyn VideoEncoder>);
    }
    #[cfg(all(not(test), target_os = "windows"))]
    {
        return windows::Encoder::new(width, height, rate).map(|e| Box::new(e) as Box<dyn VideoEncoder>);
    }
    #[allow(unreachable_code)]
    {
        let _ = (width, height, rate);
        Err("No video encoder on this computer".into())
    }
}

/// Whether this computer can send H.264 at all (said in its answer to the viewer).
pub fn available() -> bool {
    cfg!(any(test, target_os = "macos", target_os = "windows"))
}

/// The frame cut to even dimensions (H.264's 4:2:0 needs them).
pub fn even(rgba: Vec<u8>, width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let (w, h) = (width & !1, height & !1);
    if (w, h) == (width, height) {
        return (rgba, width, height);
    }
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h as usize {
        let start = row * width as usize * 4;
        out.extend_from_slice(&rgba[start..start + w as usize * 4]);
    }
    (out, w, h)
}

/// RGBA to NV12 (BT.709, video range: what decoders assume for HD without other signalling).
pub fn rgba_to_nv12(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut out = vec![0u8; w * h * 3 / 2];
    let (luma, chroma) = out.split_at_mut(w * h);
    for y in 0..h {
        for x in 0..w {
            let p = (y * w + x) * 4;
            let (r, g, b) = (rgba[p] as i32, rgba[p + 1] as i32, rgba[p + 2] as i32);
            luma[y * w + x] = (((47 * r + 157 * g + 16 * b + 128) >> 8) + 16).clamp(0, 255) as u8;
        }
    }
    for y in (0..h).step_by(2) {
        for x in (0..w).step_by(2) {
            let (mut r, mut g, mut b) = (0i32, 0i32, 0i32);
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let p = ((y + dy) * w + x + dx) * 4;
                r += rgba[p] as i32;
                g += rgba[p + 1] as i32;
                b += rgba[p + 2] as i32;
            }
            let (r, g, b) = (r / 4, g / 4, b / 4);
            let at = (y / 2) * w + x;
            chroma[at] = (((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
            chroma[at + 1] = (((112 * r - 102 * g - 10 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
        }
    }
    out
}

/// Length-prefixed NAL units (what VideoToolbox gives) as Annex B, with `prefix` NALs (SPS, PPS) first.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub fn annex_b(avcc: &[u8], length_size: usize, prefix: &[&[u8]]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(avcc.len() + 64);
    for nal in prefix {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(nal);
    }
    let mut at = 0;
    while at < avcc.len() {
        if at + length_size > avcc.len() || !(1..=4).contains(&length_size) {
            return Err("Broken video frame".into());
        }
        let len = avcc[at..at + length_size].iter().fold(0usize, |n, b| n << 8 | *b as usize);
        at += length_size;
        let end = at.checked_add(len).filter(|end| *end <= avcc.len()).ok_or("Broken video frame")?;
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&avcc[at..end]);
        at = end;
    }
    Ok(out)
}

/// The NAL unit types in an Annex B stream, in order.
pub fn nal_types(annex_b: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut i = 0;
    while i + 3 < annex_b.len() {
        if annex_b[i] == 0 && annex_b[i + 1] == 0 && annex_b[i + 2] == 1 {
            types.push(annex_b[i + 3] & 0x1f);
            i += 3;
        } else {
            i += 1;
        }
    }
    types
}

/// Whether an Annex B frame starts a picture the viewer can decode on its own (has an IDR slice).
pub fn is_key(annex_b: &[u8]) -> bool {
    nal_types(annex_b).contains(&5)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Stands in for the platform encoder in tests: an Annex B "frame" with SPS/PPS/IDR on key frames.
    #[derive(Default)]
    pub struct FakeEncoder {
        pub frames: u64,
    }

    impl VideoEncoder for FakeEncoder {
        fn encode(&mut self, nv12: &[u8], width: u32, height: u32, key: bool) -> Result<Vec<u8>, String> {
            assert_eq!(nv12.len(), (width * height * 3 / 2) as usize);
            let key = key || self.frames == 0;
            self.frames += 1;
            let mut out = Vec::new();
            if key {
                out.extend_from_slice(&[0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce]);
            }
            out.extend_from_slice(&[0, 0, 0, 1, if key { 0x65 } else { 0x41 }, 0x88, (self.frames & 0xff) as u8]);
            Ok(out)
        }
    }

    #[test]
    fn frames_become_nv12_and_annex_b() {
        // Even sizes only; white is 235 and grey chroma 128 in video range.
        let (rgba, w, h) = even(vec![255u8; 5 * 3 * 4], 5, 3);
        assert_eq!((w, h, rgba.len()), (4, 2, 32));
        let nv12 = rgba_to_nv12(&rgba, w, h);
        assert_eq!(nv12.len(), 12);
        assert!(nv12[..8].iter().all(|&y| y == 235), "{nv12:?}");
        assert!(nv12[8..].iter().all(|&c| c == 128), "{nv12:?}");
        let black = rgba_to_nv12(&[0, 0, 0, 255].repeat(4), 2, 2);
        assert_eq!(black, vec![16, 16, 16, 16, 128, 128]);
        let red = rgba_to_nv12(&[255, 0, 0, 255].repeat(4), 2, 2);
        assert!(red[4] < 110 && red[5] > 230, "red has low Cb, high Cr: {red:?}");

        // Length-prefixed to start codes, parameter sets first.
        let avcc = [0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 2, 0x41, 9];
        let out = annex_b(&avcc, 4, &[&[0x67, 0x42], &[0x68, 0xce]]).unwrap();
        assert_eq!(out, vec![0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 1, 2, 0, 0, 0, 1, 0x41, 9]);
        assert_eq!(nal_types(&out), vec![7, 8, 5, 1]);
        assert!(is_key(&out) && !is_key(&annex_b(&[0, 0, 0, 2, 0x41, 9], 4, &[]).unwrap()));
        assert!(annex_b(&[0, 0, 0, 9, 0x65], 4, &[]).is_err(), "a length past the end is refused");

        // Bit rates follow size and quality, within limits.
        assert!(bitrate(1920, 1080, 70) > bitrate(1920, 1080, 45));
        assert!((2_000_000..5_000_000).contains(&bitrate(1920, 1080, 70)), "{}", bitrate(1920, 1080, 70));
        assert_eq!(bitrate(10, 10, 20), 500_000);
    }
}
