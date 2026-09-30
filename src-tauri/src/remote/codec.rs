//! Screen frames for remote control: the screen is cut into tiles and only tiles that changed since
//! the last frame the viewer received are sent, each as a JPEG. Desktops are mostly still, so a
//! typical frame is a few small tiles; when most of the screen changes (video, scrolling) the whole
//! frame goes as one JPEG. The viewer asks for the next frame after drawing the last one, so the
//! frame rate follows what the link and the viewer can take.
//!
//! (The roadmap names H.264 + WebCodecs. Tiles need no video encoder, which keeps the host free of
//! platform encoder code and patent-encumbered codecs; H.264 can replace this behind the same wire.)

use serde::{Deserialize, Serialize};

pub const TILE: u32 = 128;
/// Above this share of changed tiles, one full-frame JPEG is smaller and faster than many tiles.
const FULL_FRAME_SHARE: f32 = 0.55;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TileHeader {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Bytes of this tile's JPEG in the frame payload (tiles are concatenated in order).
    pub len: u32,
}

#[derive(Debug, Default)]
pub struct Encoded {
    pub width: u32,
    pub height: u32,
    pub tiles: Vec<TileHeader>,
    pub data: Vec<u8>,
}

#[derive(Default)]
pub struct Encoder {
    width: u32,
    height: u32,
    hashes: Vec<u64>,
}

