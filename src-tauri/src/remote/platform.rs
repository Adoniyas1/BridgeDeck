//! The two things only the operating system can do: capture a monitor and inject input.
//! macOS (ScreenCaptureKit/CoreGraphics via `xcap`, CGEvent via `enigo`) and Windows (DXGI/GDI,
//! SendInput). Elsewhere this computer can control others but can't be controlled.

use super::input::InputEvent;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// Captures monitors. Created and used on one thread.
pub trait Capturer {
    fn monitors(&mut self) -> Result<Vec<MonitorInfo>, String>;
    /// RGBA pixels of monitor `index`, with its pixel size.
    fn capture(&mut self, index: usize) -> Result<(Vec<u8>, u32, u32), String>;
}

/// Injects input. Created and used on one thread.
pub trait Injector {
    fn apply(&mut self, monitor: usize, event: &InputEvent) -> Result<(), String>;
}

pub const UNSUPPORTED: &str = "This computer can't be controlled remotely (BridgeDeck supports macOS and Windows hosts).";

/// Same picture, allowing for the mouse pointer (streams on the Mac draw it; screenshots don't).
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn nearly_same(a: &(Vec<u8>, u32, u32), b: &(Vec<u8>, u32, u32)) -> bool {
    if (a.1, a.2) != (b.1, b.2) || a.0.len() != b.0.len() {
        return false;
    }
    let differing = a.0.chunks_exact(4).zip(b.0.chunks_exact(4)).filter(|(x, y)| x != y).count();
    differing <= (a.0.len() / 4) / 200
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native {
    use super::*;
    use crate::remote::input::{self, Area, Key, WheelAccumulator};
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
    use std::time::{Duration, Instant};

    fn permission_hint(error: String) -> String {
        if cfg!(target_os = "macos") {
            format!("{error}. On the Mac, allow BridgeDeck in System Settings → Privacy & Security → Screen Recording (to show the screen) and Accessibility (to control it), then restart BridgeDeck.")
        } else {
            error
        }
    }

    type Pixels = (Vec<u8>, u32, u32);

    /// Keeps the display list between frames; it's listed again only when a capture fails
    /// (a display was unplugged or rearranged).
    #[derive(Default)]
    pub struct Screen {
        monitors: Option<Vec<xcap::Monitor>>,
        /// The OS frame stream for the shared display (AVFoundation on macOS, Desktop Duplication
        /// on Windows): far cheaper than a full screenshot per frame.
        stream: Option<Stream>,
        /// Streams that stopped working this session; after a few, screenshots only.
        stream_failures: u8,
    }

    const MAX_STREAM_FAILURES: u8 = 3;
    /// A stream that hasn't delivered a single frame by now isn't going to.
    const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);
    /// After this long without a streamed frame, a screenshot confirms the screen really is still
    /// (Windows' stream can stop silently, e.g. after the lock screen or a resolution change).
    const QUIET_CHECK: Duration = Duration::from_secs(2);

    type Recorder = (xcap::VideoRecorder, Receiver<xcap::Frame>);

    /// Windows' recorder keeps its thread and its screen duplication after being stopped, so each
    /// display's recorder is parked here when a session ends and reused by the next one.
    #[cfg(target_os = "windows")]
    static PARKED: std::sync::Mutex<Vec<(u32, Recorder)>> = std::sync::Mutex::new(Vec::new());

    struct Stream {
        monitor: usize,
        #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
        id: u32,
        recorder: Option<Recorder>,
        /// The newest picture, returned again while the screen doesn't change (Windows only sends
        /// a frame when something changed).
        last: Pixels,
        delivered: bool,
        started: Instant,
        /// When a frame last arrived, or a screenshot last matched `last`.
        confirmed: Instant,
        /// Screenshots in a row that showed something the stream didn't.
        misses: u8,
    }

    impl Stream {
        /// `now` is a screenshot taken as the stream starts, shown until the first streamed frame.
        fn start(monitor: &xcap::Monitor, index: usize, now: Pixels) -> Result<Self, String> {
            let id = monitor.id().map_err(|e| e.to_string())?;
            #[cfg(target_os = "windows")]
            let parked = {
                let mut parked = PARKED.lock().unwrap_or_else(|e| e.into_inner());
                parked.iter().position(|(parked_id, _)| *parked_id == id).map(|i| parked.swap_remove(i).1)
            };
            #[cfg(not(target_os = "windows"))]
            let parked: Option<Recorder> = None;
            let reused = parked.is_some();
            let (recorder, frames) = match parked {
                Some(recorder) => recorder,
                None => monitor.video_recorder().map_err(|e| e.to_string())?,
            };
            recorder.start().map_err(|e| e.to_string())?;
            // A reused recorder may be holding a frame from the last session: drop it. If nothing
            // changes from here on it sends nothing, which is fine, since `now` is current.
            while frames.try_recv().is_ok() {}
            Ok(Self { monitor: index, id, recorder: Some((recorder, frames)), last: now, delivered: reused, started: Instant::now(), confirmed: Instant::now(), misses: 0 })
        }

        /// The newest picture. Frames are handed over one at a time and the one waiting may be a
        /// little old, so a fresher one that follows at once is preferred. Err: the stream died.
        fn latest(&mut self) -> Result<Pixels, ()> {
            let frames = &self.recorder.as_ref().ok_or(())?.1;
            let mut newest = match frames.try_recv() {
                Ok(frame) => Some(frame),
                Err(TryRecvError::Disconnected) => return Err(()),
                Err(TryRecvError::Empty) => match frames.recv_timeout(Duration::from_millis(40)) {
                    Ok(frame) => Some(frame),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return Err(()),
                },
            };
            if newest.is_some() {
                while let Ok(frame) = frames.recv_timeout(Duration::from_millis(15)) {
                    newest = Some(frame);
                }
            }
            match newest {
                Some(frame) => {
                    self.delivered = true;
                    self.confirmed = Instant::now();
                    self.misses = 0;
                    self.last = (frame.raw, frame.width, frame.height);
                }
                None if !self.delivered && self.started.elapsed() > FIRST_FRAME_TIMEOUT => return Err(()),
                None => {}
            }
            Ok(self.last.clone())
        }

        /// Stops it for good (it failed), rather than parking it for reuse.
        fn discard(mut self) {
            if let Some((recorder, _)) = self.recorder.take() {
                let _ = recorder.stop();
            }
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            if let Some((recorder, frames)) = self.recorder.take() {
                let _ = recorder.stop();
                #[cfg(target_os = "windows")]
                PARKED.lock().unwrap_or_else(|e| e.into_inner()).push((self.id, (recorder, frames)));
                #[cfg(not(target_os = "windows"))]
                drop(frames);
            }
        }
    }

    impl Screen {
        fn cached(&mut self) -> Result<&Vec<xcap::Monitor>, String> {
            if self.monitors.is_none() {
                self.monitors = Some(all()?);
            }
            Ok(self.monitors.as_ref().expect("just set"))
        }

        fn screenshot(&mut self, index: usize) -> Result<Pixels, String> {
            let monitors = self.cached()?;
            let monitor = monitors.get(index).or(monitors.first()).ok_or("No display found")?;
            let image = match monitor.capture_image() {
                Ok(image) => image,
                Err(error) => {
                    self.monitors = None;
                    return Err(permission_hint(error.to_string()));
                }
            };
            let (width, height) = (image.width(), image.height());
            Ok((image.into_raw(), width, height))
        }
    }

    fn all() -> Result<Vec<xcap::Monitor>, String> {
        let mut monitors = xcap::Monitor::all().map_err(|e| permission_hint(e.to_string()))?;
        // Primary first, so index 0 is the main screen.
        monitors.sort_by_key(|m| !m.is_primary().unwrap_or(false));
        Ok(monitors)
    }

    impl Capturer for Screen {
        fn monitors(&mut self) -> Result<Vec<MonitorInfo>, String> {
            self.monitors = None;
            Ok(self
                .cached()?
                .iter()
                .enumerate()
                .map(|(index, m)| MonitorInfo {
                    index,
                    name: m.friendly_name().or_else(|_| m.name()).unwrap_or_else(|_| format!("Display {}", index + 1)),
                    width: m.width().unwrap_or(0),
                    height: m.height().unwrap_or(0),
                    primary: m.is_primary().unwrap_or(false),
                })
                .collect())
        }

        fn capture(&mut self, index: usize) -> Result<Pixels, String> {
            if self.stream.as_ref().is_some_and(|s| s.monitor != index) {
                self.stream = None;
            }
            if let Some(stream) = self.stream.as_mut() {
                match stream.latest() {
                    Ok(pixels) if stream.confirmed.elapsed() < QUIET_CHECK => return Ok(pixels),
                    Ok(pixels) => {
                        let now = self.screenshot(index)?;
                        let stream = self.stream.as_mut().expect("checked");
                        stream.confirmed = Instant::now();
                        if nearly_same(&now, &pixels) {
                            stream.misses = 0;
                            return Ok(pixels);
                        }
                        // The screen changed and the stream didn't say so; twice in a row: it's dead.
                        stream.misses += 1;
                        stream.last = now.clone();
                        if stream.misses < 2 {
                            return Ok(now);
                        }
                        self.stream.take().expect("checked").discard();
                        self.stream_failures += 1;
                        return Ok(now);
                    }
                    Err(()) => {
                        self.stream.take().expect("checked").discard();
                        self.stream_failures += 1;
                    }
                }
            }
            let now = self.screenshot(index)?;
            if self.stream.is_none() && self.stream_failures < MAX_STREAM_FAILURES {
                let monitors = self.cached()?;
                let monitor = monitors.get(index).or(monitors.first()).ok_or("No display found")?;
                match Stream::start(monitor, index, now.clone()) {
                    Ok(stream) => self.stream = Some(stream),
                    Err(_) => self.stream_failures = MAX_STREAM_FAILURES,
                }
            }
            Ok(now)
        }
    }

    pub fn area(index: usize) -> Result<Area, String> {
        let monitors = all()?;
        let m = monitors.get(index).or(monitors.first()).ok_or("No display found")?;
        Ok(Area { x: m.x().unwrap_or(0), y: m.y().unwrap_or(0), width: m.width().unwrap_or(0), height: m.height().unwrap_or(0) })
    }

    pub struct Input {
        enigo: Enigo,
        wheel: WheelAccumulator,
        areas: Vec<Option<Area>>,
    }

    impl Input {
        pub fn new() -> Result<Self, String> {
            let settings = Settings { release_keys_when_dropped: true, ..Settings::default() };
            let enigo = Enigo::new(&settings).map_err(|e| permission_hint(e.to_string()))?;
            Ok(Self { enigo, wheel: WheelAccumulator::default(), areas: Vec::new() })
        }

        fn area(&mut self, monitor: usize) -> Result<Area, String> {
            if self.areas.len() <= monitor {
                self.areas.resize(monitor + 1, None);
            }
            if let Some(area) = self.areas[monitor] {
                return Ok(area);
            }
            let found = area(monitor)?;
            self.areas[monitor] = Some(found);
            Ok(found)
        }
    }

    fn enigo_key(key: Key) -> enigo::Key {
        use enigo::Key as K;
        match key {
            Key::Char(c) => K::Unicode(c),
            Key::Enter => K::Return,
            Key::Backspace => K::Backspace,
            Key::Tab => K::Tab,
            Key::Escape => K::Escape,
            Key::Space => K::Space,
            Key::Delete => K::Delete,
            Key::Home => K::Home,
            Key::End => K::End,
            Key::PageUp => K::PageUp,
            Key::PageDown => K::PageDown,
            Key::Up => K::UpArrow,
            Key::Down => K::DownArrow,
            Key::Left => K::LeftArrow,
            Key::Right => K::RightArrow,
            Key::Shift => K::Shift,
            Key::Control => K::Control,
            Key::Alt => K::Alt,
            Key::Meta => K::Meta,
            Key::CapsLock => K::CapsLock,
            Key::F(n) => [K::F1, K::F2, K::F3, K::F4, K::F5, K::F6, K::F7, K::F8, K::F9, K::F10, K::F11, K::F12][(n.clamp(1, 12) - 1) as usize],
        }
    }

    impl Injector for Input {
        fn apply(&mut self, monitor: usize, event: &InputEvent) -> Result<(), String> {
            let result = match event {
                InputEvent::Move { x, y } => {
                    let (x, y) = self.area(monitor)?.point(*x, *y);
                    self.enigo.move_mouse(x, y, Coordinate::Abs)
                }
                InputEvent::Button { button, down } => {
                    let button = match button.as_str() {
                        "right" => Button::Right,
                        "middle" => Button::Middle,
                        _ => Button::Left,
                    };
                    self.enigo.button(button, if *down { Direction::Press } else { Direction::Release })
                }
                InputEvent::Wheel { dx, dy } => {
                    let (steps_x, steps_y) = self.wheel.add(*dx, *dy);
                    let mut result = Ok(());
                    if steps_y != 0 {
                        result = self.enigo.scroll(steps_y, Axis::Vertical);
                    }
                    if steps_x != 0 && result.is_ok() {
                        result = self.enigo.scroll(steps_x, Axis::Horizontal);
                    }
                    result
                }
                InputEvent::Key { key, down } => match input::key(key) {
                    Some(key) => self.enigo.key(enigo_key(key), if *down { Direction::Press } else { Direction::Release }),
                    None => Ok(()),
                },
                InputEvent::Text { text } => self.enigo.text(&text.chars().take(1000).collect::<String>()),
            };
            result.map_err(|e| permission_hint(e.to_string()))
        }
    }
}

