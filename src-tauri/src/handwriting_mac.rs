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

#[cfg(not(target_os = "macos"))]
pub fn recognize(_image: &[u8], _words: &[String]) -> Result<Vec<Line>, String> {
    Err("Apple's handwriting reading is only on the Mac".into())
}

/// Reads a photo in a course (library pictures only) with Vision.
#[tauri::command]
pub async fn handwriting_vision(course: String, file: String, words: Vec<String>) -> Result<Vec<Line>, String> {
    let root = crate::study::current_root()?;
    let encode = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    let path = crate::study::resolve(&root, &format!("/{}/{}", encode(&course), encode(&file))).ok_or("No such photo")?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        recognize(&bytes, &words)
    })
    .await
    .map_err(|e| e.to_string())?
}
