//! Signing in, without ever holding the password.
//!
//! The app opens the system browser at the platform's login page and waits for
//! it to hand back a code. Credentials are typed into the browser, where the
//! user's password manager and second factor already live, and this process
//! never sees them. That is the point of doing it this way rather than putting
//! an email and password field in the app.
//!
//! ## Why a loopback address and not a `rfrs://` link
//!
//! RFC 8252 allows both. Loopback is the better choice here specifically
//! because the app is unsigned and shipped as a disk image: macOS registers
//! URL schemes per *copy* of an application, so a tester who runs the app from
//! the mounted DMG and then drags it to Applications has two registrations,
//! and the callback can be delivered to the copy inside a disk image that is
//! no longer mounted. That failure is silent and the user cannot fix it. A
//! port we hold open belongs to the process that opened it, and no other
//! program can claim it.
//!
//! ## What stops someone else answering
//!
//! The listener binds `127.0.0.1` only, never `0.0.0.0`, so nothing off this
//! machine can reach it. The port is whatever the OS hands out rather than a
//! fixed number. It serves one login and closes.
//!
//! The real defence is PKCE, not `state`. A code somebody else's browser
//! delivers here cannot be spent: the token exchange sends *our* verifier, and
//! the server checks it against the challenge that started *their* login. So a
//! stray callback ends in a failed exchange and no session, which is the
//! outcome `state` exists to produce.
//!
//! `state` is carried anyway, because it turns that failure into a cheaper and
//! clearer one — but it is carried **in the redirect URI's query string**
//! rather than as an authorize parameter. GoTrue mints its own `state` for the
//! leg between itself and the identity provider and does not pass ours
//! through; what it does preserve is whatever is already in `redirect_to`.
//! Hence `…/callback?state=…`, which the project's redirect allow-list accepts
//! and which comes back intact alongside the `?code=`.
//!
//! Because it is a courtesy rather than the control, a callback that arrives
//! carrying a code and *no* state at all is accepted. One carrying the wrong
//! state is not. See [`Pending::handle`].
//!
//! Nothing here is a secret the binary has to keep. That is the property PKCE
//! buys: the code is useless without the verifier, the verifier never leaves
//! this process, and so an app that anybody can download and read holds nothing
//! worth extracting.

use base64::Engine;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// Base64 as the OAuth specs want it: URL alphabet, no padding.
const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// How long to wait for somebody to finish logging in before giving up.
///
/// Generous on purpose. A first-time sign-in can mean finding a password,
/// waiting for a code by email, or completing a second factor on a phone that
/// is in another room.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub enum AuthError {
    /// No port could be opened. Rare, and worth its own message: it usually
    /// means something on the machine is refusing local connections.
    Listen(String),
    /// Nobody came back before [`CALLBACK_TIMEOUT`].
    TimedOut,
    /// The browser came back carrying a `state` that is not ours. Treated as
    /// hostile rather than as a mistake — see [`Pending::wait`].
    StateMismatch,
    /// A request with nothing in its query. Internal to the accept loop and
    /// never returned to a caller: the reply asks the browser to re-send
    /// whatever is in the fragment as a query, and the wait continues.
    Fragment,
    /// The identity provider itself refused, and said why.
    Denied(String),
    Io(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Listen(e) => write!(f, "could not open a local port to receive the login: {e}"),
            Self::TimedOut => write!(f, "the login was not completed in time"),
            Self::StateMismatch => write!(f, "the login response did not match this request"),
            Self::Fragment => write!(f, "the login response arrived with nothing in it"),
            Self::Denied(why) => write!(f, "sign-in was refused: {why}"),
            Self::Io(e) => write!(f, "the login could not be read: {e}"),
        }
    }
}

