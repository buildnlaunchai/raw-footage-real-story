//! The licence token: what the platform signs, and why this binary checks it.
//!
//! `desktop-licence` answers with two things that look interchangeable and are
//! not. There are some plain JSON fields saying whether this account is
//! entitled, and there is a `licence_token` — a JWT the platform signs with
//! its own RS256 key. The plain fields are convenient. The token is the one
//! that can still be trusted tomorrow.
//!
//! ## Why a signed token at all, when the answer arrived over TLS
//!
//! For a *live* check it buys nothing: TLS already says the bytes came from
//! the platform and nobody edited them. It matters for the *cached* answer.
//! The grace period in `entitlement.ts` runs for a month on the strength of
//! the last successful check, and that check has to survive on this machine,
//! where the person using it can edit any file the app can read. An unsigned
//! `{"active":true}` on disk is a suggestion. A token signed by a key that
//! never leaves the platform is evidence, and it can be re-checked offline any
//! number of times without asking anyone.
//!
//! ## Which key, precisely
//!
//! `HUB_JWT_PRIVATE_KEY` — the platform's *own* licence-signing key, and not
//! the Supabase project's auth signing key. Those are different keys with
//! different jobs, and confusing them is the sort of mistake that produces a
//! verifier which passes everything. The public half is compiled in from
//! `keys/hub-jwt-public.pem`.
//!
//! Also worth writing down, because the assumption was wrong once already: the
//! project's *user session* tokens are **ES256**, verifiable through the
//! project's JWKS endpoint — not HS256, which is what the shape of the anon
//! key suggests to anyone reading it quickly. That has no bearing on the code
//! here, which is only ever handed licence tokens.
//!
//! ## What a session token could and could not prove
//!
//! A session JWT proves who someone is. It does not prove they are paid up,
//! and it expires within the hour, so it can never be the thing a month-long
//! offline grace rests on. The licence token stays the source of truth for
//! entitlement. See the note in `platform::licence` on the one extra check a
//! session token would be good for.

use serde::{Deserialize, Serialize};

/// The public half of the platform's licence-signing key.
///
/// Compiled in rather than fetched: a verifier that downloads the key it
/// verifies with is checking that an attacker agrees with themselves.
///
/// Ships as a placeholder until the real `.pem` is handed over, which is a
/// file drop and no code change — see [`verification_available`].
pub const EMBEDDED_PUBLIC_KEY: &str = include_str!("../keys/hub-jwt-public.pem");

/// What the licence token asserts.
///
/// Only `sub` and `exp` are required, and they are required because they are
/// the two claims that make the token useful: who it is about, and when it
/// stops being true. Everything else is optional so that the platform can add
/// claims without this needing a release.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LicenceClaims {
    /// The user this licence is about. Must match the signed-in account, or
    /// the token is somebody else's — see [`Verified::matches`].
    pub sub: String,
    /// Seconds since the epoch. Enforced by the verifier, not by us.
    pub exp: u64,
    #[serde(default)]
    pub iat: u64,
    #[serde(default)]
    pub iss: Option<String>,
    /// The entitlement, if the platform states it as a boolean.
    #[serde(default, alias = "entitled")]
    pub active: Option<bool>,
    /// The entitlement, if the platform states it as a word: `active`,
    /// `trialing`, `past_due`, `canceled`.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    /// Anything the platform sends that this build has not been taught about.
    /// Kept rather than dropped so `--licence-probe` can show a real response
    /// in full without a rebuild.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Which spellings of "yes" count.
///
/// `trialing` is in because a trial is a live entitlement — somebody mid-trial
/// being shown a paywall is the same bad day as a subscriber being shown one.
/// `past_due` is deliberately *not* in: it is the platform's own word for a
/// payment that needs attention, and it is the platform's to resolve.
const ACTIVE_WORDS: [&str; 2] = ["active", "trialing"];

impl LicenceClaims {
    /// Whether this token says yes.
    ///
    /// An explicit boolean wins over the word, and a token carrying neither is
    /// read as **not** entitled: a licence that does not say what it grants
    /// grants nothing.
    pub fn entitled(&self) -> bool {
        if let Some(a) = self.active {
            return a;
        }
        self.status
            .as_deref()
            .map(|s| ACTIVE_WORDS.contains(&s.trim().to_ascii_lowercase().as_str()))
            .unwrap_or(false)
    }
}

