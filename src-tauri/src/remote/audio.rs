//! The host computer's sound for remote control: what's playing (not the microphone), captured
//! with the system's loopback (WASAPI on Windows, ScreenCaptureKit on a Mac), sent as 16-bit
//! samples in short chunks while the viewer has sound on. Chunks are dropped rather than queued
//! when the link is busy: late sound is worse than a skip.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "windows")]
mod windows;

/// About 40 ms of sound per message.
pub const CHUNK_MS: u32 = 40;

/// Takes captured samples (interleaved, any rate) and hands out chunks of `CHUNK_MS`.
pub struct Chunker {
    rate: u32,
    channels: u16,
    pending: Vec<i16>,
}

impl Chunker {
    pub fn new(rate: u32, channels: u16) -> Self {
        Self { rate, channels, pending: Vec::new() }
    }

    fn chunk_len(&self) -> usize {
        (self.rate as usize * CHUNK_MS as usize / 1000) * self.channels as usize
    }

    /// Adds samples; returns the whole chunks now ready.
    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<i16>> {
        self.pending.extend_from_slice(samples);
        let len = self.chunk_len().max(1);
        let mut out = Vec::new();
        while self.pending.len() >= len {
            out.push(self.pending.drain(..len).collect());
        }
        out
    }
}

/// Float samples (-1…1) as 16-bit.
#[cfg_attr(not(any(test, target_os = "macos", target_os = "windows")), allow(dead_code))]
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16).collect()
}

/// Little-endian bytes for the wire.
pub fn to_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// Where captured sound goes: `(samples, rate, channels)`.
pub type Sink = Box<dyn FnMut(&[i16], u32, u16) + Send>;

/// Whether this computer can send its sound.
pub fn available() -> bool {
    cfg!(any(test, target_os = "windows", target_os = "macos"))
}

/// Starts capturing into `sink`; capturing stops when the returned guard is dropped.
fn open(sink: Sink) -> Result<Box<dyn std::any::Any>, String> {
    #[cfg(test)]
    {
        return tests::fake(sink);
    }
    #[cfg(all(not(test), target_os = "windows"))]
    {
        return windows::open(sink);
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return mac::open(sink);
    }
    #[allow(unreachable_code)]
    {
        drop(sink);
        Err("This computer can't send its sound".into())
    }
}

/// Runs for a session: captures while `on` is set, until `stop`. `chunk` gets each chunk
/// (`samples, rate, channels`); errors go to `failed` once.
pub fn spawn(on: Arc<AtomicBool>, stop: Arc<AtomicBool>, chunk: impl Fn(Vec<i16>, u32, u16) + Send + Sync + 'static, failed: impl Fn(String) + Send + 'static) {
    let chunk = Arc::new(chunk);
    std::thread::spawn(move || {
        // The platform stream lives on this thread (some aren't Send).
        let mut running: Option<Box<dyn std::any::Any>> = None;
        let mut reported = false;
        while !stop.load(Ordering::Relaxed) {
            let wanted = on.load(Ordering::Relaxed);
            if wanted && running.is_none() {
                let chunk = chunk.clone();
                let mut chunker: Option<Chunker> = None;
                let sink: Sink = Box::new(move |samples, rate, channels| {
                    let c = chunker.get_or_insert_with(|| Chunker::new(rate, channels));
                    if c.rate != rate || c.channels != channels {
                        *c = Chunker::new(rate, channels);
                    }
                    for piece in c.push(samples) {
                        chunk(piece, rate, channels);
                    }
                });
                match open(sink) {
                    Ok(stream) => running = Some(stream),
                    Err(error) => {
                        if !reported {
                            reported = true;
                            failed(error);
                        }
                        on.store(false, Ordering::Relaxed);
                    }
                }
            } else if !wanted && running.is_some() {
                running = None;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A few chunks of a quiet tone, as a capture would deliver them.
    pub fn fake(mut sink: Sink) -> Result<Box<dyn std::any::Any>, String> {
        let alive = Arc::new(AtomicBool::new(true));
        let flag = alive.clone();
        std::thread::spawn(move || {
            for _ in 0..5 {
                if !flag.load(Ordering::Relaxed) {
                    break;
                }
                sink(&vec![100i16; 48_000 / 50 * 2], 48_000, 2);
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Relaxed);
            }
        }
        Ok(Box::new(Guard(alive)))
    }

    #[test]
    fn sound_goes_out_in_even_chunks() {
        let mut chunker = Chunker::new(48_000, 2);
        assert!(chunker.push(&vec![0; 1000]).is_empty());
        let out = chunker.push(&vec![0; 3000]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 48 * 40 * 2);
        assert_eq!(to_i16(&[0.0, 1.0, -1.0, 2.0]), vec![0, 32767, -32767, 32767]);
        assert_eq!(to_bytes(&[1, -2]), vec![1, 0, 0xfe, 0xff]);
    }
}
