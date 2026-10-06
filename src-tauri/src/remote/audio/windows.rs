//! Windows: what the speakers are playing, through WASAPI loopback on the default output device
//! (no driver or setting needed). Read every 10 ms on a thread of its own.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use windows::Win32::{
    Media::Audio::*,
    System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED},
};

use super::{to_i16, Sink};

/// How the device's samples are stored.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Format {
    Float32,
    Int16,
    Int32,
}

fn format_of(tag: u16, bits: u16, sub_format_kind: Option<u32>) -> Option<Format> {
    // WAVE_FORMAT_EXTENSIBLE says the real kind in its sub-format (1 = PCM, 3 = float).
    let kind = if tag == 0xFFFE { sub_format_kind? } else { tag as u32 };
    match (kind, bits) {
        (3, 32) => Some(Format::Float32),
        (1, 16) => Some(Format::Int16),
        (1, 32) => Some(Format::Int32),
        _ => None,
    }
}

struct Guard(Arc<AtomicBool>);

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

pub fn open(mut sink: Sink) -> Result<Box<dyn std::any::Any>, String> {
    let running = Arc::new(AtomicBool::new(true));
    let alive = running.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let started = unsafe { start() };
        let (client, capture, rate, channels, format) = match started {
            Ok(parts) => {
                let _ = ready_tx.send(Ok(()));
                parts
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
                return;
            }
        };
        let mut samples: Vec<i16> = Vec::new();
        while alive.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(10));
            unsafe {
                while let Ok(frames) = capture.GetNextPacketSize() {
                    if frames == 0 {
                        break;
                    }
                    let mut data = std::ptr::null_mut();
                    let (mut count, mut flags) = (0u32, 0u32);
                    if capture.GetBuffer(&mut data, &mut count, &mut flags, None, None).is_err() {
                        break;
                    }
                    let n = count as usize * channels as usize;
                    samples.clear();
                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                        samples.resize(n, 0);
                    } else {
                        match format {
                            Format::Float32 => samples.extend(to_i16(std::slice::from_raw_parts(data as *const f32, n))),
                            Format::Int16 => samples.extend_from_slice(std::slice::from_raw_parts(data as *const i16, n)),
                            Format::Int32 => samples.extend(std::slice::from_raw_parts(data as *const i32, n).iter().map(|s| (s >> 16) as i16)),
                        }
                    }
                    let _ = capture.ReleaseBuffer(count);
                    sink(&samples, rate, channels);
                }
            }
        }
        unsafe {
            let _ = client.Stop();
        }
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "The sound device didn't answer".to_string())??;
    Ok(Box::new(Guard(running)))
}

unsafe fn start() -> Result<(IAudioClient, IAudioCaptureClient, u32, u16, Format), String> {
    let fail = |what: &str, e: windows::core::Error| format!("Couldn't capture this computer's sound ({what}: {e})");
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| fail("devices", e))?;
        let speakers = devices.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|e| fail("speakers", e))?;
        let client: IAudioClient = speakers.Activate(CLSCTX_ALL, None).map_err(|e| fail("activate", e))?;
        let mix = client.GetMixFormat().map_err(|e| fail("format", e))?;
        let head = std::ptr::read_unaligned(mix);
        let (tag, bits, rate, channels) = (head.wFormatTag, head.wBitsPerSample, head.nSamplesPerSec, head.nChannels);
        let sub_kind = (tag == 0xFFFE && head.cbSize >= 22).then(|| {
            let full = std::ptr::read_unaligned(mix as *const WAVEFORMATEXTENSIBLE);
            full.SubFormat.data1
        });
        // 200 ms of buffer; loopback captures in the device's own format.
        let result = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, mix, None);
        CoTaskMemFree(Some(mix as *const _));
        result.map_err(|e| fail("start", e))?;
        let format = format_of(tag, bits, sub_kind).ok_or_else(|| format!("This computer's sound format isn't supported ({bits}-bit, kind {tag})"))?;
        let capture: IAudioCaptureClient = client.GetService().map_err(|e| fail("capture", e))?;
        client.Start().map_err(|e| fail("start", e))?;
        Ok((client, capture, rate, channels, format))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_formats() {
        assert_eq!(format_of(3, 32, None), Some(Format::Float32));
        assert_eq!(format_of(0xFFFE, 32, Some(3)), Some(Format::Float32));
        assert_eq!(format_of(0xFFFE, 16, Some(1)), Some(Format::Int16));
        assert_eq!(format_of(0xFFFE, 24, Some(1)), None);
        assert_eq!(format_of(0xFFFE, 32, None), None);
    }
}
