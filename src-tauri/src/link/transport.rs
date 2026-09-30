//! QUIC transport between paired devices. One connection per device, reused; every request is its
//! own bidirectional stream, so a slow request (an approval dialog, a long-poll) never blocks another.
//! Frames are a 4-byte big-endian length followed by JSON.

use super::{identity::Identity, tls};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    future::Future,
    net::{SocketAddr, UdpSocket},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

pub const MAX_FRAME: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    #[serde(default)]
    pub body: String,
}

impl Response {
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self { status, body: body.into() }
    }
}

/// Who opened a stream: the certificate fingerprint proven in the handshake, and where from.
#[derive(Clone, Debug)]
pub struct Caller {
    pub fingerprint: String,
    pub address: SocketAddr,
}

pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Serves streams the other side opens.
pub trait Handler: Send + Sync + 'static {
    /// One request/response. Runs on a blocking thread, so it may wait (for example on a dialog).
    fn handle(&self, caller: Caller, request: Request) -> Response;
    /// A stream whose first request has `path` in `Handler::stream_paths` (pairing): the handler owns
    /// the stream and exchanges as many frames as it needs.
    fn stream(&self, caller: Caller, request: Request, send: quinn::SendStream, recv: quinn::RecvStream) -> BoxFuture;
    fn stream_paths(&self) -> &'static [&'static str];
}

pub async fn write_frame<T: Serialize>(send: &mut quinn::SendStream, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FRAME {
        return Err("Message too large".into());
    }
    send.write_all(&(bytes.len() as u32).to_be_bytes()).await.map_err(|e| e.to_string())?;
    send.write_all(&bytes).await.map_err(|e| e.to_string())
}

pub async fn read_frame<T: DeserializeOwned>(recv: &mut quinn::RecvStream) -> Result<T, String> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err("Message too large".into());
    }
    let mut bytes = vec![0u8; len];
    recv.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub struct Link {
    endpoint: quinn::Endpoint,
    identity: Identity,
    /// Open connections by the peer's certificate fingerprint.
    connections: Mutex<HashMap<String, quinn::Connection>>,
}

impl Link {
    /// Binds UDP `port` on all IPv4 interfaces and starts serving. Must not be called from inside an
    /// async task (it blocks on the runtime).
    pub fn bind(port: u16, identity: Identity, handler: Arc<dyn Handler>) -> Result<Arc<Self>, String> {
        let socket = UdpSocket::bind(("0.0.0.0", port)).map_err(|e| format!("Could not bind BridgeLink UDP port {port}: {e}"))?;
        let server = tls::server_config(&identity)?;
        let client = tls::client_config(&identity)?;
        let endpoint = tauri::async_runtime::block_on(async move {
            let runtime = quinn::default_runtime().ok_or("No async runtime")?;
            let mut endpoint = quinn::Endpoint::new(quinn::EndpointConfig::default(), Some(server), socket, runtime).map_err(|e| e.to_string())?;
            endpoint.set_default_client_config(client);
            Ok::<_, String>(endpoint)
        })?;
        let link = Arc::new(Self { endpoint, identity, connections: Mutex::new(HashMap::new()) });
        let accept = link.clone();
        tauri::async_runtime::spawn(async move { accept.accept_loop(handler).await });
        Ok(link)
    }

    pub fn fingerprint(&self) -> &str {
        &self.identity.fingerprint
    }

    pub fn local_port(&self) -> Option<u16> {
        self.endpoint.local_addr().ok().map(|a| a.port())
    }