/// Why a token could not be checked, or why it was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum LicenceError {
    /// No key is compiled in yet. Distinct from every other case: it means
    /// this build *cannot* check, not that the token is bad.
    NoKey,
    /// A key is compiled in and is not usable. A build mistake, and loud.
    BadKey(String),
    /// The signature, the expiry or the shape was wrong.
    Invalid(String),
}

impl std::fmt::Display for LicenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoKey => write!(f, "this build has no licence key to check against"),
            Self::BadKey(e) => write!(f, "the compiled-in licence key is unusable: {e}"),
            Self::Invalid(e) => write!(f, "the licence could not be verified: {e}"),
        }
    }
}

/// Whether this build can check a licence token at all.
///
/// False until the real `.pem` replaces the placeholder. Everything downstream
/// branches on this rather than assuming, because "the signature checked out"
/// and "nobody looked" must never be the same value.
pub fn verification_available() -> bool {
    is_pem(EMBEDDED_PUBLIC_KEY)
}

fn is_pem(s: &str) -> bool {
    s.trim_start().starts_with("-----BEGIN")
}

/// A token whose signature has been checked against the platform's key.
///
/// Only constructible through [`verify`] or [`verify_cached`], so holding one
/// is proof the check happened. That is the whole reason it is a separate type
/// from [`LicenceClaims`] rather than a bool beside it.
///
/// Which of the two made it decides whether the expiry was enforced as well —
/// see [`verify_cached`]. Both enforce the signature, which is the property
/// everything else rests on.
#[derive(Debug, Clone, PartialEq)]
pub struct Verified(LicenceClaims);

impl Verified {
    pub fn claims(&self) -> &LicenceClaims {
        &self.0
    }

    /// When the platform signed this, if it said. Seconds since the epoch.
    ///
    /// The reason this is exposed: it is the only timestamp about the check
    /// that an attacker cannot edit. A cache file's own "checked at" is
    /// ordinary text on a disk its owner controls, and a grace period counted
    /// from it can be extended for ever by touching one field. Counted from
    /// `iat` it cannot, because moving `iat` breaks the signature.
    pub fn issued_at(&self) -> Option<u64> {
        (self.0.iat > 0).then_some(self.0.iat)
    }

    /// When the platform said this stops being true. Seconds since the epoch.
    pub fn expires_at(&self) -> u64 {
        self.0.exp
    }

    /// Whether this licence is about the account that is signed in.
    ///
    /// Without this, a valid licence belonging to *anyone* would do — which is
    /// exactly what a shared cache file would be.
    pub fn matches(&self, user_id: &str) -> bool {
        !user_id.is_empty() && self.0.sub == user_id
    }

    pub fn entitled(&self) -> bool {
        self.0.entitled()
    }
}

/// Check a licence token that just arrived from the platform.
pub fn verify(token: &str) -> Result<Verified, LicenceError> {
    verify_with(token, EMBEDDED_PUBLIC_KEY)
}

/// Check a licence token that came off this machine's disk rather than off the
/// wire — signature yes, expiry **no**.
///
/// This is the one asymmetry in the module and it is deliberate, so here is
/// the argument in full.
///
/// `exp` is the platform's statement of how long this assertion stays live.
/// For a token fetched seconds ago that is exactly the right thing to enforce,
/// and [`verify`] does. For a token being re-read offline it is the wrong
/// question, because whatever the backend happens to set `exp` to silently
/// becomes the app's offline tolerance. If the platform issues hour-long
/// licence tokens — a perfectly ordinary choice — then enforcing `exp` here
/// makes the month-long grace period a one-hour grace period, and the first
/// anyone hears of it is a paying customer locked out of their own footage on
/// a flight. A product decision that important must not be a side effect of a
/// backend constant.
///
/// Nothing is given away by this. The grace has its own ceiling, counted in
/// `entitlement.ts` from a timestamp the signature covers — see
/// [`Verified::issued_at`] — so an ignored `exp` buys at most the difference
/// between the platform's expiry and thirty days, offline, and only until the
/// next successful live check overrules it. `entitlement.ts` weighs that trade
/// and takes it explicitly.
///
/// What is **not** relaxed is the signature. Tampering with a cached token,
/// including with its expiry, still breaks it.
pub fn verify_cached(token: &str) -> Result<Verified, LicenceError> {
    verify_cached_with(token, EMBEDDED_PUBLIC_KEY)
}

