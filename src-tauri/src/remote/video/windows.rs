//! H.264 on Windows: Media Foundation's own H.264 encoder (part of Windows), in low-latency mode
//! so every frame comes straight out. It gives Annex B with SPS/PPS before key frames.

use windows::{
    core::{Interface, GUID},
    Win32::{
        Media::MediaFoundation::*,
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            Variant::VARIANT,
        },
    },
};

pub struct Encoder {
    transform: IMFTransform,
    codec: Option<ICodecAPI>,
    width: u32,
    height: u32,
    frame: i64,
}

// The transform is only used from the capture thread that made it.
unsafe impl Send for Encoder {}

const FPS: u32 = 30;

fn video_type(subtype: &GUID, width: u32, height: u32, rate: Option<u32>) -> windows::core::Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, (width as u64) << 32 | height as u64)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, (FPS as u64) << 32 | 1)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, 1u64 << 32 | 1)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        if let Some(rate) = rate {
            t.SetUINT32(&MF_MT_AVG_BITRATE, rate)?;
            t.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?;
        }
        Ok(t)
    }
}

impl Encoder {
    pub fn new(width: u32, height: u32, rate: u32) -> Result<Self, String> {
        let fail = |what: &str, e: windows::core::Error| format!("Couldn't start the video encoder ({what}: {e})");
        unsafe {
            // This thread may already be set up for COM; either way it can use it.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| fail("start", e))?;
            let transform: IMFTransform = CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER).map_err(|e| fail("create", e))?;
            // Encoders take their output type first.
            transform.SetOutputType(0, &video_type(&MFVideoFormat_H264, width, height, Some(rate)).map_err(|e| fail("type", e))?, 0).map_err(|e| fail("output", e))?;
            transform.SetInputType(0, &video_type(&MFVideoFormat_NV12, width, height, None).map_err(|e| fail("type", e))?, 0).map_err(|e| fail("input", e))?;
            let codec = transform.cast::<ICodecAPI>().ok();
            if let Some(codec) = &codec {
                let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
                let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(super::KEY_EVERY as u32));
            }
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(|e| fail("begin", e))?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(|e| fail("start", e))?;
            Ok(Self { transform, codec, width, height, frame: 0 })
        }
    }

    fn input(&self, nv12: &[u8]) -> windows::core::Result<IMFSample> {
        unsafe {
            let buffer = MFCreateMemoryBuffer(nv12.len() as u32)?;
            let mut data = std::ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, nv12.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(nv12.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            // 100-nanosecond units.
            let duration = 10_000_000 / FPS as i64;
            sample.SetSampleTime(self.frame * duration)?;
            sample.SetSampleDuration(duration)?;
            Ok(sample)
        }
    }

    /// Everything the encoder has ready.
    fn drain(&self, out: &mut Vec<u8>) -> windows::core::Result<()> {
        unsafe {
            let info = self.transform.GetOutputStreamInfo(0)?;
            let provides = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            loop {
                let sample = if provides {
                    None
                } else {
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(self.width * self.height * 2))?)?;
                    Some(sample)
                };
                let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: std::mem::ManuallyDrop::new(sample), dwStatus: 0, pEvents: std::mem::ManuallyDrop::new(None) }];
                let mut status = 0u32;
                let result = self.transform.ProcessOutput(0, &mut buffers, &mut status);
                let sample = std::mem::ManuallyDrop::take(&mut buffers[0].pSample);
                drop(std::mem::ManuallyDrop::take(&mut buffers[0].pEvents));
                match result {
                    Ok(()) => {
                        if let Some(sample) = sample {
                            let buffer = sample.ConvertToContiguousBuffer()?;
                            let mut data = std::ptr::null_mut();
                            let mut len = 0u32;
                            buffer.Lock(&mut data, None, Some(&mut len))?;
                            out.extend_from_slice(std::slice::from_raw_parts(data, len as usize));
                            buffer.Unlock()?;
                        }
                    }
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                    Err(e) => return Err(e),
                }
            }
        }
    }
}

impl super::VideoEncoder for Encoder {
    fn encode(&mut self, nv12: &[u8], width: u32, height: u32, key: bool) -> Result<Vec<u8>, String> {
        if (width, height) != (self.width, self.height) {
            return Err("Frame size changed".into());
        }
        if key {
            if let Some(codec) = &self.codec {
                unsafe {
                    let _ = codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
                }
            }
        }
        let sample = self.input(nv12).map_err(|e| format!("Video encoder: {e}"))?;
        self.frame += 1;
        let mut out = Vec::new();
        unsafe {
            match self.transform.ProcessInput(0, &sample, 0) {
                Ok(()) => {}
                // Full: take what's ready, then hand the frame in again.
                Err(e) if e.code() == MF_E_NOTACCEPTING => {
                    self.drain(&mut out).map_err(|e| format!("Video encoder: {e}"))?;
                    self.transform.ProcessInput(0, &sample, 0).map_err(|e| format!("Video encoder: {e}"))?;
                }
                Err(e) => return Err(format!("Video encoder: {e}")),
            }
        }
        self.drain(&mut out).map_err(|e| format!("Video encoder: {e}"))?;
        Ok(out)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        }
    }
}