/// One login attempt's secrets.
///
/// The verifier is the whole security of the exchange: the authorization code
/// travels through a browser, a redirect and possibly a URL bar, and is worth
/// nothing to anyone who intercepts it without this value, which stays in this
/// process and is never sent anywhere until the final token request.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn new() -> Self {
        // 32 bytes of OS randomness, base64url'd to 43 characters — the length
        // RFC 7636 asks for, and the maximum entropy that fits it.
        let verifier = random_token(32);
        let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
        Self { verifier, challenge, state: random_token(16) }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// `n` bytes from the operating system, as URL-safe text.
fn random_token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    // The OS random source, not a seeded generator. A predictable verifier or
    // state would defeat the point of having them.
    getrandom::fill(&mut bytes).expect("the OS random source is unavailable");
    B64.encode(bytes)
}

/// A port held open, waiting for the browser to come back.
pub struct Pending {
    listener: TcpListener,
    state: String,
    port: u16,
}

impl Pending {
    /// Open a port on the loopback interface and return it.
    ///
    /// Port zero asks the OS for whatever is free. A fixed port would collide
    /// with a second copy of the app, and — worse — would let another program
    /// on the machine sit on it and answer in our place.
    pub fn bind(state: &str) -> Result<Self, AuthError> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .map_err(|e| AuthError::Listen(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| AuthError::Listen(e.to_string()))?.port();
        Ok(Self { listener, state: state.to_string(), port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Where the browser should send the user back to.
    ///
    /// The `state` rides here rather than as an authorize parameter — see the
    /// module docs. The value is base64url by construction, so there is
    /// nothing in it that needs escaping in a query string.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback?state={}", self.port, self.state)
    }

    /// Wait for the one request we care about, and return the code in it.
    ///
    /// Anything arriving without the `state` we sent is answered politely and
    /// ignored rather than accepted: a callback we did not initiate is either a
    /// stray request or an attempt to log this app into somebody else's
    /// account, and neither should end with a session.
    pub fn wait(self, timeout: Duration) -> Result<String, AuthError> {
        self.listener.set_nonblocking(true).map_err(|e| AuthError::Io(e.to_string()))?;
        let deadline = Instant::now() + timeout;

        while Instant::now() < deadline {
            match self.listener.accept() {
                Ok((stream, _)) => match self.handle(stream) {
                    // A request that was not ours, or one whose payload is in
                    // the fragment and is about to be re-sent as a query:
                    // keep waiting rather than failing the whole sign-in.
                    Err(AuthError::StateMismatch | AuthError::Fragment) => continue,
                    other => return other,
                },
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(AuthError::Io(e.to_string())),
            }
        }
        Err(AuthError::TimedOut)
    }

    fn handle(&self, mut stream: TcpStream) -> Result<String, AuthError> {
        // Back to blocking, before the timeout below is asked to mean
        // anything.
        //
        // `wait` puts the *listener* in non-blocking mode so it can poll its
        // own deadline instead of parking forever in `accept`. On macOS and
        // the BSDs the accepted socket inherits that flag; on Linux it does
        // not, which is why CI has never seen this. Inherited, it makes the
        // read below return `EAGAIN` the instant the request bytes have not
        // arrived yet — microseconds after `accept` — and `SO_RCVTIMEO` is
        // ignored on a non-blocking socket, so the five seconds are not a
        // grace period, they are nothing at all.
        //
        // On loopback the handshake and the request usually land together,
        // so the failure is intermittent rather than total: a sign-in that
        // reports "the login could not be read" perhaps one time in twenty,
        // more often on a loaded machine or with a browser slower than a
        // test client.
        stream
            .set_nonblocking(false)
            .map_err(|e| AuthError::Io(e.to_string()))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| AuthError::Io(e.to_string()))?;

        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).map_err(|e| AuthError::Io(e.to_string()))?;

        // "GET /callback?code=…&state=… HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or_default().to_string();
        let params = query_params(&target);

        let result = match (params.get("code"), params.get("error")) {
            (_, Some(err)) => {
                let detail = params.get("error_description").cloned().unwrap_or_else(|| err.clone());
                Err(AuthError::Denied(detail))
            }
            (Some(code), None) => match params.get("state") {
                // Ours, and it says so.
                Some(state) if state == &self.state => Ok(code.clone()),
                // Somebody else's. Refused — this is the case the value is
                // carried for.
                Some(_) => Err(AuthError::StateMismatch),
                // A code and no state at all. Accepted, because PKCE is what
                // makes a code worth anything and an injected one still cannot
                // be spent; refusing here would instead mean a five-minute
                // hang the first time the platform changes how it forwards
                // query parameters.
                None => Ok(code.clone()),
            },
            // Neither a code nor a reason. The state we put in the redirect
            // may well be here — that is not the question. The question is
            // that the *answer* is missing, and the likeliest reason is that
            // it was delivered in the URL fragment, which a server cannot see
            // because the browser never sends it. The reply below asks the
            // browser to hand it over as a query instead.
            (None, None) => Err(AuthError::Fragment),
        };

        // The browser is left on a page rather than a dead connection, because
        // a spinning tab after a successful login reads as a failure.
        let body = match &result {
            Ok(_) => PAGE_OK,
            Err(AuthError::StateMismatch) => PAGE_IGNORED,
            Err(AuthError::Fragment) => PAGE_RECOVER_FRAGMENT,
            Err(_) => PAGE_FAILED,
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.flush();
        result
    }
}

/// Pull `a=b` pairs out of a request target, percent-decoding the values.
fn query_params(target: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some((_, query)) = target.split_once('?') else { return out };
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            out.insert(k.to_string(), percent_decode(v));
        }
    }
    out
}

