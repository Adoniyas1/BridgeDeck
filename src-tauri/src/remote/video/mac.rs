//! H.264 on a Mac: VideoToolbox, the system's encoder (on the GPU's media engine where there is
//! one), in real-time mode with no frame reordering, so each frame comes straight back. Its output
//! is length-prefixed NAL units plus parameter sets in the format description; both become Annex B.

use std::{
    ffi::c_void,
    ptr,
    sync::Mutex,
};

type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFStringRef = *const c_void;
type CFArrayRef = *const c_void;
type OSStatus = i32;
type VTCompressionSessionRef = *mut c_void;
type CVPixelBufferRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMFormatDescriptionRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

const INVALID_TIME: CMTime = CMTime { value: 0, timescale: 0, flags: 0, epoch: 0 };
const TIME_VALID: u32 = 1;
const CODEC_H264: u32 = u32::from_be_bytes(*b"avc1");
const PIXELS_NV12: u32 = u32::from_be_bytes(*b"420v");
const CF_NUMBER_SINT32: isize = 3;

type OutputCallback = extern "C" fn(*mut c_void, *mut c_void, OSStatus, u32, CMSampleBufferRef);

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFBooleanFalse: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFRelease(cf: CFTypeRef);
    fn CFNumberCreate(allocator: CFAllocatorRef, kind: isize, value: *const c_void) -> CFTypeRef;
    fn CFDictionaryCreate(allocator: CFAllocatorRef, keys: *const CFTypeRef, values: *const CFTypeRef, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> CFDictionaryRef;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: isize) -> CFTypeRef;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferCreate(allocator: CFAllocatorRef, width: usize, height: usize, format: u32, attributes: CFDictionaryRef, out: *mut CVPixelBufferRef) -> i32;
    fn CVPixelBufferLockBaseAddress(buffer: CVPixelBufferRef, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(buffer: CVPixelBufferRef, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddressOfPlane(buffer: CVPixelBufferRef, plane: usize) -> *mut u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(buffer: CVPixelBufferRef, plane: usize) -> usize;
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    static kCMSampleAttachmentKey_NotSync: CFStringRef;
    fn CMSampleBufferGetDataBuffer(sample: CMSampleBufferRef) -> CMBlockBufferRef;
    fn CMSampleBufferGetFormatDescription(sample: CMSampleBufferRef) -> CMFormatDescriptionRef;
    fn CMSampleBufferGetSampleAttachmentsArray(sample: CMSampleBufferRef, create: u8) -> CFArrayRef;
    fn CMBlockBufferGetDataLength(buffer: CMBlockBufferRef) -> usize;
    fn CMBlockBufferCopyDataBytes(buffer: CMBlockBufferRef, offset: usize, length: usize, destination: *mut c_void) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(description: CMFormatDescriptionRef, index: usize, pointer: *mut *const u8, size: *mut usize, count: *mut usize, header_length: *mut i32) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    static kVTCompressionPropertyKey_RealTime: CFStringRef;
    static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
    static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
    static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
    static kVTCompressionPropertyKey_MaxKeyFrameInterval: CFStringRef;
    static kVTProfileLevel_H264_Main_AutoLevel: CFStringRef;
    static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;
    static kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: CFStringRef;
    fn VTCompressionSessionCreate(
        allocator: CFAllocatorRef,
        width: i32,
        height: i32,
        codec: u32,
        encoder_specification: CFDictionaryRef,
        source_attributes: CFDictionaryRef,
        compressed_allocator: CFAllocatorRef,
        callback: OutputCallback,
        refcon: *mut c_void,
        out: *mut VTCompressionSessionRef,
    ) -> OSStatus;
    fn VTSessionSetProperty(session: VTCompressionSessionRef, key: CFStringRef, value: CFTypeRef) -> OSStatus;
    fn VTCompressionSessionPrepareToEncodeFrames(session: VTCompressionSessionRef) -> OSStatus;
    fn VTCompressionSessionEncodeFrame(session: VTCompressionSessionRef, image: CVPixelBufferRef, pts: CMTime, duration: CMTime, properties: CFDictionaryRef, frame_refcon: *mut c_void, info: *mut u32) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(session: VTCompressionSessionRef, until: CMTime) -> OSStatus;
    fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);
}

/// Where the callback leaves a frame (one frame at a time: encode waits for it).
type Slot = Mutex<Option<Result<Vec<u8>, String>>>;

/// Called by VideoToolbox with each encoded frame.
extern "C" fn on_frame(_session: *mut c_void, frame: *mut c_void, status: OSStatus, _flags: u32, sample: CMSampleBufferRef) {
    if frame.is_null() {
        return;
    }
    let slot = unsafe { &*(frame as *const Slot) };
    let result = if status != 0 {
        Err(format!("Video encoder error {status}"))
    } else if sample.is_null() {
        // Dropped by the encoder: nothing to send for this frame.
        Ok(Vec::new())
    } else {
        unsafe { annex_b_of(sample) }
    };
    if let Ok(mut slot) = slot.lock() {
        *slot = Some(result);
    }
}

unsafe fn is_key(sample: CMSampleBufferRef) -> bool {
    unsafe {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, 0);
        if attachments.is_null() || CFArrayGetCount(attachments) == 0 {
            return true;
        }
        let first = CFArrayGetValueAtIndex(attachments, 0);
        let not_sync = CFDictionaryGetValue(first, kCMSampleAttachmentKey_NotSync);
        not_sync.is_null() || not_sync == kCFBooleanFalse
    }
}