pub fn capturer() -> Result<Box<dyn Capturer>, String> {
    #[cfg(test)]
    if let Some(fake) = tests::FAKE.lock().unwrap().clone() {
        return Ok(Box::new(fake));
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return Ok(Box::new(native::Screen::default()));
    #[allow(unreachable_code)]
    Err(UNSUPPORTED.into())
}

pub fn injector() -> Result<Box<dyn Injector>, String> {
    #[cfg(test)]
    if let Some(fake) = tests::FAKE.lock().unwrap().clone() {
        return Ok(Box::new(fake));
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return Ok(Box::new(native::Input::new()?));
    #[allow(unreachable_code)]
    Err(UNSUPPORTED.into())
}

pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A screen whose pixels change on every capture, recording the input it gets.
    #[derive(Clone, Default)]
    pub(crate) struct FakeScreen {
        pub frames: Arc<Mutex<u32>>,
        pub input: Arc<Mutex<Vec<(usize, InputEvent)>>>,
    }

    /// Set by tests: capture and input use this instead of the real screen (on any thread).
    pub(crate) static FAKE: Mutex<Option<FakeScreen>> = Mutex::new(None);

    impl Capturer for FakeScreen {
        fn monitors(&mut self) -> Result<Vec<MonitorInfo>, String> {
            Ok(vec![MonitorInfo { index: 0, name: "Fake".into(), width: 320, height: 200, primary: true }])
        }
        fn capture(&mut self, _: usize) -> Result<(Vec<u8>, u32, u32), String> {
            let mut frames = self.frames.lock().unwrap();
            *frames += 1;
            // A small moving square: after the first frame only its tiles change.
            let (w, h) = (320u32, 200u32);
            let mut pixels = vec![30u8; (w * h * 4) as usize];
            let at = (*frames * 7 % 150) as usize;
            for y in 10..30 {
                for x in at..at + 20 {
                    pixels[(y * w as usize + x) * 4] = 250;
                }
            }
            Ok((pixels, w, h))
        }
    }

    impl Injector for FakeScreen {
        fn apply(&mut self, monitor: usize, event: &InputEvent) -> Result<(), String> {
            self.input.lock().unwrap().push((monitor, event.clone()));
            Ok(())
        }
    }

    #[test]
    fn a_moved_pointer_is_still_the_same_picture() {
        let screen = (vec![10u8; 100 * 100 * 4], 100, 100);
        let mut pointer = screen.clone();
        pointer.0[..40 * 4].fill(255); // 40 of 10,000 pixels
        assert!(nearly_same(&screen, &pointer));
        let mut window = screen.clone();
        window.0[..2000 * 4].fill(255);
        assert!(!nearly_same(&screen, &window));
        assert!(!nearly_same(&screen, &(vec![10u8; 50 * 200 * 4], 50, 200)));
    }
}
