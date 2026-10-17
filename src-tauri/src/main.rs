// A windowed app on Windows: no console window opens with it (debug builds keep one, for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bridgedeck_lib::run();
}