/// Enough percent-decoding for an OAuth callback.
///
/// Error descriptions arrive URL-encoded and are shown to the user, so
/// "Email+not+confirmed" has to read as a sentence rather than as a slug.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title>\
<body style=\"font:16px system-ui;padding:3rem;max-width:30rem;margin:auto\">\
<h1 style=\"font-size:1.3rem\">You're signed in.</h1>\
<p>You can close this tab and go back to Raw Footage, Real Story.</p>";

const PAGE_FAILED: &str = "<!doctype html><meta charset=utf-8><title>Sign-in failed</title>\
<body style=\"font:16px system-ui;padding:3rem;max-width:30rem;margin:auto\">\
<h1 style=\"font-size:1.3rem\">That didn't work.</h1>\
<p>Go back to the app and try again — it will tell you what happened.</p>";

const PAGE_IGNORED: &str = "<!doctype html><meta charset=utf-8><title>Ignored</title>\
<body style=\"font:16px system-ui;padding:3rem;max-width:30rem;margin:auto\">\
<h1 style=\"font-size:1.3rem\">Nothing to do here.</h1>\
<p>This link didn't come from a sign-in the app started, so it was ignored.</p>";

/// Asks the browser to re-send the URL fragment as a query string.
///
/// A fragment is never transmitted — `#error=access_denied&…` reaches the
/// browser and stops there, so this process sees a bare `GET /callback` and
/// has no idea anything went wrong. That is not hypothetical: the platform
/// delivers some refusals exactly that way, and without this the app would sit
/// silently for five minutes and then report a timeout to somebody who watched
/// themselves decline a consent screen ten seconds earlier.
///
/// Four lines of script, replacing rather than pushing so the tab's back
/// button is not littered, and a no-op when there is no fragment — in which
/// case the page reads as the "nothing to do here" it is.
const PAGE_RECOVER_FRAGMENT: &str = "<!doctype html><meta charset=utf-8><title>Finishing sign-in</title>\
<body style=\"font:16px system-ui;padding:3rem;max-width:30rem;margin:auto\">\
<h1 style=\"font-size:1.3rem\">Nothing to do here.</h1>\
<p>If a sign-in was in progress, it is finishing now — go back to the app.</p>\
<script>\
var h=location.hash.slice(1);\
if(h){location.replace(location.pathname+(location.search?location.search+'&':'?')+h)}\
</script>";