    /// Drops cached connections (they reconnect on the next request).
    pub fn forget_all(&self) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.clear();
        }
    }

    pub fn close(&self) {
        self.endpoint.close(0u32.into(), b"shutdown");
    }

    async fn accept_loop(self: Arc<Self>, handler: Arc<dyn Handler>) {
        while let Some(incoming) = self.endpoint.accept().await {
            let handler = handler.clone();
            let link = self.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(connection) = incoming.await else { return };
                let Some(fingerprint) = tls::peer_fingerprint(&connection) else { return };
                link.remember(&fingerprint, &connection);
                serve_connection(connection, fingerprint, handler).await;
            });
        }
    }

    fn remember(&self, fingerprint: &str, connection: &quinn::Connection) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.insert(fingerprint.to_string(), connection.clone());
        }
    }

    fn cached(&self, fingerprint: &str) -> Option<quinn::Connection> {
        let connections = self.connections.lock().ok()?;
        connections.get(fingerprint).filter(|c| c.close_reason().is_none()).cloned()
    }

    /// Connects to the first address that answers. With `expected`, the other side must present that
    /// certificate; without it (pairing) any certificate is accepted and its fingerprint returned.
    pub async fn connect(&self, addresses: &[SocketAddr], expected: Option<&str>) -> Result<(quinn::Connection, String), String> {
        if let Some(fp) = expected {
            if let Some(connection) = self.cached(fp) {
                return Ok((connection, fp.to_string()));
            }
        }
        let mut last_error = "No address for this device".to_string();
        for address in addresses {
            let attempt = async {
                let connecting = self.endpoint.connect(*address, tls::SERVER_NAME).map_err(|e| e.to_string())?;
                connecting.await.map_err(|e| e.to_string())
            };
            match tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
                Ok(Ok(connection)) => {
                    let fingerprint = tls::peer_fingerprint(&connection).ok_or("The other device sent no certificate")?;
                    if let Some(expected) = expected {
                        if fingerprint != expected {
                            connection.close(1u32.into(), b"unexpected certificate");
                            return Err(format!("The device at {address} is not the paired device (certificate changed)"));
                        }
                    }
                    self.remember(&fingerprint, &connection);
                    return Ok((connection, fingerprint));
                }
                Ok(Err(error)) => last_error = format!("Could not reach {address}: {error}"),
                Err(_) => last_error = format!("Could not reach {address}: timed out"),
            }
        }
        Err(last_error)
    }

    /// One request to a paired device. `timeout` covers the other side's processing (dialogs wait for a person).
    pub async fn request(&self, addresses: &[SocketAddr], fingerprint: &str, request: &Request, timeout: Duration) -> Result<Response, String> {
        let (connection, _) = self.connect(addresses, Some(fingerprint)).await?;
        let exchange = async {
            let (mut send, mut recv) = connection.open_bi().await.map_err(|e| e.to_string())?;
            write_frame(&mut send, request).await?;
            let _ = send.finish();
            read_frame::<Response>(&mut recv).await
        };
        match tokio::time::timeout(timeout, exchange).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => {
                // A stale cached connection fails here; drop it so the next attempt reconnects.
                if let Ok(mut connections) = self.connections.lock() {
                    connections.remove(fingerprint);
                }
                Err(error)
            }
            Err(_) => Err("The other device did not answer in time".into()),
        }
    }

    /// Blocking form of `request` for synchronous callers (not from inside an async task).
    pub fn request_blocking(&self, addresses: &[SocketAddr], fingerprint: &str, request: &Request, timeout: Duration) -> Result<Response, String> {
        tauri::async_runtime::block_on(self.request(addresses, fingerprint, request, timeout))
    }
}

