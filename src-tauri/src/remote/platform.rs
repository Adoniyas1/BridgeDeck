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

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native {
    use super::*;
    use crate::remote::input::{self, Area, Key, WheelAccumulator};
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

    fn permission_hint(error: String) -> String {
        if cfg!(target_os = "macos") {
            format!("{error}. On the Mac, allow BridgeDeck in System Settings → Privacy & Security → Screen Recording (to show the screen) and Accessibility (to control it), then restart BridgeDeck.")
        } else {
            error
        }
    }

    pub struct Screen;

    fn all() -> Result<Vec<xcap::Monitor>, String> {
        let mut monitors = xcap::Monitor::all().map_err(|e| permission_hint(e.to_string()))?;
        // Primary first, so index 0 is the main screen.
        monitors.sort_by_key(|m| !m.is_primary().unwrap_or(false));
        Ok(monitors)
    }

    impl Capturer for Screen {
        fn monitors(&mut self) -> Result<Vec<MonitorInfo>, String> {
            Ok(all()?
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

        fn capture(&mut self, index: usize) -> Result<(Vec<u8>, u32, u32), String> {
            let monitors = all()?;
            let monitor = monitors.get(index).or(monitors.first()).ok_or("No display found")?;
            let image = monitor.capture_image().map_err(|e| permission_hint(e.to_string()))?;
            let (width, height) = (image.width(), image.height());
            Ok((image.into_raw(), width, height))
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
    return Ok(Box::new(native::Screen));
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
}
