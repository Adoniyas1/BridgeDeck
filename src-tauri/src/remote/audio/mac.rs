//! macOS: what the Mac is playing, through ScreenCaptureKit's audio capture (macOS 13 or later;
//! the Screen Recording permission remote control already needs covers it). BridgeDeck's own
//! sounds are left out.

use std::{
    ffi::c_void,
    ptr,
    sync::{mpsc, Mutex},
    time::Duration,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, AllocAnyThread, DefinedClass};
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput, SCStreamOutputType};

use super::{to_i16, Sink};

const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

#[repr(C)]
struct AudioBuffer {
    channels: u32,
    size: u32,
    data: *mut c_void,
}

/// An AudioBufferList with room for up to 8 buffers (one per channel when not interleaved).
#[repr(C)]
struct AudioBufferList {
    count: u32,
    buffers: [AudioBuffer; 8],
}

#[repr(C)]
struct StreamDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

const FLAG_FLOAT: u32 = 1;
const FLAG_NON_INTERLEAVED: u32 = 1 << 5;

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMSampleBufferGetFormatDescription(sample: *mut c_void) -> *mut c_void;
    fn CMAudioFormatDescriptionGetStreamBasicDescription(description: *mut c_void) -> *const StreamDescription;
    fn CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample: *const c_void,
        size_needed: *mut usize,
        list: *mut AudioBufferList,
        list_size: usize,
        structure_allocator: *const c_void,
        block_allocator: *const c_void,
        flags: u32,
        block_out: *mut *const c_void,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// Interleaved 16-bit samples from planar or interleaved 32-bit float buffers.
fn interleave(planes: &[&[f32]], interleaved: bool) -> Vec<i16> {
    if interleaved || planes.len() == 1 {
        return planes.iter().flat_map(|p| to_i16(p)).collect();
    }
    let frames = planes.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut out = Vec::with_capacity(frames * planes.len());
    for i in 0..frames {
        for plane in planes {
            out.push((plane[i].clamp(-1.0, 1.0) * 32767.0).round() as i16);
        }
    }
    out
}

/// The sound in one sample buffer, with its rate and channel count.
unsafe fn samples_of(sample: &CMSampleBuffer) -> Option<(Vec<i16>, u32, u16)> {
    unsafe {
        let raw = sample as *const CMSampleBuffer as *const c_void;
        let description = CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(raw as *mut c_void));
        if description.is_null() {
            return None;
        }
        let d = &*description;
        if d.format_flags & FLAG_FLOAT == 0 || d.bits_per_channel != 32 {
            return None;
        }
        let mut list: AudioBufferList = std::mem::zeroed();
        let mut block: *const c_void = ptr::null();
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(raw, ptr::null_mut(), &mut list, std::mem::size_of::<AudioBufferList>(), ptr::null(), ptr::null(), 1, &mut block);
        if status != 0 {
            return None;
        }
        let count = (list.count as usize).min(8);
        let planes: Vec<&[f32]> = list.buffers[..count].iter().filter(|b| !b.data.is_null()).map(|b| std::slice::from_raw_parts(b.data as *const f32, b.size as usize / 4)).collect();
        let samples = interleave(&planes, d.format_flags & FLAG_NON_INTERLEAVED == 0);
        if !block.is_null() {
            CFRelease(block);
        }
        Some((samples, d.sample_rate as u32, d.channels_per_frame.max(1) as u16))
    }
}

pub struct Ivars {
    sink: Mutex<Sink>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the class has no Drop-sensitive state
    // beyond its ivars.
    #[unsafe(super(NSObject))]
    #[name = "BridgeDeckRemoteSound"]
    #[ivars = Ivars]
    struct SoundOutput;

    unsafe impl NSObjectProtocol for SoundOutput {}

    unsafe impl SCStreamOutput for SoundOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind != SCStreamOutputType::Audio {
                return;
            }
            if let Some((samples, rate, channels)) = unsafe { samples_of(sample) } {
                if let Ok(mut sink) = self.ivars().sink.lock() {
                    sink(&samples, rate, channels);
                }
            }
        }
    }
);

impl SoundOutput {
    fn new(sink: Sink) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { sink: Mutex::new(sink) });
        unsafe { msg_send![super(this), init] }
    }
}

/// Keeps the capture running; stops it when dropped.
struct Capture {
    stream: Retained<SCStream>,
    _output: Retained<SoundOutput>,
    _queue: DispatchRetained<DispatchQueue>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe { self.stream.stopCaptureWithCompletionHandler(None) };
    }
}

/// Moves an Objective-C object between threads (handed over once, used by one thread at a time).
struct Handover<T>(T);
unsafe impl<T> Send for Handover<T> {}

pub fn open(sink: Sink) -> Result<Box<dyn std::any::Any>, String> {
    unsafe {
        // The displays (needed to make a capture, even of sound only).
        let (tx, rx) = mpsc::channel::<Result<Handover<Retained<SCShareableContent>>, String>>();
        let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = match Retained::retain(content) {
                Some(content) if error.is_null() => Ok(Handover(content)),
                _ => Err(Retained::retain(error).map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "Screen Recording permission is needed for sound".into())),
            };
            let _ = tx.send(result);
        });
        SCShareableContent::getShareableContentWithCompletionHandler(&handler);
        let content = rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "The Mac didn't answer about its displays".to_string())??.0;
        let displays = content.displays();
        let display = displays.firstObject().ok_or("No display to capture sound with")?;

        let filter = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::new());
        let config = SCStreamConfiguration::new();
        config.setCapturesAudio(true);
        config.setSampleRate(RATE as isize);
        config.setChannelCount(CHANNELS as isize);
        config.setExcludesCurrentProcessAudio(true);
        // Sound only: the smallest, slowest picture (frames are ignored).
        config.setWidth(2);
        config.setHeight(2);
        config.setMinimumFrameInterval(CMTime { value: 1, timescale: 1, flags: CMTimeFlags(1), epoch: 0 });
        let stream = SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None);

        let output = SoundOutput::new(sink);
        let queue = DispatchQueue::new("app.bridgedeck.remote-sound", None);
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*output), SCStreamOutputType::Audio, Some(&queue))
            .map_err(|e| format!("Couldn't capture the Mac's sound: {}", e.localizedDescription()))?;

        let (started_tx, started_rx) = mpsc::channel::<Result<(), String>>();
        let started = RcBlock::new(move |error: *mut NSError| {
            let _ = started_tx.send(match Retained::retain(error) {
                Some(error) => Err(format!("Couldn't capture the Mac's sound: {}", error.localizedDescription())),
                None => Ok(()),
            });
        });
        stream.startCaptureWithCompletionHandler(Some(&started));
        started_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "The Mac's sound didn't start".to_string())??;
        Ok(Box::new(Capture { stream, _output: output, _queue: queue }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planes_interleave() {
        assert_eq!(interleave(&[&[1.0, 0.0], &[-1.0, 0.5]], false), vec![32767, -32767, 0, 16384]);
        assert_eq!(interleave(&[&[1.0, -1.0]], true), vec![32767, -32767]);
    }
}