async fn serve_connection(connection: quinn::Connection, fingerprint: String, handler: Arc<dyn Handler>) {
    let address = connection.remote_address();
    while let Ok((mut send, mut recv)) = connection.accept_bi().await {
        let handler = handler.clone();
        let caller = Caller { fingerprint: fingerprint.clone(), address };
        tauri::async_runtime::spawn(async move {
            let Ok(request) = read_frame::<Request>(&mut recv).await else { return };
            if handler.stream_paths().contains(&request.path.as_str()) {
                handler.stream(caller, request, send, recv).await;
                return;
            }
            let response = tauri::async_runtime::spawn_blocking(move || handler.handle(caller, request))
                .await
                .unwrap_or_else(|_| Response::json(500, r#"{"ok":false,"error":"handler failed"}"#));
            let _ = write_frame(&mut send, &response).await;
            let _ = send.finish();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo;
    impl Handler for Echo {
        fn handle(&self, caller: Caller, request: Request) -> Response {
            Response::json(200, format!("{}|{}|{}", request.path, request.body, caller.fingerprint.len()))
        }
        fn stream(&self, _: Caller, _: Request, mut send: quinn::SendStream, mut recv: quinn::RecvStream) -> BoxFuture {
            Box::pin(async move {
                // Echo frames until the other side finishes.
                while let Ok(value) = read_frame::<String>(&mut recv).await {
                    if write_frame(&mut send, &format!("echo {value}")).await.is_err() { break; }
                }
                let _ = send.finish();
            })
        }
        fn stream_paths(&self) -> &'static [&'static str] { &["/stream"] }
    }

    fn local(link: &Link) -> Vec<SocketAddr> {
        vec![SocketAddr::from(([127, 0, 0, 1], link.local_port().unwrap()))]
    }

    #[test]
    fn requests_and_streams_over_quic() {
        let a = Link::bind(0, Identity::generate().unwrap(), Arc::new(Echo)).unwrap();
        let b = Link::bind(0, Identity::generate().unwrap(), Arc::new(Echo)).unwrap();
        let request = Request { method: "GET".into(), path: "/status".into(), body: "hi".into() };
        let response = a.request_blocking(&local(&b), b.fingerprint(), &request, Duration::from_secs(5)).unwrap();
        assert_eq!(response, Response::json(200, "/status|hi|64"));

        // Reused connection, second request.
        let response = a.request_blocking(&local(&b), b.fingerprint(), &request, Duration::from_secs(5)).unwrap();
        assert_eq!(response.status, 200);

        // Multi-frame stream.
        let echoed = tauri::async_runtime::block_on(async {
            let (connection, _) = a.connect(&local(&b), Some(b.fingerprint())).await.unwrap();
            let (mut send, mut recv) = connection.open_bi().await.unwrap();
            write_frame(&mut send, &Request { method: "POST".into(), path: "/stream".into(), body: String::new() }).await.unwrap();
            write_frame(&mut send, &"one".to_string()).await.unwrap();
            let first: String = read_frame(&mut recv).await.unwrap();
            write_frame(&mut send, &"two".to_string()).await.unwrap();
            let second: String = read_frame(&mut recv).await.unwrap();
            (first, second)
        });
        assert_eq!(echoed, ("echo one".to_string(), "echo two".to_string()));
    }

    #[test]
    fn pinned_certificate_mismatch_is_refused() {
        let a = Link::bind(0, Identity::generate().unwrap(), Arc::new(Echo)).unwrap();
        let b = Link::bind(0, Identity::generate().unwrap(), Arc::new(Echo)).unwrap();
        let wrong = Identity::generate().unwrap().fingerprint;
        let request = Request { method: "GET".into(), path: "/status".into(), body: String::new() };
        let error = a.request_blocking(&local(&b), &wrong, &request, Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("not the paired device"), "{error}");
    }

    #[test]
    fn server_sees_the_client_certificate() {
        struct Who;
        impl Handler for Who {
            fn handle(&self, caller: Caller, _: Request) -> Response { Response::json(200, caller.fingerprint) }
            fn stream(&self, _: Caller, _: Request, _: quinn::SendStream, _: quinn::RecvStream) -> BoxFuture { Box::pin(async {}) }
            fn stream_paths(&self) -> &'static [&'static str] { &[] }
        }
        let a = Link::bind(0, Identity::generate().unwrap(), Arc::new(Echo)).unwrap();
        let b = Link::bind(0, Identity::generate().unwrap(), Arc::new(Who)).unwrap();
        let request = Request { method: "GET".into(), path: "/whoami".into(), body: String::new() };
        let response = a.request_blocking(&local(&b), b.fingerprint(), &request, Duration::from_secs(5)).unwrap();
        assert_eq!(response.body, a.fingerprint());
    }
}
