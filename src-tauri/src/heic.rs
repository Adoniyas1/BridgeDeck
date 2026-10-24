//! iPhone photos in HEIC turned into JPEG, so every part of the Study tab (the page straightener,
//! handwriting, text recognition) can read them. On Windows through WIC (needs Microsoft's HEIF and
//! HEVC extensions, which most PCs have); on the Mac through `sips`.

use std::path::Path;

/// The JPEG bytes of a HEIC file, upright.
pub fn to_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    imp::to_jpeg(path)
}

#[cfg(target_os = "windows")]
mod imp {
    use std::path::Path;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToUInt16, PROPVARIANT};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    pub fn to_jpeg(path: &Path) -> Result<Vec<u8>, String> {
        let missing = "Windows couldn't open this HEIC photo. Install “HEIF Image Extensions” and “HEVC Video Extensions” from the Microsoft Store, or set the iPhone's Camera → Formats to Most Compatible.";
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let name = HSTRING::from(path.as_os_str());
            let decoder = factory.CreateDecoderFromFilename(PCWSTR(name.as_ptr()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand).map_err(|_| missing.to_string())?;
            let frame = decoder.GetFrame(0).map_err(|_| missing.to_string())?;
            // Photos are stored as the sensor saw them, with the way up in the metadata (EXIF numbering).
            let orientation = frame.GetMetadataQueryReader().ok().and_then(|reader| {
                let mut value = PROPVARIANT::default();
                let found = reader.GetMetadataByName(&HSTRING::from("System.Photo.Orientation"), &mut value).ok().and_then(|_| PropVariantToUInt16(&value).ok());
                let _ = PropVariantClear(&mut value);
                found
            }).unwrap_or(1);
            let turn = match orientation {
                3 => Some(WICBitmapTransformRotate180),
                6 => Some(WICBitmapTransformRotate90),
                8 => Some(WICBitmapTransformRotate270),
                _ => None,
            };
            let source: IWICBitmapSource = match turn {
                Some(t) => {
                    let rotator = factory.CreateBitmapFlipRotator().map_err(|e| e.to_string())?;
                    rotator.Initialize(&frame, t).map_err(|e| e.to_string())?;
                    windows::core::Interface::cast(&rotator).map_err(|e| e.to_string())?
                }
                None => windows::core::Interface::cast(&frame).map_err(|e| e.to_string())?,
            };
            let converter = factory.CreateFormatConverter().map_err(|e| e.to_string())?;
            converter.Initialize(&source, &GUID_WICPixelFormat24bppRGB, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom).map_err(|e| e.to_string())?;
            let (mut w, mut h) = (0u32, 0u32);
            converter.GetSize(&mut w, &mut h).map_err(|e| e.to_string())?;
            if w == 0 || h == 0 || w > 16_000 || h > 16_000 {
                return Err("The photo is an odd size".into());
            }
            let stride = w * 3;
            let mut rgb = vec![0u8; (stride * h) as usize];
            converter.CopyPixels(std::ptr::null(), stride, &mut rgb).map_err(|e| e.to_string())?;
            super::encode(&rgb, w, h)
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;

    pub fn to_jpeg(path: &Path) -> Result<Vec<u8>, String> {
        let out = std::env::temp_dir().join(format!("bridgedeck-heic-{}.jpg", std::process::id()));
        let status = std::process::Command::new("/usr/bin/sips").args(["-s", "format", "jpeg", "-s", "formatOptions", "88"]).arg(path).arg("--out").arg(&out)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map_err(|e| e.to_string())?;
        let bytes = if status.success() { std::fs::read(&out).map_err(|e| e.to_string()) } else { Err("The Mac couldn't convert this photo".into()) };
        let _ = std::fs::remove_file(&out);
        bytes
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    pub fn to_jpeg(_path: &std::path::Path) -> Result<Vec<u8>, String> {
        Err("HEIC photos can't be converted on this computer".into())
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn encode(rgb: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    if w > u16::MAX as u32 || h > u16::MAX as u32 {
        return Err("The photo is too big".into());
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, 88).encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_rgb_as_jpeg() {
        let jpeg = super::encode(&[200u8; 8 * 4 * 3], 8, 4).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    }
}