unsafe fn annex_b_of(sample: CMSampleBufferRef) -> Result<Vec<u8>, String> {
    unsafe {
        let block = CMSampleBufferGetDataBuffer(sample);
        if block.is_null() {
            return Ok(Vec::new());
        }
        let len = CMBlockBufferGetDataLength(block);
        let mut data = vec![0u8; len];
        if CMBlockBufferCopyDataBytes(block, 0, len, data.as_mut_ptr() as *mut c_void) != 0 {
            return Err("Couldn't read the encoded frame".into());
        }
        let description = CMSampleBufferGetFormatDescription(sample);
        let mut prefix: Vec<&[u8]> = Vec::new();
        let mut length_size = 4i32;
        if is_key(sample) && !description.is_null() {
            let mut count = 0usize;
            let mut index = 0usize;
            loop {
                let (mut pointer, mut size) = (ptr::null::<u8>(), 0usize);
                let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(description, index, &mut pointer, &mut size, &mut count, &mut length_size);
                if status != 0 || pointer.is_null() {
                    break;
                }
                prefix.push(std::slice::from_raw_parts(pointer, size));
                index += 1;
                if index >= count {
                    break;
                }
            }
        }
        super::annex_b(&data, length_size.clamp(1, 4) as usize, &prefix)
    }
}

unsafe fn dictionary(pairs: &[(CFTypeRef, CFTypeRef)]) -> CFDictionaryRef {
    let keys: Vec<CFTypeRef> = pairs.iter().map(|p| p.0).collect();
    let values: Vec<CFTypeRef> = pairs.iter().map(|p| p.1).collect();
    unsafe { CFDictionaryCreate(ptr::null(), keys.as_ptr(), values.as_ptr(), pairs.len() as isize, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) }
}

unsafe fn number(value: i32) -> CFTypeRef {
    unsafe { CFNumberCreate(ptr::null(), CF_NUMBER_SINT32, &value as *const i32 as *const c_void) }
}

pub struct Encoder {
    session: VTCompressionSessionRef,
    width: u32,
    height: u32,
    frame: i64,
    key_options: CFDictionaryRef,
}

// The session is used only from the capture thread that made it.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(width: u32, height: u32, rate: u32) -> Result<Self, String> {
        unsafe {
            let spec = dictionary(&[(kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder, kCFBooleanTrue)]);
            let mut session: VTCompressionSessionRef = ptr::null_mut();
            let status = VTCompressionSessionCreate(ptr::null(), width as i32, height as i32, CODEC_H264, spec, ptr::null(), ptr::null(), on_frame, ptr::null_mut(), &mut session);
            CFRelease(spec);
            if status != 0 || session.is_null() {
                return Err(format!("Couldn't start the video encoder ({status})"));
            }
            let (bitrate, interval) = (number(rate as i32), number(super::KEY_EVERY as i32));
            VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
            VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
            VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel);
            VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, bitrate);
            VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, interval);
            CFRelease(bitrate);
            CFRelease(interval);
            VTCompressionSessionPrepareToEncodeFrames(session);
            let key_options = dictionary(&[(kVTEncodeFrameOptionKey_ForceKeyFrame, kCFBooleanTrue)]);
            Ok(Self { session, width, height, frame: 0, key_options })
        }
    }

    /// An NV12 picture VideoToolbox can take, copied row by row (its rows may be padded).
    unsafe fn picture(&self, nv12: &[u8]) -> Result<CVPixelBufferRef, String> {
        unsafe {
            let (w, h) = (self.width as usize, self.height as usize);
            let mut buffer: CVPixelBufferRef = ptr::null_mut();
            if CVPixelBufferCreate(ptr::null(), w, h, PIXELS_NV12, ptr::null(), &mut buffer) != 0 || buffer.is_null() {
                return Err("Couldn't make a video frame".into());
            }
            CVPixelBufferLockBaseAddress(buffer, 0);
            for (plane, rows, offset) in [(0usize, h, 0usize), (1, h / 2, w * h)] {
                let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane);
                let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
                for row in 0..rows {
                    ptr::copy_nonoverlapping(nv12.as_ptr().add(offset + row * w), base.add(row * stride), w);
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, 0);
            Ok(buffer)
        }
    }
}

impl super::VideoEncoder for Encoder {
    fn encode(&mut self, nv12: &[u8], width: u32, height: u32, key: bool) -> Result<Vec<u8>, String> {
        if (width, height) != (self.width, self.height) || nv12.len() < (width * height * 3 / 2) as usize {
            return Err("Frame size changed".into());
        }
        let slot: Slot = Mutex::new(None);
        unsafe {
            let picture = self.picture(nv12)?;
            let pts = CMTime { value: self.frame, timescale: 30, flags: TIME_VALID, epoch: 0 };
            self.frame += 1;
            let options = if key { self.key_options } else { ptr::null() };
            let status = VTCompressionSessionEncodeFrame(self.session, picture, pts, INVALID_TIME, options, &slot as *const Slot as *mut c_void, ptr::null_mut());
            CFRelease(picture as CFTypeRef);
            if status != 0 {
                return Err(format!("Video encoder error {status}"));
            }
            // Waits until the frame has come out (the callback has filled the slot).
            VTCompressionSessionCompleteFrames(self.session, INVALID_TIME);
        }
        let result = slot.lock().map_err(|_| "Video encoder failed".to_string())?.take();
        result.unwrap_or_else(|| Ok(Vec::new()))
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            VTCompressionSessionCompleteFrames(self.session, INVALID_TIME);
            VTCompressionSessionInvalidate(self.session);
            CFRelease(self.session as CFTypeRef);
            CFRelease(self.key_options);
        }
    }
}
