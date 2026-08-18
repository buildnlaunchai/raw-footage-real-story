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

/// Why the platform is saying no.
///
/// These four words and no others. The backend confirmed the field and the
/// vocabulary against production, which is what lets this be an exact,
/// case-sensitive match instead of the substring search it replaces — that
/// looked in two fields for the letters "suspend" because nobody yet knew
/// which field or which spelling would arrive.
///
/// The mirror is `Denial` in `src/lib/entitlement.ts`, and the wire format
/// between them is the platform's own word, unchanged.
///
/// ## What an unrecognised word means, and why it is not a refusal
///
/// [`parse`](Denial::parse) answers `None` for anything not on this list, and
/// `None` means "no opinion" rather than "denied". A build that treated every
/// word it had never seen as a denial would lock out every paying customer the
/// day the platform added a `reason: "grace_period"` beside an entitled
/// account. Each of the four below *is* a denial, so a known word blocks; an
/// unknown one leaves the entitlement to be decided by `active` and `status`,
/// exactly as it was before any reason existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denial {
    /// Barred. Not fixed by paying, and must never be offered a billing page.
    Suspended,
    /// Never subscribed. The one denial an ordinary checkout does fix.
    NoMembership,
    /// Subscribed once and it has lapsed. `expires_at` says when.
    MembershipInactive,
    /// Entitled as far as billing is concerned, and refused anyway. Ours to
    /// fix, which is why the screen for it says support and not subscribe.
    NoAccess,
}

impl Denial {
    /// Exact and case-sensitive, because the platform's spelling is now known.
    pub fn parse(reason: &str) -> Option<Self> {
        Some(match reason {
            "suspended" => Self::Suspended,
            "no_membership" => Self::NoMembership,
            "membership_inactive" => Self::MembershipInactive,
            "no_access" => Self::NoAccess,
            _ => return None,
        })
    }

