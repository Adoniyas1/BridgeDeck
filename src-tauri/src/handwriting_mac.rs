//! Reading handwriting with Apple's Vision framework on the Mac (on this computer, no download):
//! text recognition in "accurate" mode with the course's own words, line by line with how sure it
//! is of each. Other computers use text recognition in the window or Mimir instead.

use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct Line {
    pub text: String,
    pub confidence: f32,
}

#[cfg(target_os = "macos")]
pub fn recognize(image: &[u8], words: &[String]) -> Result<Vec<Line>, String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

    let data = NSData::with_bytes(image);
    let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &NSDictionary::new());
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    let custom: Vec<Retained<NSString>> = words.iter().take(200).map(|w| NSString::from_str(w)).collect();
    let custom_refs: Vec<&NSString> = custom.iter().map(|w| &**w).collect();
    request.setCustomWords(&NSArray::from_slice(&custom_refs));
    let as_request: &VNRequest = &request;
    handler.performRequests_error(&NSArray::from_slice(&[as_request])).map_err(|e| format!("Vision couldn't read it: {}", e.localizedDescription()))?;
    let mut lines = Vec::new();
    if let Some(results) = request.results() {
        for observation in results.iter() {
            if let Some(best) = observation.topCandidates(1).firstObject() {
                lines.push(Line { text: best.string().to_string(), confidence: best.confidence() });
            }
        }
    }
    Ok(lines)
}

/// The page's corners in a photo (top-left, top-right, bottom-right, bottom-left), as fractions of
/// its width and height from the top-left, found by Vision's document detection.
#[cfg(target_os = "macos")]
pub fn page_corners(image: &[u8]) -> Result<Option<Vec<Point>>, String> {
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{VNDetectDocumentSegmentationRequest, VNImageRequestHandler, VNRequest};

    let data = NSData::with_bytes(image);
    let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &NSDictionary::new());
    let request = unsafe { VNDetectDocumentSegmentationRequest::new() };
    let as_request: &VNRequest = &request;
    handler.performRequests_error(&NSArray::from_slice(&[as_request])).map_err(|e| format!("Vision couldn't look at it: {}", e.localizedDescription()))?;
    // Vision's points run from the bottom-left; the crop screen's from the top-left.
    let page = unsafe { request.results() }.and_then(|r| r.firstObject()).map(|o| unsafe {
        [o.topLeft(), o.topRight(), o.bottomRight(), o.bottomLeft()].iter().map(|p| Point { x: p.x, y: 1.0 - p.y }).collect::<Vec<_>>()
    });
    Ok(page)
}

#[cfg(not(target_os = "macos"))]
pub fn page_corners(_image: &[u8]) -> Result<Option<Vec<Point>>, String> {
    Err("Apple's page finding is only on the Mac".into())
}

#[derive(Serialize, Debug, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[cfg(not(target_os = "macos"))]
pub fn recognize(_image: &[u8], _words: &[String]) -> Result<Vec<Line>, String> {
    Err("Apple's handwriting reading is only on the Mac".into())
}

fn course_photo(course: &str, file: &str) -> Result<std::path::PathBuf, String> {
    let root = crate::study::current_root()?;
    let encode = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    crate::study::resolve(&root, &format!("/{}/{}", encode(course), encode(file))).ok_or_else(|| "No such photo".to_string())
}

/// The page's corners in a course photo, found by Vision (Mac only): a starting point for the
/// crop screen.
#[tauri::command]
pub async fn handwriting_page_corners(course: String, file: String) -> Result<Option<Vec<Point>>, String> {
    let path = course_photo(&course, &file)?;
    tauri::async_runtime::spawn_blocking(move || page_corners(&std::fs::read(&path).map_err(|e| e.to_string())?)).await.map_err(|e| e.to_string())?
}

/// Reads a photo in a course (library pictures only) with Vision.
#[tauri::command]
pub async fn handwriting_vision(course: String, file: String, words: Vec<String>) -> Result<Vec<Line>, String> {
    let path = course_photo(&course, &file)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        recognize(&bytes, &words)
    })
    .await
    .map_err(|e| e.to_string())?
}