/// [`verify`] against a given key. Split out so the tests can sign with a
/// throwaway keypair instead of needing the platform's.
pub fn verify_with(token: &str, pem: &str) -> Result<Verified, LicenceError> {
    decode(token, pem, Expiry::Enforced)
}

/// [`verify_cached`] against a given key.
pub fn verify_cached_with(token: &str, pem: &str) -> Result<Verified, LicenceError> {
    decode(token, pem, Expiry::Ignored)
}

/// Whether `exp` is a rule or a note. Named rather than a bare `bool` at the
/// call site, because "verify(token, key, false)" is unreadable in exactly the
/// place where the reader most needs to know what was skipped.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Expiry {
    Enforced,
    Ignored,
}

fn decode(token: &str, pem: &str, expiry: Expiry) -> Result<Verified, LicenceError> {
    if !is_pem(pem) {
        return Err(LicenceError::NoKey);
    }
    let key = jsonwebtoken::DecodingKey::from_rsa_pem(pem.trim_start().as_bytes())
        .map_err(|e| LicenceError::BadKey(e.to_string()))?;

    // RS256 and only RS256. The algorithm comes from this line and never from
    // the token's own header, which is the `alg: none` mistake and the
    // "verify an RS256 token as HS256 using the public key as the HMAC
    // secret" mistake, both in one.
    let mut rules = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    // No audience is claimed yet. Left off rather than guessed: a validator
    // configured against a value nobody sends rejects every real token.
    rules.validate_aud = false;
    // `exp` stays *required* under both policies even though only one of them
    // reads it: a licence token without an expiry is not a shape this build
    // has agreed to accept, and the cached path skipping the check is not the
    // same as it accepting a token that never had one.
    rules.required_spec_claims = ["exp", "sub"].iter().map(|s| s.to_string()).collect();
    rules.validate_exp = expiry == Expiry::Enforced;
    // A minute, for the clock on this machine being a minute out. Not more:
    // on the live path the expiry is the only thing standing between a
    // cancelled account and a permanently valid licence.
    rules.leeway = 60;

    jsonwebtoken::decode::<LicenceClaims>(token, &key, &rules)
        .map(|d| Verified(d.claims))
        .map_err(|e| LicenceError::Invalid(e.to_string()))
}