    /// The platform's own word. What crosses into the frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Suspended => "suspended",
            Self::NoMembership => "no_membership",
            Self::MembershipInactive => "membership_inactive",
            Self::NoAccess => "no_access",
        }
    }
}

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
    /// Why the platform is saying no — see [`Denial`] for the vocabulary.
    ///
    /// **This claim is the whole offline story.** The plain JSON fields beside
    /// the token are gone the moment the process exits; this is signed, so it
    /// survives on disk and can still be read on a plane. Without it a
    /// suspended account reopening the app offline could only be told the
    /// generic "no subscription", which is the one message that is actively
    /// wrong for them — it points at a billing page that cannot help.
    #[serde(default)]
    pub reason: Option<String>,
    /// When the membership ended, for [`Denial::MembershipInactive`]. ISO-8601.
    ///
    /// Optional in a stronger sense than the rest: the platform mirrors it in
    /// the JSON response for certain, and whether it also signs it into the
    /// claims is its own business. So the screen that shows it has to read
    /// well without a date — see `membershipEnded` in `entitlement.ts`.
    #[serde(default, alias = "expiresAt")]
    pub expires_at: Option<String>,
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
    /// The reason this token carries, if it is one this build knows.
    pub fn denial(&self) -> Option<Denial> {
        self.reason.as_deref().and_then(Denial::parse)
    }

    /// Whether this token says yes.
    ///
    /// A recognised denial reason beats everything else; then an explicit
    /// boolean wins over the word; and a token carrying none of the three is
    /// read as **not** entitled, because a licence that does not say what it
    /// grants grants nothing.
    ///
    /// The reason is folded in *here*, rather than being applied by each
    /// caller, so that it is not possible to read this token's entitlement
    /// without it. A backend that suspends an account while leaving
    /// `active: true` beside it is an ordinary bug, and the restrictive
    /// reading is the one that is right about the account.
    pub fn entitled(&self) -> bool {
        if self.denial().is_some() {
            return false;
        }
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
    /// about. Regenerating these is a `openssl genpkey` and a shell loop,
    /// which is what was done when the `reason` claim arrived and the fixtures
    /// below had to say things the old key could no longer be asked to sign.
    /// The payloads of the four that predate it are byte-identical to what
    /// they were; only the signatures changed.
    const TEST_PUBLIC: &str = include_str!("../keys/testing-only.pub.pem");

    /// `sub: u-1`, `status: active`, `plan: pro`, expiring in 2100 — far
    /// enough out that this test does not acquire a deadline.
    const VALID: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzIjoiYnVpbGRubGF1bmNoYWkiLCJzdGF0dXMiOiJhY3RpdmUiLCJwbGFuIjoicHJvIn0.Km_EqfNNNw7_G93eTo-EmmrI5oVAl0Jhoj-4IR5AlWzmXt-Rozj7Q0O1cF2DMd21gT6FdEdYoOdRv7PvK49s2NwRNiE5uoRdP5TiQCJkVFo4HQ8f45Onr1GLbT6vfk9cEdOaAdkYbz2Ar0eoz7kJCObJ3CksRG-2jpkudBL_4i9rMMQrCpnyAzsR6Gbku8FRI0q4oW8_rdq1w9UnKbgwCH5jKWzZ9dpSzwRLWqxBayEtFHoOcUlWUNMnaya7Mm6Jlv1S92Z_d_487DDzZVB0WWRWEXXF3L0N4DRz1Jwznd3z4MPrE0nvew6Y2p0EcRfJnPfKXueyE_OEuxLdT9Fbig";
    /// Genuinely signed, `active: true`, and expired since 2020.
    const EXPIRED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE1Nzc3NTA0MDAsImV4cCI6MTU3NzgzNjgwMCwiYWN0aXZlIjp0cnVlfQ.rEhjTvVtvoyxc-JdvHOmUzBwFWil77IAsvNgx9Z3haZ2Vg2hZHKtMlhOsTsAtbYfmcy7YDokYsUYlihScpV4NEgUVzxIf_qa75KS3fFOpQcu90upPPUSvry6mpqaOTB1I15BFqES6khD4QQhcSvvCOdAwa143tXgVnq57ytKxudLlJ1RjvMXokBt2W3_tRjmYsmFhxBuc_Ur0vu3Z6mbznhHo94YHbIBeJRpk9uj-9wcVTOEmngey4XAJgV4mQL8susNCvKaFXDr_fobm0acs9bAz-6k6jZl0oXaMVjErL7SXy5kkPYXVrFjK_ts4d8pOfbTDN6nVT5l8i0-aJCJ-g";
    /// A real licence, for `u-other`.
    const OTHER: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LW90aGVyIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDAsImFjdGl2ZSI6dHJ1ZX0.tuts1gorXg9WJx6DEnQ30hGEBa-gvl47sWOxqEpFi_FaST4XRhtNSlXDnGe1-2sF2T402Yz9vlfzrUsDZxyVwP4GBcj-FzqaY2nXuMiN-zzmKg6INavYVzSBu6PjFK3xwENZnGCbVziZvwQNSyv7IsKk0f0ibAZst7J5rbDawBvKCGnPSezFRd8vsYFpkgkJHfHkrqxdG7NHdEjnYQrNkjFhmjUeKYfByO8KjT7I1kQf_zYwEtyayDL3KoM-BFAUc9X-iesTwO2NDcL5Wpuxknb6yfK1oVPE_iXPUiPsjsnEvZEU3mzQu2GXRb5_9rAwgxsKTJfJeowZmI8RIXxFsw";
    /// Carries `seats` and `org`, which this build has never been taught.
    const EXTRA: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjp0cnVlLCJzZWF0cyI6Mywib3JnIjoiYWNtZSJ9.fARGHR9yEvJn9o1ux1AjwdFG7M8ddWBTuBO3Hgtq2LR9_Cb4TRMpA7d9kYuOz7-1dk_Z70zDbHib86wl3Yx0W2zrilFobVhBBL3HDMlPaGQMbsJqYPSVVxV6hQSKiLHbyyEKsCEbd9B9qOuIadCk8mc_LCXNOA4ZOg-RM9DHMFhU1MIc0inOLI8HegbBHy0OgyoOguIOLbjfqTGI_-003CtRdQFRjcYe3iIfkeaUjJmLt6RvFYzSqzwbOWlZsjJ3C7-kITiooNvbbM7TK4e5Cming3pgVq2fXKeENutjbjMPKoSy5y0dDw10xU29wzlHtMt5Is05qPQ1qkvKyxTnvQ";
    /// `reason: suspended`, and **`active: true` beside it**. The reason has
    /// to win, or the contradiction becomes a month of offline access.
    const SUSPENDED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjp0cnVlLCJzdGF0dXMiOiJhY3RpdmUiLCJyZWFzb24iOiJzdXNwZW5kZWQifQ.rhgf604dz7TrvxQOwNLyuL0DkSsTywhNWgwplW-RgSPlCIrksgNwfUFHrCEOLcm2DpmVX8_LuKHiy3IMNgqpynhpPWQ-wl902oerlEZ_kIctzF4KssSd2P8MU7SD9_srYanDMX7PY9NUyrJV1ZlCgcLjBNNzTjMkxpeWKqJ-dZJtYZW3VJYRHr0UQluPokLJqLR57Ni2PSj5UglPeWCtBCqG0-5cQdH3HpFA82rL1wH6vwhYPmij9YB22mFoeqpLx96e7pjPEQmFxAGRsIgjqfRukK19Xbzi9czx18D3lQMvOwq57DRxcp-01T7aYBPPXkRcp3FlsgNzVYmdSRN_kg";
    /// `reason: membership_inactive`, with the date it lapsed.
    const ENDED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjpmYWxzZSwic3RhdHVzIjoiY2FuY2VsZWQiLCJyZWFzb24iOiJtZW1iZXJzaGlwX2luYWN0aXZlIiwiZXhwaXJlc19hdCI6IjIwMjYtMDctMDFUMDA6MDA6MDBaIn0.svbI-2UohdIyBOnGL7e882rBV6Q8y7auPIMpJ3t4Y5H_hXRU9WfOIrm5dSArxYQ6KBU2APQE6q1RwIUEym2XnNHrwwkQpOJQUdFvsI8AdVnoNG93OYf8Uh3FfxZujddp66z0sy0TKzm-NEUb_64egin42EhLnejbmqeenAWirKulbZvvANO3WDAki4REofeZ8QhofsJF_rCqlvlme8BJMdg_ibrv3xJyCzjpS-OfeU2bCBvJTZ9AK1I6oed8JrzXgyKjo41gsnfqplqBMxwHero0DgWd-IsvLzqp7k9puwX6cRZMr34waHMa2XdfrhedmuA7Ne4Ol0DVCZ11pYSu7Q";
    /// `reason: no_membership`. Never subscribed.
    const UNPAID: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjpmYWxzZSwicmVhc29uIjoibm9fbWVtYmVyc2hpcCJ9.CLM5fjvi6-c0Avl_KRbq3Yj6-2FLVuZisxveAL0Fo1-MG56Q0GIcNCh8_5kBsGW4fkT2FewBFaksqF03L4WmkVUDgRkCn4bOdRSZOwdCy80uvqYcTOM1igqb12iCi24X0Wxw7vUvNYUqOCVcNGZ2a1xcA7cNZsLONfeRW27gx2w_7XWesPHCJoLUKg-uONHRUcL-h8B-thnbKKwHCNtc-v_CaEDbCvvvcXm0EjnvKkCkRwl7S7E51PawMfHFSjFwxNe3omwdjVjdRIup1-nCGYHmXhWDSOF2j2fH-Nx-LoinYPmedU_VEhuigs91D8DwZ3Ndf3_gBPoLBa64RCXohg";
    /// `reason: no_access`. Ours to fix, not theirs to pay for.
    const NO_ACCESS: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjpmYWxzZSwicmVhc29uIjoibm9fYWNjZXNzIn0.opAFAwbTo5oU8smJjdxu9olTPZIHpzRkor_byahGBO9djFExbWLi2SR5zNnCpQB6Wvq5-0rlp9-qfx4D745P8AC7AVV3Q6dSu85qiQXLal3WQrtbWqGjkgdiimHSfF9GSDgG4s0CZUtrh2sE7J2KcDqpsvwA63FqlJln7Zv23WslZnCIQjPXJ_ZvCBfR62AIYqUDeW5wuHHEKgon7BGXRkHU99efFDPibYJ-DhQp2FDyN8wxPg6gel_8Ue_yi493k1wXox9yDU4uIPgJwz7IVBv21gw1cego9tyrx8RD5RAZJcSbimUqJwEhxYRRMNtdfOjqksDksymR7K2gXOcHbQ";
    /// A reason this build has never been taught, on an entitled account.
    const ODD_REASON: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjp0cnVlLCJyZWFzb24iOiJncmFjZV9wZXJpb2QifQ.bVRnPwClzgzhPFy6D5I-DDJT7F5UHlVAECMeBc9sbQnwJgszkM7_tlE9mCq_SIgM3-vnpwmEoN-hQWhh35vmjca4XE-o9hEQWOi7spAnx4XuGemW52ovL8dultmmILyx0jO22MISyt8iiS9wecvNvENGm3XAxA_PGl6utXeAa_GEa_M1TEKs4ISbTi9BzKzv15QT80JzGTNSSdYrZQVmQTfbzLEIQ9o1A7KYtaSjyJKP5rHz-O8-BslUTp-vgcoLDAdcY5Ln-d09Rz8yVyg0SwxQYyyMopoWhixRGP4RXbo9InuANQxMwXZmPkI7QMtRQf23nBcuz5z9Lv6a6iDoFw";

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

    // ── the reason claim ───────────────────────────────────────────────────
    //
    // Confirmed against production: `reason` is the field, and the four words
    // below are the vocabulary, carried in the signed claims as well as in the
    // JSON beside them. The signed half is the one that matters here, because
    // it is the half that survives being written to disk and read on a plane.

    #[test]
    fn the_four_reasons_are_matched_exactly_and_nothing_else_is() {
        for (word, expected) in [
            ("suspended", Denial::Suspended),
            ("no_membership", Denial::NoMembership),
            ("membership_inactive", Denial::MembershipInactive),
            ("no_access", Denial::NoAccess),
        ] {
            assert_eq!(Denial::parse(word), Some(expected));
            // And the word survives the round trip, because it is what the
            // frontend is handed and matches on in turn.
            assert_eq!(expected.as_str(), word);
        }

        // Everything the old substring search used to catch. Now that the
        // spelling is known, matching loosely would only invent denials the
        // platform never sent.
        for word in [
            "Suspended",
            "SUSPENDED",
            "account_suspended",
            "suspend",
            "no_subscription",
            "canceled",
            "past_due",
            "active",
            "",
        ] {
            assert_eq!(Denial::parse(word), None, "{word:?} was read as a denial");
        }
    }

    /// The rule that closes the offline gap: a suspension in the signed claims
    /// refuses the licence even though the same token says `active: true`.
    #[test]
    fn a_reason_in_the_claims_beats_the_entitlement_beside_it() {
        let v = verify_with(SUSPENDED, TEST_PUBLIC).expect("verifies");
        assert_eq!(v.claims().active, Some(true), "the fixture must contain the contradiction");
        assert_eq!(v.claims().status.as_deref(), Some("active"));
        assert_eq!(v.claims().denial(), Some(Denial::Suspended));
        assert!(!v.entitled(), "a suspended token granted a month of offline access");

        for (token, reason) in [
            (UNPAID, Denial::NoMembership),
            (ENDED, Denial::MembershipInactive),
            (NO_ACCESS, Denial::NoAccess),
        ] {
            let v = verify_with(token, TEST_PUBLIC).expect("verifies");
            assert_eq!(v.claims().denial(), Some(reason));
            assert!(!v.entitled());
        }
    }

    /// The other direction, and the more expensive one to get wrong: a word
    /// this build has never seen must not refuse anybody. The day the platform
    /// puts a `reason` beside an entitled account — a trial note, a dunning
    /// warning — every paying customer would otherwise be locked out by an
    /// app that had opinions about vocabulary it was never taught.
    #[test]
    fn an_unrecognised_reason_does_not_refuse_an_entitled_account() {
        let v = verify_with(ODD_REASON, TEST_PUBLIC).expect("verifies");
        assert_eq!(v.claims().reason.as_deref(), Some("grace_period"));
        assert_eq!(v.claims().denial(), None, "a word off the list was treated as a denial");
        assert!(v.entitled(), "an unknown reason locked out a paying account");
    }

    /// The date the membership lapsed rides along when the platform signs it,
    /// and its absence is not a failure — the screen reads without it.
    #[test]
    fn the_end_date_is_carried_when_it_is_there_and_missed_quietly_when_it_is_not() {
        let ended = verify_with(ENDED, TEST_PUBLIC).expect("verifies");
        assert_eq!(ended.claims().expires_at.as_deref(), Some("2026-07-01T00:00:00Z"));
        // Same denial, no date. Legal, and `entitlement.ts` has copy for it.
        let unpaid = verify_with(UNPAID, TEST_PUBLIC).expect("verifies");
        assert_eq!(unpaid.claims().expires_at, None);
        // camelCase is accepted too, since which spelling a JWT claim takes is
        // the platform's to choose and being wrong here loses only the date.
        let c: LicenceClaims = serde_json::from_value(
            serde_json::json!({"sub":"u","exp":1,"reason":"membership_inactive","expiresAt":"2026-07-01T00:00:00Z"}),
        )
        .expect("parses");
        assert_eq!(c.expires_at.as_deref(), Some("2026-07-01T00:00:00Z"));
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
