//! Talking to the BuildnLaunchAI platform: tokens, licence, provider keys.
//!
//! Everything here is addressed by a base URL passed in rather than compiled
//! against a constant, which is what lets the tests point it at a stub on
//! loopback and lets staging and production differ without a rebuild.
//!
//! ## Nothing in this file is a secret
//!
//! The only credential the binary carries is the project's **anon** key, which
//! is published in every web page the platform serves and is meaningless
//! without row-level security behind it. The `service_role` key must never be
//! within reach of this process; preflight greps for it.
//!
//! ## Why provider keys are never written down
//!
//! An OpenAI or ElevenLabs key is only useful with a network connection, and
//! if there is a network connection the platform can be asked for it. So
//! caching one to disk buys nothing and costs the only thing that matters: a
//! rotated or revoked key stays live on somebody's machine until a cache
//! expires. Fetched into memory each session, refetched once on a 401, never
//! persisted — see [`ProviderKeys`].

use serde::{Deserialize, Serialize};

/// Where the credentials for a cloud provider came from.
///
/// `Byok` is the user's own key, held on the platform on their behalf and
/// billed to them. `Platform` is the platform's own key, spent against credits
/// they have bought — which does not exist yet, and is named here so that
/// adding it later is a branch rather than a redesign. The distinction has to
/// reach the UI either way: "your key" and "your credits" fail differently and
/// a person needs to know which they are looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyMode {
    Byok,
    Platform,
}

/// One provider's credentials as the platform reports them.
///
/// `present: false` with no key is a real answer and a different one from an
/// empty string: it means "this person has not saved an OpenAI key with us",
/// which the app should answer with "add one on your dashboard" rather than
/// "your key was rejected".
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub present: bool,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default = "byok")]
    pub mode: KeyMode,
}

fn byok() -> KeyMode {
    KeyMode::Byok
}

impl ProviderKey {
    /// The last four characters, for showing which key is in use without
    /// showing the key. Never log or render anything longer than this.
    pub fn hint(&self) -> Option<String> {
        let k = self.key.as_deref()?;
        let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        (!tail.is_empty()).then_some(tail)
    }
}

/// What the platform holds for this person, this session. Memory only.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeys {
    #[serde(default = "absent")]
    pub openai: ProviderKey,
    #[serde(default = "absent")]
    pub elevenlabs: ProviderKey,
}

fn absent() -> ProviderKey {
    ProviderKey { present: false, key: None, mode: KeyMode::Byok }
}

/// A session as the identity provider issues it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Seconds. Used to decide when to refresh, never to decide entitlement.
    #[serde(default)]
    pub expires_in: u64,
    #[serde(default)]
    pub user: TokenUser,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TokenUser {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Debug)]
pub enum PlatformError {
    /// Could not reach the platform at all. Distinct from every other case on
    /// purpose: silence is not a refusal, and the difference decides whether
    /// somebody keeps working offline or is shown a door.
    Unreachable(String),
    /// The platform answered, and said no.
    Refused { status: u16, message: String },
    /// The platform answered with something unreadable.
    Malformed(String),
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(e) => write!(f, "could not reach BuildnLaunchAI: {e}"),
            Self::Refused { status, message } => write!(f, "BuildnLaunchAI refused ({status}): {message}"),
            Self::Malformed(e) => write!(f, "BuildnLaunchAI sent something unexpected: {e}"),
        }
    }
}

impl PlatformError {
    /// Whether this is the "your token is no longer good" answer, which is the
    /// one case where refetching and retrying is the right move rather than
    /// giving up.
    pub fn is_unauthorised(&self) -> bool {
        matches!(self, Self::Refused { status: 401 | 403, .. })
    }
}

/// Trade an authorization code for a session.
///
/// The verifier is what proves this is the same process that started the
/// login. It has never left this machine, which is why the code being visible
/// in a browser's history does not matter.
pub async fn exchange_code(
    base: &str,
    anon_key: &str,
    code: &str,
    verifier: &str,
) -> Result<Tokens, PlatformError> {
    post_tokens(
        base,
        anon_key,
        "pkce",
        serde_json::json!({ "auth_code": code, "code_verifier": verifier }),
    )
    .await
}

