//! Remote control built into BridgeDeck (roadmap Phase 5): a paired device's screen in a tab.
//!
//! - `host`: this computer shares a monitor and takes input from a paired device (macOS, Windows).
//! - `viewer`: this computer shows another device's screen in a `remote-session` tab.
//! - Both ends talk over one long-lived stream on the encrypted BridgeLink connection
//!   (`/remote/session`): the viewer sends `ViewerMsg` frames (input goes out the moment it happens),
//!   the host answers with `HostMsg` frames, each video frame followed by its JPEG tiles.
//!
//! Safety (D15): paired devices connect without a prompt unless this computer is set to ask first or
//! to refuse. Every session shows a "being controlled" banner here, with Stop; the tray has Stop too.

pub mod codec;
pub mod host;
pub mod input;
pub mod platform;
pub mod viewer;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ViewerMsg {
    #[serde(rename_all = "camelCase")]
    Hello { monitor: usize, max_width: u32, quality: u8 },
    /// The last frame is drawn; send the next one when something changes.
    Next,
    #[serde(rename_all = "camelCase")]
    Settings { monitor: Option<usize>, max_width: Option<u32>, quality: Option<u8> },
    Input { events: Vec<input::InputEvent> },
    Stop,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostMsg {
    #[serde(rename_all = "camelCase")]
    Ready { monitors: Vec<platform::MonitorInfo>, monitor: usize, host_name: String, platform: String },
    /// Followed by one raw frame of `bytes` bytes (the tiles' JPEGs, in order) when `bytes > 0`.
    Frame { seq: u64, width: u32, height: u32, tiles: Vec<codec::TileHeader>, bytes: u32 },
    Ended { reason: String },
}

pub const SESSION_PATH: &str = "/remote/session";