/// Fast 64-bit hash of a tile's rows (not cryptographic; a collision only skips one tile update).
fn tile_hash(rgba: &[u8], stride: usize, x: u32, y: u32, w: u32, h: u32) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ ((w as u64) << 32 | h as u64);
    for row in y..y + h {
        let start = row as usize * stride + x as usize * 4;
        let line = &rgba[start..start + w as usize * 4];
        let mut words = line.chunks_exact(8);
        for word in &mut words {
            hash = (hash ^ u64::from_le_bytes(word.try_into().expect("8 bytes"))).wrapping_mul(0x0100_0000_01b3).rotate_left(29);
        }
        for byte in words.remainder() {
            hash = (hash ^ *byte as u64).wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

fn crop(rgba: &[u8], stride: usize, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in y..y + h {
        let start = row as usize * stride + x as usize * 4;
        out.extend_from_slice(&rgba[start..start + w as usize * 4]);
    }
    out
}

fn jpeg(rgba: &[u8], w: u32, h: u32, quality: u8, out: &mut Vec<u8>) -> Result<u32, String> {
    let before = out.len();
    let encoder = jpeg_encoder::Encoder::new(&mut *out, quality.clamp(20, 95));
    encoder.encode(rgba, w as u16, h as u16, jpeg_encoder::ColorType::Rgba).map_err(|e| e.to_string())?;
    Ok((out.len() - before) as u32)
}

impl Encoder {
    /// The next frame is sent whole (a new viewer, another monitor, a lost frame).
    pub fn reset(&mut self) {
        self.hashes.clear();
    }

    /// Encodes what changed since the previous call. An empty `tiles` list means nothing changed.
    pub fn encode(&mut self, rgba: &[u8], width: u32, height: u32, quality: u8) -> Result<Encoded, String> {
        if width == 0 || height == 0 || width > u16::MAX as u32 || height > u16::MAX as u32 || rgba.len() < (width * height * 4) as usize {
            return Err("Invalid frame".into());
        }
        let stride = width as usize * 4;
        let (cols, rows) = (width.div_ceil(TILE), height.div_ceil(TILE));
        if self.width != width || self.height != height || self.hashes.len() != (cols * rows) as usize {
            self.width = width;
            self.height = height;
            self.hashes = Vec::new();
        }
        let fresh = self.hashes.is_empty();
        let mut hashes = Vec::with_capacity((cols * rows) as usize);
        let mut changed = Vec::new();
        for row in 0..rows {
            for col in 0..cols {
                let (x, y) = (col * TILE, row * TILE);
                let (w, h) = (TILE.min(width - x), TILE.min(height - y));
                let hash = tile_hash(rgba, stride, x, y, w, h);
                let index = hashes.len();
                if fresh || self.hashes[index] != hash {
                    changed.push((x, y, w, h));
                }
                hashes.push(hash);
            }
        }
        self.hashes = hashes;
        let mut frame = Encoded { width, height, tiles: Vec::new(), data: Vec::new() };
        if changed.is_empty() {
            return Ok(frame);
        }
        if fresh || changed.len() as f32 >= FULL_FRAME_SHARE * (cols * rows) as f32 {
            let len = jpeg(&rgba[..(width * height * 4) as usize], width, height, quality, &mut frame.data)?;
            frame.tiles.push(TileHeader { x: 0, y: 0, w: width, h: height, len });
            return Ok(frame);
        }
        for (x, y, w, h) in changed {
            let len = jpeg(&crop(rgba, stride, x, y, w, h), w, h, quality, &mut frame.data)?;
            frame.tiles.push(TileHeader { x, y, w, h, len });
        }
        Ok(frame)
    }
}

/// Shrinks a frame by a whole factor (box average) so it's at most `max_width` wide. Retina and 4K
/// screens are captured at full resolution; viewers rarely need it.
pub fn downscale(rgba: Vec<u8>, width: u32, height: u32, max_width: u32) -> (Vec<u8>, u32, u32) {
    let factor = if max_width == 0 { 1 } else { width.div_ceil(max_width) };
    if factor <= 1 {
        return (rgba, width, height);
    }
    let (w, h) = (width / factor, height / factor);
    let mut out = vec![0u8; (w * h * 4) as usize];
    let stride = width as usize * 4;
    let area = factor * factor;
    for y in 0..h {
        for x in 0..w {
            let mut sum = [0u32; 4];
            for dy in 0..factor {
                let row = (y * factor + dy) as usize * stride;
                for dx in 0..factor {
                    let at = row + ((x * factor + dx) * 4) as usize;
                    for (channel, total) in sum.iter_mut().enumerate() {
                        *total += rgba[at + channel] as u32;
                    }
                }
            }
            let at = ((y * w + x) * 4) as usize;
            for channel in 0..4 {
                out[at + channel] = (sum[channel] / area) as u8;
            }
        }
    }
    (out, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(width: u32, height: u32, shade: u8) -> Vec<u8> {
        (0..width * height).flat_map(|i| [shade, (i % 251) as u8, 40, 255]).collect()
    }

    fn is_jpeg(bytes: &[u8]) -> bool {
        bytes.starts_with(&[0xFF, 0xD8]) && bytes.ends_with(&[0xFF, 0xD9])
    }

    #[test]
    fn first_frame_is_whole_then_only_changes() {
        let (w, h) = (1000, 600);
        let mut encoder = Encoder::default();
        let mut pixels = screen(w, h, 10);
        let first = encoder.encode(&pixels, w, h, 70).unwrap();
        assert_eq!(first.tiles, vec![TileHeader { x: 0, y: 0, w, h, len: first.data.len() as u32 }]);
        assert!(is_jpeg(&first.data));

        assert!(encoder.encode(&pixels, w, h, 70).unwrap().tiles.is_empty(), "nothing changed");

        // Change one pixel in the tile at (256, 128) and one in the ragged last tile.
        let poke = |pixels: &mut Vec<u8>, x: u32, y: u32| pixels[((y * w + x) * 4) as usize] ^= 0xFF;
        poke(&mut pixels, 300, 200);
        poke(&mut pixels, 999, 599);
        let delta = encoder.encode(&pixels, w, h, 70).unwrap();
        assert_eq!(delta.tiles.iter().map(|t| (t.x, t.y, t.w, t.h)).collect::<Vec<_>>(), vec![(256, 128, 128, 128), (896, 512, 104, 88)]);
        let mut offset = 0usize;
        for tile in &delta.tiles {
            assert!(is_jpeg(&delta.data[offset..offset + tile.len as usize]));
            offset += tile.len as usize;
        }
        assert_eq!(offset, delta.data.len());
    }

    #[test]
    fn big_changes_and_resets_send_the_whole_frame() {
        let (w, h) = (640, 480);
        let mut encoder = Encoder::default();
        encoder.encode(&screen(w, h, 0), w, h, 60).unwrap();
        let all = encoder.encode(&screen(w, h, 200), w, h, 60).unwrap();
        assert_eq!(all.tiles.len(), 1);
        assert_eq!((all.tiles[0].w, all.tiles[0].h), (w, h));
        encoder.reset();
        assert_eq!(encoder.encode(&screen(w, h, 200), w, h, 60).unwrap().tiles.len(), 1);
        // A different size (another monitor) starts over too.
        assert_eq!(encoder.encode(&screen(320, 200, 200), 320, 200, 60).unwrap().tiles[0].w, 320);
        assert!(encoder.encode(&[0; 10], 320, 200, 60).is_err());
    }

    #[test]
    fn downscale_by_whole_factors() {
        let (pixels, w, h) = downscale(vec![100; 2880 * 1800 * 4], 2880, 1800, 1600);
        assert_eq!((w, h), (1440, 900));
        assert_eq!(pixels.len(), 1440 * 900 * 4);
        assert!(pixels.iter().all(|p| *p == 100));
        let (_, w, h) = downscale(vec![0; 1920 * 1080 * 4], 1920, 1080, 1920);
        assert_eq!((w, h), (1920, 1080), "no scaling needed");
        // Averages: a 2x2 block of 0 and 200 becomes 100.
        let block = [0, 0, 0, 0, 200, 200, 200, 200, 0, 0, 0, 0, 200, 200, 200, 200];
        assert_eq!(downscale(block.to_vec(), 2, 2, 1).0, vec![100, 100, 100, 100]);
    }
}