/// Spend a refresh token for a new session.
///
/// The token that comes back replaces the one spent — the caller must write it
/// down before using the access token, or a crash here signs the user out for
/// good. See `session::replace`.
pub async fn refresh(base: &str, anon_key: &str, refresh_token: &str) -> Result<Tokens, PlatformError> {
    post_tokens(
        base,
        anon_key,
        "refresh_token",
        serde_json::json!({ "refresh_token": refresh_token }),
    )
    .await
}

async fn post_tokens(
    base: &str,
    anon_key: &str,
    grant: &str,
    body: serde_json::Value,
) -> Result<Tokens, PlatformError> {
    let url = format!("{}/auth/v1/token?grant_type={grant}", base.trim_end_matches('/'));
    let resp = client()?
        .post(url)
        .header("apikey", anon_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| PlatformError::Unreachable(e.to_string()))?;
    read(resp).await
}

/// Ask what keys this person has stored with the platform.
///
/// Authenticated with the access token, never with anything long-lived, and
/// the answer is held in memory for the life of the session only.
pub async fn provider_keys(base: &str, anon_key: &str, access_token: &str) -> Result<ProviderKeys, PlatformError> {
    let url = format!("{}/api/desktop/keys", base.trim_end_matches('/'));
    let resp = client()?
        .get(url)
        .header("apikey", anon_key)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| PlatformError::Unreachable(e.to_string()))?;
    read(resp).await
}

fn client() -> Result<reqwest::Client, PlatformError> {
    reqwest::Client::builder()
        // Long enough for a slow connection, short enough that a hung network
        // does not look like a hung application.
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| PlatformError::Unreachable(e.to_string()))
}

