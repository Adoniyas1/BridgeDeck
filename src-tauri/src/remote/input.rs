#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
//! Mouse and keyboard events from the viewer, and how they map to this computer's input.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum InputEvent {
    /// Position on the shared monitor, 0..1 in each direction.
    Move { x: f64, y: f64 },
    /// "left" | "right" | "middle"
    Button { button: String, down: bool },
    /// Wheel deltas in CSS pixels (as the browser reports them).
    Wheel { dx: f64, dy: f64 },
    /// A key by its `KeyboardEvent.key` name ("Enter", "ArrowUp", "Meta") or a single character.
    Key { key: String, down: bool },
    /// Text typed through an input method (committed composition).
    Text { text: String },
}

/// Keys BridgeDeck can press, independent of the input library.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Backspace,
    Tab,
    Escape,
    Space,
    Delete,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    Shift,
    Control,
    Alt,
    /// Command on macOS, the Windows key on Windows.
    Meta,
    CapsLock,
    F(u8),
}

pub fn key(name: &str) -> Option<Key> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.clone().next()) {
        return Some(if c == ' ' { Key::Space } else { Key::Char(c) });
    }
    Some(match name {
        "Enter" => Key::Enter,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowUp" => Key::Up,
        "ArrowDown" => Key::Down,
        "ArrowLeft" => Key::Left,
        "ArrowRight" => Key::Right,
        "Shift" => Key::Shift,
        "Control" => Key::Control,
        "Alt" | "Option" => Key::Alt,
        "Meta" | "OS" | "Command" => Key::Meta,
        "CapsLock" => Key::CapsLock,
        f if f.starts_with('F') => match f[1..].parse::<u8>() {
            Ok(n @ 1..=12) => Key::F(n),
            _ => return None,
        },
        _ => return None,
    })
}

/// Turns wheel pixels into whole scroll steps, keeping the remainder (trackpads send small deltas).
#[derive(Default)]
pub struct WheelAccumulator {
    x: f64,
    y: f64,
}

pub const PIXELS_PER_STEP: f64 = 40.0;

impl WheelAccumulator {
    pub fn add(&mut self, dx: f64, dy: f64) -> (i32, i32) {
        self.x += dx.clamp(-2000.0, 2000.0);
        self.y += dy.clamp(-2000.0, 2000.0);
        let steps_x = (self.x / PIXELS_PER_STEP).trunc();
        let steps_y = (self.y / PIXELS_PER_STEP).trunc();
        self.x -= steps_x * PIXELS_PER_STEP;
        self.y -= steps_y * PIXELS_PER_STEP;
        (steps_x as i32, steps_y as i32)
    }
}

/// Monitor geometry in the input library's coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Area {
    /// A 0..1 position to absolute coordinates (clamped to the monitor).
    pub fn point(&self, x: f64, y: f64) -> (i32, i32) {
        let x = x.clamp(0.0, 1.0) * (self.width.saturating_sub(1)) as f64;
        let y = y.clamp(0.0, 1.0) * (self.height.saturating_sub(1)) as f64;
        (self.x + x.round() as i32, self.y + y.round() as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_by_name() {
        assert_eq!(key("a"), Some(Key::Char('a')));
        assert_eq!(key(" "), Some(Key::Space));
        assert_eq!(key("é"), Some(Key::Char('é')));
        assert_eq!(key("ArrowLeft"), Some(Key::Left));
        assert_eq!(key("Meta"), Some(Key::Meta));
        assert_eq!(key("F12"), Some(Key::F(12)));
        assert_eq!(key("F13"), None);
        assert_eq!(key("Dead"), None);
        assert_eq!(key(""), None);
    }

    #[test]
    fn input_events_parse() {
        let event: InputEvent = serde_json::from_str(r#"{"t":"move","x":0.5,"y":0.25}"#).unwrap();
        assert_eq!(event, InputEvent::Move { x: 0.5, y: 0.25 });
        let event: InputEvent = serde_json::from_str(r#"{"t":"key","key":"Enter","down":true}"#).unwrap();
        assert_eq!(event, InputEvent::Key { key: "Enter".into(), down: true });
        assert!(serde_json::from_str::<InputEvent>(r#"{"t":"exec","cmd":"x"}"#).is_err());
    }

    #[test]
    fn wheel_steps_keep_the_remainder() {
        let mut wheel = WheelAccumulator::default();
        assert_eq!(wheel.add(0.0, 30.0), (0, 0));
        assert_eq!(wheel.add(0.0, 30.0), (0, 1));
        assert_eq!(wheel.add(0.0, -100.0), (0, -2));
        assert_eq!(wheel.add(120.0, 0.0), (3, 0));
    }

    #[test]
    fn points_land_on_the_monitor() {
        let second = Area { x: 1920, y: 0, width: 1440, height: 900 };
        assert_eq!(second.point(0.0, 0.0), (1920, 0));
        assert_eq!(second.point(1.0, 1.0), (1920 + 1439, 899));
        assert_eq!(second.point(2.0, -1.0), (1920 + 1439, 0), "clamped");
    }
}