#[cfg(test)]
mod tests {
    use super::*;

    /// The challenge has to be exactly what the server will recompute.
    #[test]
    fn the_challenge_is_the_hash_of_the_verifier() {
        let p = Pkce::new();
        let expected = B64.encode(Sha256::digest(p.verifier.as_bytes()));
        assert_eq!(p.challenge, expected);

        // RFC 7636 puts the verifier between 43 and 128 characters, and the
        // challenge is a base64url SHA-256, which is always 43.
        assert!(p.verifier.len() >= 43 && p.verifier.len() <= 128, "{}", p.verifier.len());
        assert_eq!(p.challenge.len(), 43);

        // No padding, and nothing that would need escaping in a URL.
        for s in [&p.verifier, &p.challenge, &p.state] {
            assert!(!s.contains('='), "padding would be re-encoded in a query string: {s}");
            assert!(!s.contains('+') && !s.contains('/'), "not URL-safe: {s}");
        }
    }

    /// Two attempts must not share secrets.
    #[test]
    fn every_attempt_is_its_own() {
        let a = Pkce::new();
        let b = Pkce::new();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.state, b.state);
    }

    /// A known pair from RFC 7636, so a change of encoding is caught here
    /// rather than by a provider rejecting every login.
    #[test]
    fn it_matches_the_worked_example_in_the_spec() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn it_listens_only_on_loopback() {
        let p = Pending::bind("s").expect("bind");
        let addr = p.listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback(), "reachable from off this machine: {addr}");
        assert_ne!(p.port(), 0);
        // The state travels in the redirect URI, because the platform does not
        // forward an authorize-level one. See the module docs.
        assert_eq!(p.redirect_uri(), format!("http://127.0.0.1:{}/callback?state=s", p.port()));
    }

    /// The redirect URI has to be one the platform's allow-list accepts, and
    /// what it accepts is a loopback address on any port at `/callback`. A
    /// change of path or host here is a change that fails only in production.
    #[test]
    fn the_redirect_uri_is_the_shape_the_allow_list_registers() {
        let p = Pending::bind("xyz").expect("bind");
        let uri = p.redirect_uri();
        assert!(uri.starts_with("http://127.0.0.1:"), "{uri}");
        let (_, query) = uri.split_once('?').expect("the state has to be in the query");
        assert!(uri[..uri.len() - query.len() - 1].ends_with("/callback"), "{uri}");
        assert_eq!(query, "state=xyz");
    }

    /// The happy path, end to end over a real socket — with the state coming
    /// back in the query the redirect URI put it in, and the code appended
    /// beside it, which is how the platform delivers it.
    #[test]
    fn a_matching_callback_yields_its_code() {
        let pending = Pending::bind("the-state").expect("bind");
        let port = pending.port();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let _ = s.write_all(b"GET /callback?state=the-state&code=abc123 HTTP/1.1\r\n\r\n");
        });
        assert_eq!(pending.wait(Duration::from_secs(5)).expect("code"), "abc123");
    }

    /// A browser that connects and only then sends its request is still heard.
    ///
    /// This is the shape of the real thing — a connection is established and
    /// the request follows it — and it is the case that used to fail. The
    /// listener is non-blocking so `wait` can poll its deadline, and where
    /// the accepted socket inherits that flag the read gave up `EAGAIN`
    /// microseconds after `accept` rather than waiting the five seconds it
    /// looked like it was waiting. The stall here is far longer than the
    /// window that made it intermittent, so this fails every time rather than
    /// once in twenty.
    #[test]
    fn a_callback_that_arrives_after_a_pause_is_still_read() {
        let pending = Pending::bind("s").expect("bind");
        let port = pending.port();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            std::thread::sleep(Duration::from_millis(300));
            let _ = s.write_all(b"GET /callback?state=s&code=abc123 HTTP/1.1\r\n\r\n");
        });
        assert_eq!(pending.wait(Duration::from_secs(5)).expect("code"), "abc123");
    }

    /// If the platform ever stops preserving the query it was given, the code
    /// still arrives and must still be usable: PKCE, not `state`, is what
    /// makes a code worth anything, and an injected one cannot be exchanged.
    /// Refusing here would turn a harmless change into a silent five-minute
    /// hang for every user.
    #[test]
    fn a_code_with_no_state_at_all_is_still_accepted() {
        let pending = Pending::bind("ours").expect("bind");
        let port = pending.port();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let _ = s.write_all(b"GET /callback?code=abc123 HTTP/1.1\r\n\r\n");
        });
        assert_eq!(pending.wait(Duration::from_secs(5)).expect("code"), "abc123");
    }

    /// A refusal delivered in the fragment is invisible to this process, so
    /// the first request has to be answered with something that turns it into
    /// a second, visible one. Here that second request is made by hand; in a
    /// browser the script in the reply makes it.
    #[test]
    fn a_response_hidden_in_the_fragment_is_asked_for_again() {
        let pending = Pending::bind("s").expect("bind");
        let port = pending.port();
        std::thread::spawn(move || {
            // What a browser sends for `…/callback?state=s#error=access_denied`:
            // the fragment is not on the wire at all.
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
                let _ = s.write_all(b"GET /callback?state=s HTTP/1.1\r\n\r\n");
                let mut reply = String::new();
                use std::io::Read as _;
                let _ = s.read_to_string(&mut reply);
                // The reply has to contain the script that re-sends it, or a
                // real browser would stop here.
                assert!(reply.contains("location.hash"), "no recovery script in the reply");
            }
            // What that script then requests.
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
                let _ = s.write_all(
                    b"GET /callback?state=s&error=access_denied&error_description=Access+denied HTTP/1.1\r\n\r\n",
                );
            }
        });
        match pending.wait(Duration::from_secs(5)) {
            Err(AuthError::Denied(why)) => assert_eq!(why, "Access denied"),
            other => panic!("expected the refusal to surface, got {other:?}"),
        }
    }

    /// A callback for somebody else's login must not become our session.
    ///
    /// It is answered and ignored rather than failing the attempt, because the
    /// real browser may still be on its way and one stray request should not
    /// force the user to start again.
    #[test]
    fn a_callback_with_the_wrong_state_is_ignored_not_accepted() {
        let pending = Pending::bind("ours").expect("bind");
        let port = pending.port();
        std::thread::spawn(move || {
            // Somebody else's callback first, then the real one.
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
                let _ = s.write_all(b"GET /callback?code=theirs&state=theirs HTTP/1.1\r\n\r\n");
            }
            std::thread::sleep(Duration::from_millis(150));
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
                let _ = s.write_all(b"GET /callback?code=ours&state=ours HTTP/1.1\r\n\r\n");
            }
        });
        assert_eq!(pending.wait(Duration::from_secs(5)).expect("code"), "ours");
    }

    /// A refusal carries its reason, readable.
    #[test]
    fn a_refusal_is_reported_with_its_reason() {
        let pending = Pending::bind("s").expect("bind");
        let port = pending.port();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let _ = s.write_all(
                b"GET /callback?error=access_denied&error_description=Email+not+confirmed HTTP/1.1\r\n\r\n",
            );
        });
        match pending.wait(Duration::from_secs(5)) {
            Err(AuthError::Denied(why)) => assert_eq!(why, "Email not confirmed"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn waiting_gives_up_rather_than_hanging() {
        let pending = Pending::bind("s").expect("bind");
        let started = Instant::now();
        assert!(matches!(pending.wait(Duration::from_millis(300)), Err(AuthError::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(3), "the timeout did not hold");
    }

    #[test]
    fn percent_encoding_is_undone_for_display() {
        assert_eq!(percent_decode("Email+not+confirmed"), "Email not confirmed");
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("100%25"), "100%");
        // Malformed input is shown as-is rather than swallowed.
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
