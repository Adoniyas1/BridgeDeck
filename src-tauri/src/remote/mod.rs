//! Remote control built into BridgeDeck (roadmap Phase 5): a paired device's screen in a tab.
//!
//! - `host`: this computer shares a monitor and takes input from a paired device (macOS, Windows).
//! - `viewer`: this computer shows another device's screen in a `remote-session` tab.
//! - Both ends talk over one long-lived stream on the encrypted BridgeLink connection
//!   (`/remote/session`): the viewer sends `ViewerMsg` frames (input goes out the moment it happens),
//!   the host answers with `HostMsg` frames, each followed by its payload: JPEG tiles, or H.264
//!   when both ends can (`video`), and the computer's sound when the viewer turns it on (`audio`).
//!
//! Safety (D15): paired devices connect without a prompt unless this computer is set to ask first or
//! to refuse. Every session shows a "being controlled" banner here, with Stop; the tray has Stop too.

pub mod audio;
pub mod codec;
pub mod host;
pub mod input;
pub mod mimir;
pub mod platform;
pub mod video;
pub mod viewer;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ViewerMsg {
    #[serde(rename_all = "camelCase")]
    Hello {
        monitor: usize,
        max_width: u32,
        quality: u8,
        /// Who is viewing, when it isn't a person ("Mimir"); shown in the host's banner.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
        /// Video codecs the viewer can decode ("h264"); none means JPEG tiles.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        codecs: Vec<String>,
        /// Send the computer's sound too.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        audio: bool,
    },
    /// The last frame is drawn; send the next one when something changes.
    Next,
    #[serde(rename_all = "camelCase")]
    Settings {
        monitor: Option<usize>,
        max_width: Option<u32>,
        quality: Option<u8>,
        /// Sound on or off.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio: Option<bool>,
        /// Back to tiles ("tiles") when the viewer's video decoder failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        codec: Option<String>,
    },
    Input { events: Vec<input::InputEvent> },
    Stop,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostMsg {
    #[serde(rename_all = "camelCase")]
    Ready {
        monitors: Vec<platform::MonitorInfo>,
        monitor: usize,
        host_name: String,
        platform: String,
        /// The video codec frames come in ("h264"), or none for JPEG tiles.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        video: Option<String>,
        /// Whether this computer can send its sound.
        #[serde(default)]
        audio: bool,
    },
    /// Followed by one raw frame of `bytes` bytes (the tiles' JPEGs, in order) when `bytes > 0`.
    Frame { seq: u64, width: u32, height: u32, tiles: Vec<codec::TileHeader>, bytes: u32 },
    /// Followed by `bytes` bytes of H.264 (Annex B). `key`: decodable on its own.
    #[serde(rename_all = "camelCase")]
    Video { seq: u64, width: u32, height: u32, key: bool, bytes: u32 },
    /// Followed by `bytes` bytes of sound: 16-bit little-endian samples, interleaved. `rate` 0 (and
    /// no bytes) says the sound can't be captured here.
    Audio { rate: u32, channels: u16, bytes: u32 },
    Ended { reason: String },
}

pub const SESSION_PATH: &str = "/remote/session";