/// Read a token's claims **without checking anything**.
///
/// For `--licence-probe` only, so a real response's shape can be read before
/// the signing key exists. Never call this on a path that decides entitlement:
/// the payload of a JWT is public, editable text until a signature says
/// otherwise, and the return type here deliberately is not [`Verified`].
pub fn claims_unverified(token: &str) -> Result<LicenceClaims, LicenceError> {
    use base64::Engine;
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| LicenceError::Invalid("not a JWT: no payload segment".into()))?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| LicenceError::Invalid(format!("payload is not base64url: {e}")))?;
    serde_json::from_slice(&raw).map_err(|e| LicenceError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway RSA public key and tokens signed with its private half.
    ///
    /// The private half was generated for these fixtures, used once, and
    /// thrown away — it is deliberately **not** in the repository, so there is
    /// no key-shaped file here for a scanner to flag or for anyone to wonder
    /// about. Regenerating these is a `openssl genpkey` and a shell loop; it
    /// has not been needed, because the expiries below are absolute.
    const TEST_PUBLIC: &str = include_str!("../keys/testing-only.pub.pem");

    /// `sub: u-1`, `status: active`, `plan: pro`, expiring in 2100 — far
    /// enough out that this test does not acquire a deadline.
    const VALID: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzIjoiYnVpbGRubGF1bmNoYWkiLCJzdGF0dXMiOiJhY3RpdmUiLCJwbGFuIjoicHJvIn0.uNPihDjHOtLHnus2kAtWpQtxuiBYU3mP-2CSXV3TeMLfjlf8coudnHWFkOmK0a1f-EJL7eWldGCm7ZgJc-r9KkabKjJ7KsghkOCaae1ncI5SL2mQ-v4NePK-ziEgEvuofC04BzOn7ACZkycbx9vAoApwJ7tFyMa8tAa2e85DWEF_oPgxGhHw2toxDmQ_NlIjVbsLbSnMuG2jaUizQRrrjwEmFRHj5VGN8Rhe0gTaQN9Kpeg8I1xnbG_qe_R3BkvKTZrfcpxA3h1FvmGt1Hepq16qR3U3Vnlsh5YZySbSel1hr8gn2LHSgAkBHyfxZAteZwOlgLVmImvyE7vEYq9U2Q";
    /// Genuinely signed, `active: true`, and expired since 2020.
    const EXPIRED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE1Nzc3NTA0MDAsImV4cCI6MTU3NzgzNjgwMCwiYWN0aXZlIjp0cnVlfQ.fDiNHnyR1GdmfKB1O4Hxnms-7SQqU9KwM2QVJDtQl8Wf8Hlr4VX9kbvwHDlx4DgrPmjQJpRWc_4eYeaw7WlnD29W0OfXymdGGi48GAU_z-8dYdNgzfTDU8LcaQyubXjDbwqKwWYxt9ElcF6wjqLH-N_aJPxSu1ATmGC5kfQLdtyF2zQqfiuV0MZpvNXb0WjzIKdQdXr2gG4rlBqwGERVPeXLSgnWxDooFRf6FsNUfGfZNPfqW_xGzeGYAGJb64KXtPnry8CbfqkTzdvG8Y9zzsTJMPNQzNshfWqLtZaHy81qpLUWA1e6ekHQY65CA9Y6hDk0Rhgo3kxX2FM2ExOpUg";
    /// A real licence, for `u-other`.
    const OTHER: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LW90aGVyIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDAsImFjdGl2ZSI6dHJ1ZX0.hGI8K5NNHDAvDEoLtYZrviKK3tsDvMAyAmUKv7X5sWKPDkIBVQb2S_aNF7idh3Kh62bGxouEo2X4kSVIoGDOSSnEA9GtBkVXl4bU-QIMClnGhua7c39-Q3f4sHz4gi3v37cjYldId9i1HE4tqlfyOknPS-EQbWUXFrZj05rTaFVPDcaHb8fT-4Rk2QvFEFAVVviP4zPKB4Kv4NjAxPDAeHoznWg4hiLavBIHZJi5pIGWIUQ_npXgxvsMLUOwsjOMRZdTSbqNmcfsPWV6KFUb1VmuzPD8HQqa0On9HKLFGwFD00nqSHPIA1YzSwq5mGm4U28XGAODSRhVQgkIOOX__g";
    /// Carries `seats` and `org`, which this build has never been taught.
    const EXTRA: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjp0cnVlLCJzZWF0cyI6Mywib3JnIjoiYWNtZSJ9.G9wIC6rK8gM0ZftPkIkE8INboFYR5QzjR6sFLRgJmIGfrTxYkBqRLtz1hbrOZ1ZjxMkSWEb8savwUIVjxM1RZHpHKt_XEixSbeBpDEar8BKZ5ma8wjw2-NO56Nc5WpWXRYZfqdxChRCTnbadgGCL1Le9aDj4Zmf0C2oMIQLOXLDisl-NleJH8sEXoRvo0Ocrl9JtGt5wI_ikFPKdEO09v92Xje5uVL-Rfm6hHtsfsZF2GeiaUv_upI31Lo5Nl9Xj9W-k8qZzNjyIpP8Y8fx3MVzgnpwSGaczC-Fy_dn0tNsgGrt5n2UR7aGQE-UlKvJ1xYQzfcU0_Jx7DczxWh-PnA";

    #[test]
    fn a_token_the_platform_signed_is_accepted_and_read() {
        let v = verify_with(VALID, TEST_PUBLIC).expect("verifies");
        assert!(v.entitled());
        assert!(v.matches("u-1"));
        assert_eq!(v.claims().plan.as_deref(), Some("pro"));
        assert_eq!(v.claims().iss.as_deref(), Some("buildnlaunchai"));
    }

    /// The point of the whole module: a token nobody signed must not pass.
    #[test]
    fn a_forged_token_is_refused() {
        // A well-formed JWT with a signature made up out of nothing.
        let forged = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJleHAiOjk5OTk5OTk5OTl9.bm90LWEtc2lnbmF0dXJl";
        assert!(matches!(verify_with(forged, TEST_PUBLIC), Err(LicenceError::Invalid(_))));
    }

    /// Editing the payload of a signed token must break it. This is the
    /// attack the cache exists to resist: take yesterday's real licence, move
    /// the expiry, put it back on disk.
    #[test]
    fn a_tampered_payload_breaks_the_signature() {
        use base64::Engine;
        // The real attack: take the expired-but-genuine token and move its
        // expiry to 2100, leaving the signature it came with.
        let mut parts: Vec<&str> = EXPIRED.split('.').collect();
        let swapped = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"u-1","iat":1577750400,"exp":4102444800,"active":true}"#);
        parts[1] = &swapped;
        let tampered = parts.join(".");

        // The payload now says what the attacker wanted …
        assert_eq!(claims_unverified(&tampered).expect("reads").exp, 4102444800);
        // … and it is worth nothing.
        assert!(matches!(verify_with(&tampered, TEST_PUBLIC), Err(LicenceError::Invalid(_))));
    }

    #[test]
    fn an_expired_licence_is_refused_rather_than_read() {
        assert!(matches!(verify_with(EXPIRED, TEST_PUBLIC), Err(LicenceError::Invalid(_))));
    }

    /// Somebody else's perfectly valid licence is still somebody else's.
    #[test]
    fn a_licence_for_another_account_does_not_match_this_one() {
        let v = verify_with(OTHER, TEST_PUBLIC).expect("verifies");
        assert!(v.entitled(), "it is a real licence — just not ours");
        assert!(!v.matches("u-1"));
        // And an empty user id must never match, or "nobody signed in" would
        // silently satisfy the check.
        assert!(!v.matches(""));
    }

    /// The build ships without a key today, and that has to be its own answer
    /// rather than a verification failure — the two lead to different code.
    #[test]
    fn a_build_with_no_key_says_so_instead_of_failing_the_token() {
        assert_eq!(verify_with("anything", "not a pem"), Err(LicenceError::NoKey));
        assert!(!is_pem("Placeholder. Replace this whole file"));
        assert!(is_pem("-----BEGIN PUBLIC KEY-----\nMII…\n"));
    }

    /// The key this build actually ships with loads, and is a key.
    ///
    /// `verification_available` only looks at the first line, which is enough
    /// to tell a placeholder from a key and not enough to tell a key from a
    /// corrupted one. This puts it through the same parser the real path uses:
    /// handed a token that is not a token, a *loadable* key answers `Invalid`
    /// — it got far enough to look. A key that failed to parse would answer
    /// `BadKey`, and one that was still the placeholder `NoKey`. So the
    /// distinction being asserted here is the whole point.
    #[test]
    fn the_shipped_key_loads() {
        assert!(verification_available(), "the licence key is missing or is still the placeholder");
        match verify_with("not.a.token", EMBEDDED_PUBLIC_KEY) {
            Err(LicenceError::Invalid(_)) => {}
            Err(LicenceError::BadKey(e)) => panic!("the compiled-in key does not parse: {e}"),
            other => panic!("expected the token to be refused by a working key, got {other:?}"),
        }
    }

    /// And it is a *particular* key.
    ///
    /// The fixtures above are signed by the throwaway test key, so the shipped
    /// key must refuse every one of them. If it accepted any, the verifier
    /// would be checking something other than what it claims to — which is the
    /// failure mode that looks exactly like success until somebody forges a
    /// licence.
    #[test]
    fn the_shipped_key_refuses_tokens_it_did_not_sign() {
        for (name, token) in [("valid", VALID), ("other", OTHER), ("extra", EXTRA)] {
            assert!(
                matches!(verify_with(token, EMBEDDED_PUBLIC_KEY), Err(LicenceError::Invalid(_))),
                "the shipped key accepted the {name} fixture, which it did not sign"
            );
        }
    }

    #[test]
    fn entitlement_reads_a_boolean_before_a_word_and_neither_means_no() {
        let c = |v: serde_json::Value| serde_json::from_value::<LicenceClaims>(v).expect("parses");
        assert!(c(serde_json::json!({"sub":"u","exp":1,"active":true,"status":"canceled"})).entitled());
        assert!(!c(serde_json::json!({"sub":"u","exp":1,"active":false,"status":"active"})).entitled());
        assert!(c(serde_json::json!({"sub":"u","exp":1,"status":"trialing"})).entitled());
        assert!(c(serde_json::json!({"sub":"u","exp":1,"status":"Active"})).entitled());
        assert!(!c(serde_json::json!({"sub":"u","exp":1,"status":"past_due"})).entitled());
        // The one that matters: silence is not consent.
        assert!(!c(serde_json::json!({"sub":"u","exp":1})).entitled());
        // `entitled` is accepted as a spelling of `active`, because the exact
        // field name is the platform's to choose and this costs nothing.
        assert!(c(serde_json::json!({"sub":"u","exp":1,"entitled":true})).entitled());
    }

    /// Claims this build has never heard of survive, so a real response can be
    /// read in full by the probe without shipping a new binary first.
    #[test]
    fn unknown_claims_are_kept_rather_than_dropped() {
        let v = verify_with(EXTRA, TEST_PUBLIC).expect("verifies");
        assert_eq!(v.claims().extra.get("seats").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(v.claims().extra.get("org").and_then(|v| v.as_str()), Some("acme"));
    }

    /// The probe reads a shape without vouching for it, and says so by not
    /// returning a `Verified`.
    #[test]
    fn the_probe_reads_claims_without_checking_them() {
        // Expired, so the real verifier refuses it …
        assert!(verify_with(EXPIRED, TEST_PUBLIC).is_err());
        // … and the probe still shows what it said.
        let c = claims_unverified(EXPIRED).expect("reads");
        assert_eq!(c.sub, "u-1");
        assert_eq!(c.active, Some(true));
        // Which is exactly why its return type is not `Verified`.
        assert!(claims_unverified("not.a.jwt").is_err());
    }

    /// The cached reader's whole reason to exist: a token the live path would
    /// refuse for being old is still *evidence of what the platform said*, and
    /// the offline grace is built on exactly that.
    #[test]
    fn a_cached_licence_survives_its_own_expiry() {
        // The live path refuses it …
        assert!(matches!(verify_with(EXPIRED, TEST_PUBLIC), Err(LicenceError::Invalid(_))));
        // … and the cached path reads it, because how long the grace runs is
        // `entitlement.ts`'s decision and not the backend's `exp`.
        let v = verify_cached_with(EXPIRED, TEST_PUBLIC).expect("verifies");
        assert!(v.entitled());
        assert!(v.matches("u-1"));
    }

    /// Relaxing the expiry must not relax anything else. If it did, the cache
    /// would be an editable file again and the whole module would be theatre.
    #[test]
    fn the_cached_reader_relaxes_the_expiry_and_nothing_else() {
        use base64::Engine;

        // A signature made up out of nothing.
        let forged = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJleHAiOjk5OTk5OTk5OTl9.bm90LWEtc2lnbmF0dXJl";
        assert!(matches!(verify_cached_with(forged, TEST_PUBLIC), Err(LicenceError::Invalid(_))));

        // The attack this defends: take a genuine "no" off the disk and edit
        // it into a "yes". Both fields an attacker would want are covered.
        let mut parts: Vec<&str> = EXPIRED.split('.').collect();
        let swapped = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"u-1","iat":4102444800,"exp":4102444800,"active":true}"#);
        parts[1] = &swapped;
        let tampered = parts.join(".");
        assert!(matches!(verify_cached_with(&tampered, TEST_PUBLIC), Err(LicenceError::Invalid(_))));

        // Somebody else's cache file is still somebody else's.
        let other = verify_cached_with(OTHER, TEST_PUBLIC).expect("verifies");
        assert!(!other.matches("u-1"));
        assert!(!other.matches(""));

        // And a build with no key cannot read a cache either — which must be
        // its own answer, not a verification failure.
        assert_eq!(verify_cached_with(EXPIRED, "not a pem"), Err(LicenceError::NoKey));
    }

    /// The grace period is counted from this, so it has to come off the signed
    /// claims rather than off the file the claims arrived in.
    #[test]
    fn the_signed_issue_time_is_what_a_cache_can_be_dated_by() {
        let v = verify_cached_with(VALID, TEST_PUBLIC).expect("verifies");
        assert_eq!(v.issued_at(), Some(1_767_225_600));
        assert_eq!(v.expires_at(), 4_102_444_800);

        // A token that does not say when it was issued reports nothing rather
        // than reporting the epoch, which would date every cache to 1970 and
        // send everybody straight to read-only.
        let c: LicenceClaims =
            serde_json::from_value(serde_json::json!({"sub":"u","exp":1,"active":true}))
                .expect("parses");
        assert_eq!(Verified(c).issued_at(), None);
    }
}