async fn read<T: serde::de::DeserializeOwned>(resp: reqwest::Response) -> Result<T, PlatformError> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| PlatformError::Unreachable(e.to_string()))?;
    if !status.is_success() {
        // Providers put their reason in varying fields; take whichever is
        // there rather than showing a bare status to a person.
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                ["error_description", "msg", "message", "error"]
                    .iter()
                    .find_map(|k| v.get(*k).and_then(|s| s.as_str()).map(str::to_string))
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(PlatformError::Refused { status: status.as_u16(), message });
    }
    serde_json::from_str(&text).map_err(|e| PlatformError::Malformed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A one-shot HTTP server that answers with whatever it is given, and
    /// records the request it was asked. Enough to prove this module speaks
    /// the protocol without a real backend or a billed call.
    fn stub(status: &str, body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (tx, rx) = std::sync::mpsc::channel();
        let status = status.to_string();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (base, rx)
    }

    #[tokio::test]
    async fn a_code_is_exchanged_for_a_session() {
        let (base, seen) = stub(
            "200 OK",
            r#"{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600,
                "user":{"id":"u-1","email":"a@b.c"}}"#,
        );
        let t = exchange_code(&base, "anon-key", "the-code", "the-verifier").await.expect("exchange");

        assert_eq!(t.access_token, "at-1");
        assert_eq!(t.refresh_token, "rt-1");
        assert_eq!(t.user.email, "a@b.c");

        // The verifier has to be in the request, or PKCE is decoration.
        let req = seen.recv().expect("request");
        assert!(req.contains("grant_type=pkce"), "wrong grant: {req}");
        assert!(req.contains("the-verifier"), "the verifier was not sent: {req}");
        assert!(req.contains("apikey: anon-key"), "the project key was not sent: {req}");
    }

    #[tokio::test]
    async fn refreshing_sends_the_token_it_is_spending() {
        let (base, seen) = stub(
            "200 OK",
            r#"{"access_token":"at-2","refresh_token":"rt-2","expires_in":3600}"#,
        );
        let t = refresh(&base, "anon-key", "rt-1").await.expect("refresh");
        // The point of rotation: what comes back is not what went out.
        assert_eq!(t.refresh_token, "rt-2");
        assert!(seen.recv().unwrap().contains("rt-1"));
    }

    /// A refusal has to carry its reason, because "sign-in failed" tells a
    /// person nothing they can act on.
    #[tokio::test]
    async fn a_refusal_keeps_the_reason_the_server_gave() {
        let (base, _) = stub("400 Bad Request", r#"{"error_description":"Email not confirmed"}"#);
        match refresh(&base, "anon", "rt").await {
            Err(PlatformError::Refused { status, message }) => {
                assert_eq!(status, 400);
                assert_eq!(message, "Email not confirmed");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// Unreachable is not refused. This distinction decides whether somebody
    /// keeps working on a plane or is shown a login wall.
    #[tokio::test]
    async fn an_unreachable_platform_is_not_a_refusal() {
        // Nothing is listening on this port.
        let err = refresh("http://127.0.0.1:1", "anon", "rt").await.unwrap_err();
        assert!(matches!(err, PlatformError::Unreachable(_)), "got {err:?}");
        assert!(!err.is_unauthorised(), "silence was read as a rejection");
    }

    #[tokio::test]
    async fn an_expired_token_is_recognised_as_worth_retrying() {
        let (base, _) = stub("401 Unauthorized", r#"{"msg":"invalid token"}"#);
        let err = provider_keys(&base, "anon", "stale").await.unwrap_err();
        assert!(err.is_unauthorised(), "a 401 must be the retryable case: {err:?}");
    }

    #[tokio::test]
    async fn keys_are_read_with_present_meaning_what_it_says() {
        let (base, seen) = stub(
            "200 OK",
            r#"{"openai":{"present":true,"key":"sk-proj-abcd1234","mode":"byok"},
                "elevenlabs":{"present":false}}"#,
        );
        let k = provider_keys(&base, "anon", "at-1").await.expect("keys");

        assert!(k.openai.present);
        assert_eq!(k.openai.mode, KeyMode::Byok);
        // Only ever the last four, so nothing longer reaches a screen or a log.
        assert_eq!(k.openai.hint().as_deref(), Some("1234"));

        // A provider the person has not set up is a different answer from a
        // broken one, and the app has to be able to tell them apart.
        assert!(!k.elevenlabs.present);
        assert!(k.elevenlabs.key.is_none());
        assert!(k.elevenlabs.hint().is_none());

        assert!(seen.recv().unwrap().contains("Bearer at-1"), "the request was not authenticated");
    }

    /// Credits mode does not exist yet; the shape that will carry it does.
    #[test]
    fn the_platform_mode_is_understood_before_it_is_offered() {
        let k: ProviderKey =
            serde_json::from_str(r#"{"present":true,"key":"x","mode":"platform"}"#).expect("parses");
        assert_eq!(k.mode, KeyMode::Platform);
        // And an older backend that omits it still means the user's own key.
        let k: ProviderKey = serde_json::from_str(r#"{"present":true,"key":"x"}"#).expect("parses");
        assert_eq!(k.mode, KeyMode::Byok);
    }
}

// ── where the platform lives ────────────────────────────────────────────────

/// The two things needed to talk to the platform, neither of them secret.
pub struct PlatformConfig {
    pub base: String,
    /// The project's publishable key. Safe in the binary and safe in a log;
    /// it is in every web page the platform serves. Row-level security is what
    /// protects the data behind it.
    pub anon_key: String,
}

/// Read the platform's address from the environment.
///
/// Environment rather than a constant for the same reason every other
/// endpoint here is: staging and production must differ without a rebuild,
/// and nothing about the deployment should be baked into an artifact people
/// download. Absent means "not configured", which the commands report as such
/// rather than failing with a network error against an empty URL.
pub fn config() -> Option<PlatformConfig> {
    let base = std::env::var("BUILDNLAUNCH_AUTH_URL").ok()?;
    let anon_key = std::env::var("BUILDNLAUNCH_ANON_KEY").ok()?;
    (!base.is_empty() && !anon_key.is_empty()).then_some(PlatformConfig { base, anon_key })
}

#[derive(Debug, serde::Serialize)]
pub struct GateError {
    pub code: String,
    pub message: String,
}

impl GateError {
    fn not_configured() -> Self {
        Self {
            code: "NOT_CONFIGURED".into(),
            message: "This build has no platform to sign in to yet.".into(),
        }
    }
    fn from(e: PlatformError) -> Self {
        let code = match &e {
            PlatformError::Unreachable(_) => "UNREACHABLE",
            PlatformError::Refused { .. } => "REFUSED",
            PlatformError::Malformed(_) => "MALFORMED",
        };
        Self { code: code.into(), message: e.to_string() }
    }
}

/// Who is signed in, as the gate needs to know it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub email: String,
    pub user_id: String,
}

/// Open the browser, wait for the callback, and establish a session.
///
/// Blocking on a background thread rather than async throughout, because the
/// waiting is a socket accept loop with a five-minute ceiling and wrapping it
/// in the async runtime would buy nothing.
#[tauri::command]
pub async fn auth_sign_in(app: tauri::AppHandle) -> Result<SignedIn, GateError> {
    let cfg = config().ok_or_else(GateError::not_configured)?;
    let pkce = crate::auth::Pkce::new();
    let pending = crate::auth::Pending::bind(&pkce.state)
        .map_err(|e| GateError { code: "LISTEN".into(), message: e.to_string() })?;

    let url = format!(
        "{}/authorize?response_type=code&code_challenge={}&code_challenge_method=S256&redirect_to={}",
        cfg.base.trim_end_matches('/'),
        pkce.challenge,
        urlencode(&pending.redirect_uri()),
    );
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| GateError { code: "BROWSER".into(), message: e.to_string() })?;

    // Tauri's own runtime rather than a direct tokio dependency: the waiting
    // is a socket accept loop with a five-minute ceiling, and it must not sit
    // on the thread the UI is answering from.
    let code = tauri::async_runtime::spawn_blocking(move || pending.wait(crate::auth::CALLBACK_TIMEOUT))
        .await
        .map_err(|e| GateError { code: "INTERNAL".into(), message: e.to_string() })?
        .map_err(|e| GateError { code: "CALLBACK".into(), message: e.to_string() })?;

    let tokens = exchange_code(&cfg.base, &cfg.anon_key, &code, &pkce.verifier)
        .await
        .map_err(GateError::from)?;

    // Written before anything else happens with it: a session that was used
    // but never saved is one the user has to establish again for no reason.
    crate::session::save(&crate::session::StoredSession {
        refresh_token: tokens.refresh_token.clone(),
        user_id: tokens.user.id.clone(),
        email: tokens.user.email.clone(),
        saved_at: now_iso(),
    })
    .map_err(|e| GateError { code: "STORE".into(), message: e.to_string() })?;

    let _ = app;
    Ok(SignedIn { email: tokens.user.email, user_id: tokens.user.id })
}

/// Forget the session on this machine.
#[tauri::command]
pub fn auth_sign_out() -> Result<(), GateError> {
    crate::session::clear().map_err(|e| GateError { code: "STORE".into(), message: e.to_string() })
}

/// Who, if anyone, is signed in — without touching the network.
#[tauri::command]
pub fn auth_current() -> Option<SignedIn> {
    crate::session::load().map(|s| SignedIn { email: s.email, user_id: s.user_id })
}

fn now_iso() -> String {
    // Seconds since the epoch is enough to order two saves and to show
    // staleness; a full calendar implementation is not worth a dependency.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@{secs}")
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod command_tests {
    use super::*;

    /// A build with no platform configured says so, rather than trying to
    /// reach an empty URL and reporting a network error.
    #[test]
    fn an_unconfigured_build_is_a_state_not_a_failure() {
        // Safety: these two variables are read nowhere else, and the test is
        // asserting their absence rather than depending on a value.
        unsafe {
            std::env::remove_var("BUILDNLAUNCH_AUTH_URL");
            std::env::remove_var("BUILDNLAUNCH_ANON_KEY");
        }
        assert!(config().is_none());
        assert_eq!(GateError::not_configured().code, "NOT_CONFIGURED");
    }

    /// The redirect has to survive being put in a query string, or the
    /// provider sends the browser somewhere that is not us.
    #[test]
    fn the_redirect_is_encoded_for_a_query_string() {
        assert_eq!(
            urlencode("http://127.0.0.1:49152/callback"),
            "http%3A%2F%2F127.0.0.1%3A49152%2Fcallback"
        );
    }

    /// Unreachable has to stay distinguishable after crossing into the UI, or
    /// the offline design is undone at the boundary.
    #[test]
    fn unreachable_keeps_its_own_code_across_the_boundary() {
        let e = GateError::from(PlatformError::Unreachable("dns".into()));
        assert_eq!(e.code, "UNREACHABLE");
        let e = GateError::from(PlatformError::Refused { status: 403, message: "no".into() });
        assert_eq!(e.code, "REFUSED");
    }
}
