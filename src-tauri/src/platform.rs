//! Talking to the BuildnLaunchAI platform: tokens, licence, provider keys.
//!
//! Every request here is addressed by a base URL passed in rather than by a
//! constant reached for at the call site, which is what lets the tests point
//! it at a stub on loopback and lets staging and production differ without a
//! rebuild. The default that base resolves to *is* compiled in — see
//! [`config`] for why that is not a contradiction.
//!
//! ## The four addresses
//!
//! One Supabase project hosts all of them, so one base URL is enough:
//!
//! | what                | where                                  |
//! |---------------------|----------------------------------------|
//! | start a login       | `{base}/auth/v1/authorize`             |
//! | code → session      | `{base}/auth/v1/token?grant_type=pkce` |
//! | refresh → session   | `{base}/auth/v1/token?grant_type=refresh_token` |
//! | is this account in? | `{base}/functions/v1/desktop-licence`  |
//! | what keys do we hold? | `{base}/functions/v1/desktop-keys`   |
//! | which builds may run? | `{base}/functions/v1/desktop-config` |
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
//! expires. Fetched into memory once per session and never persisted — see
//! [`ProviderKeys`], and [`crate::provider_keys`] for the fetching.

use serde::{Deserialize, Serialize};

/// Where the credentials for a cloud provider came from.
///
/// `Byok` is the user's own key, held on the platform on their behalf and
/// billed to them. `Credit` is the platform's own key, spent against credits
/// they have bought. The distinction has to reach the UI either way: "your key"
/// and "your credits" fail differently and a person needs to know which they
/// are looking at.
///
/// ── TWO THINGS THIS TYPE GOT WRONG, BOTH FIXED HERE ──────────────────────
///
/// 1. THE WORD. This variant was called `Platform` and therefore deserialised
///    `"platform"`. The hub has always sent `"credit"` — that string is in
///    `desktop-keys` and in the gateway's own mode check. So the moment a
///    member's account entered credit mode, this app could not read the keys
///    response AT ALL and showed them a platform error, when the true answer
///    was "you are on credits". A vocabulary invented on this side of a
///    contract is not a vocabulary.
///
/// 2. STRICTNESS. Worse than the wrong word was that an unrecognised one was
///    FATAL. `#[serde(default)]` only fills a field that is ABSENT; a field
///    present with an unknown value is a hard error, and it failed the whole
///    `ProviderKeys` parse rather than the one field. The hub's contract says
///    the opposite — that it may add a value safely and an older build should
///    fall through to its generic wall. So an unknown mode is now `Unknown`,
///    not an error, and the next mode the hub invents will not brick every
///    build shipped before it. That is the actual bug; the missing variant was
///    only the first time it fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyMode {
    Byok,
    Credit,
    /// A mode this build has not been taught. Decides nothing on its own — the
    /// per-provider slots still say what is available and why — but it lets the
    /// UI say "update the app" instead of guessing.
    Unknown,
}

impl<'de> Deserialize<'de> for KeyMode {
    /// Hand-written for exactly one reason: to never fail. See note 2 above.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.as_str() {
            "byok" => KeyMode::Byok,
            "credit" => KeyMode::Credit,
            _ => KeyMode::Unknown,
        })
    }
}

/// Why a provider slot is withheld, in the platform's own word.
///
/// Three, and they are not interchangeable — each names a different thing
/// being wrong and a different page that fixes it:
///
/// - `consent_required` — a key exists, and this app has not been granted
///   permission to read it. Saying "you have no key" here is simply false, and
///   the dashboard's provider page cannot grant the permission either.
/// - `no_key` — nothing is stored. The vault is where one gets added.
/// - `key_invalid` — something is stored and was rejected. Needs replacing.
///
/// Carried as an `Option<String>` on the wire and narrowed here, so a word this
/// build has never seen is *not* an error: it decides nothing, falls back to
/// the generic wording, and the `consent_url` beside it still works. That is
/// the same treatment [`LicenceResponse::reason`] gets and for the same reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WithheldReason {
    ConsentRequired,
    NoKey,
    KeyInvalid,
}

impl WithheldReason {
    pub fn parse(s: Option<&str>) -> Option<Self> {
        match s? {
            "consent_required" => Some(Self::ConsentRequired),
            "no_key" => Some(Self::NoKey),
            "key_invalid" => Some(Self::KeyInvalid),
            _ => None,
        }
    }
}

/// One provider's credentials as the platform reports them.
///
/// `present: false` with no key is a real answer and a different one from an
/// empty string: it means "this app cannot use an OpenAI key on your behalf
/// right now", which the app answers with the link the platform sent rather
/// than with "your key was rejected".
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub present: bool,
    #[serde(default)]
    pub key: Option<String>,
    /// Whose key it is, when this slot says. Absent means "as the response
    /// says at the top level" — see [`ProviderKeys::mode`], which is where the
    /// confirmed shape carries it.
    #[serde(default)]
    pub mode: Option<KeyMode>,
    /// Where to send this person's browser, from the platform and only from
    /// the platform.
    ///
    /// Sent on every withheld slot, and the app composes no alternative. It
    /// could not compose a correct one if it tried: the destination follows
    /// `reason`, not the provider, and `consent_required` goes to a page whose
    /// address has no provider in it at all. A guess would be a button that
    /// looks right and lands somewhere that cannot help.
    ///
    /// Still an `Option` at this boundary despite being a required field, and
    /// that is deliberate. Making it mandatory would mean a response missing it
    /// fails to parse *as a whole* — taking both providers' keys down over a
    /// cosmetic field, in a binary already on somebody's machine that cannot be
    /// hotfixed. It is read as "no button" instead. See the note on
    /// [`LicenceResponse`] about desktop binaries and unexpected JSON.
    ///
    /// Both spellings are accepted: the struct reads camelCase and the
    /// confirmed shape sends `consent_url`.
    #[serde(default, alias = "consent_url")]
    pub consent_url: Option<String>,
    /// Where to manage a key that already works. The `present: true` half of
    /// the pair above.
    ///
    /// The settled rule is that a slot carries exactly one of these two —
    /// `manage_url` when the key is usable, `consent_url` when it is not,
    /// never both and never neither. Which one is therefore decided by
    /// `present`, and [`ProviderKey::link`] is the single place that decides
    /// it.
    #[serde(default, alias = "manage_url")]
    pub manage_url: Option<String>,
    /// Why it is withheld. See [`WithheldReason`].
    #[serde(default)]
    pub reason: Option<String>,
}

impl ProviderKey {
    /// The last four characters, for showing which key is in use without
    /// showing the key. Never log or render anything longer than this.
    pub fn hint(&self) -> Option<String> {
        let k = self.key.as_deref()?;
        let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        (!tail.is_empty()).then_some(tail)
    }

    /// Whitespace is not a link.
    ///
    /// A slot carrying `""` would otherwise hand the browser nowhere, which is
    /// worse than showing no button at all — the button is the only thing on
    /// that screen a person can act on, so it has to be absent rather than
    /// inert.
    fn usable(url: &Option<String>) -> Option<String> {
        url.as_deref().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string)
    }

    /// The one link this slot carries.
    ///
    /// `present` picks the field, because that is the rule the platform
    /// settled on: a usable key is accompanied by somewhere to manage it, a
    /// withheld one by somewhere to put it right, and never both.
    ///
    /// Strictly one or the other, with no crossing over. The temptation is to
    /// fall back to whichever field happens to be populated, and in one
    /// direction that is actively harmful: a withheld slot answered with a
    /// `manage_url` would send somebody whose key merely needs permission to
    /// the provider page, which cannot grant it. Better a missing button than
    /// a button onto a page that cannot help — the same reasoning that removed
    /// the composed URL.
    ///
    /// So a slot that breaks the contract degrades to no button, which is
    /// cosmetic, rather than to the wrong page, which is not.
    pub fn link(&self) -> Option<String> {
        if self.present {
            Self::usable(&self.manage_url)
        } else {
            Self::usable(&self.consent_url)
        }
    }

    /// The withheld link specifically, for the error path that only ever
    /// describes a withheld slot.
    pub fn consent_link(&self) -> Option<String> {
        Self::usable(&self.consent_url)
    }

    pub fn withheld_reason(&self) -> Option<WithheldReason> {
        WithheldReason::parse(self.reason.as_deref())
    }
}

/// What the platform holds for this person, this session. Memory only.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeys {
    /// Whose keys these are, for the response as a whole.
    ///
    /// The confirmed shape carries it here rather than per provider. A slot may
    /// still override it — see [`ProviderKey::mode`] — which costs nothing and
    /// means the two shapes do not have to be told apart.
    #[serde(default = "byok")]
    pub mode: KeyMode,
    #[serde(default = "absent")]
    pub openai: ProviderKey,
    #[serde(default = "absent")]
    pub elevenlabs: ProviderKey,
}

impl ProviderKeys {
    /// Whose key a given slot is, top-level unless the slot says otherwise.
    pub fn mode_of(&self, key: &ProviderKey) -> KeyMode {
        key.mode.unwrap_or(self.mode)
    }
}

fn byok() -> KeyMode {
    KeyMode::Byok
}

fn absent() -> ProviderKey {
    ProviderKey {
        present: false,
        key: None,
        mode: None,
        consent_url: None,
        manage_url: None,
        reason: None,
    }
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
    read(get(base, "desktop-keys", anon_key, access_token).await?).await
}

/// What `desktop-licence` answers with.
///
/// Two overlapping accounts of the same fact, and they are not equals. The
/// plain fields are what the app reads *now*, on a live answer that arrived
/// over TLS from a host with a valid certificate. `licence_token` is what
/// survives being written down — see [`crate::licence`] for why that
/// distinction is the whole design.
///
/// Every field is optional. The exact spelling of a JSON key is the platform's
/// to choose and a desktop binary that hard-fails on an unexpected one is a
/// desktop binary that locks people out when the backend adds a field.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenceResponse {
    #[serde(default, alias = "entitled")]
    pub active: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    /// Why, when the platform says why. See [`crate::licence::Denial`].
    ///
    /// The field name and its four values are confirmed against production,
    /// so the aliases this used to carry — `suspension_reason`,
    /// `suspensionReason` — are gone with the guesswork that put them there.
    ///
    /// Words off that list are still carried to the frontend untouched and
    /// still decide nothing, which is the same treatment `status` gets and for
    /// the same reason: a desktop binary that has opinions about words it has
    /// never seen is a desktop binary that locks people out when the backend
    /// adds one.
    #[serde(default)]
    pub reason: Option<String>,
    /// When the membership ended. The platform sends it with
    /// [`Denial::MembershipInactive`](crate::licence::Denial), which is the
    /// one screen that has a date to show.
    #[serde(default, alias = "expires_at")]
    pub expires_at: Option<String>,
    /// The signed assertion. British and American spellings both accepted,
    /// because getting this wrong would silently disable verification rather
    /// than fail loudly, and one word is not worth that risk.
    #[serde(
        default,
        alias = "licence_token",
        alias = "license_token",
        alias = "licenseToken"
    )]
    pub licence_token: Option<String>,
}

impl LicenceResponse {
    /// Why the platform is saying no, if it is and if this build knows the
    /// word. See [`crate::licence::Denial`] for the vocabulary and for why an
    /// unrecognised word is not a refusal.
    ///
    /// All four block. The difference is entirely in what the person is told,
    /// and that difference is the whole reason this is not a bool: an unpaid
    /// account is fixed by a checkout, a lapsed one by a renewal, a suspended
    /// one by talking to a person, and `no_access` by us fixing our own bug.
    /// Sending any of the last three to a billing page takes their money and
    /// changes nothing.
    ///
    /// Mirrors `denialFor` in `src/lib/entitlement.ts`.
    pub fn denial(&self) -> Option<crate::licence::Denial> {
        self.reason.as_deref().and_then(crate::licence::Denial::parse)
    }

    /// What the plain fields say, by the same rule the signed claims use —
    /// reason included, so the two halves of one response cannot disagree
    /// about what a denial means.
    pub fn entitled(&self) -> bool {
        crate::licence::LicenceClaims {
            sub: String::new(),
            exp: 0,
            iat: 0,
            iss: None,
            active: self.active,
            status: self.status.clone(),
            plan: None,
            reason: self.reason.clone(),
            expires_at: None,
            extra: Default::default(),
        }
        .entitled()
    }
}

/// Ask whether this account is entitled.
///
/// GET rather than POST: it reads and changes nothing, and the function
/// accepts both. There is no body to get wrong.
///
/// ### Binding a cached licence to an account
///
/// The cache exists now — [`crate::licence_cache`] — and with it the check
/// this used to defer: a stored licence is refused unless its signed `sub` is
/// the account signed in on this machine, which is what stops one
/// subscriber's cache file from working on a friend's laptop.
///
/// The other half of the old note, verifying the *session* token offline
/// against `{base}/auth/v1/.well-known/jwks.json` and matching its `sub`, was
/// left out on purpose rather than forgotten. It cannot run where it would be
/// needed: offline there is no access token to check, because obtaining one
/// means reaching the platform, which is the thing that is not possible. When
/// there *is* a connection the live answer settles entitlement outright and
/// the cache is not consulted at all. It would be a verifier that only runs
/// when its answer does not matter.
pub async fn licence(base: &str, anon_key: &str, access_token: &str) -> Result<LicenceAnswer, PlatformError> {
    let resp = get(base, "desktop-licence", anon_key, access_token).await?;
    // Read off the response before the body consumes it.
    let served_at = resp
        .headers()
        .get(reqwest::header::DATE)
        .and_then(|v| v.to_str().ok())
        .and_then(http_date_to_iso);
    Ok(LicenceAnswer { body: read(resp).await?, served_at })
}

/// A licence answer, and the platform's own idea of what time it is.
#[derive(Debug, Clone, PartialEq)]
pub struct LicenceAnswer {
    pub body: LicenceResponse,
    /// From the response's `Date` header, which every HTTP server sends. The
    /// grace period counts from this rather than from the local clock: a
    /// laptop set forward would otherwise expire its own grace, and one set
    /// back would extend it for as long as it stayed wrong.
    pub served_at: Option<String>,
}

/// What the platform says about which desktop builds may still run.
///
/// Read without a session, unlike everything else in this file, and that is
/// the point rather than an oversight: the answer has to be available *before*
/// the sign-in gate. An outdated build and a sign-in that will not work are
/// the same incident often enough — this feature exists because of one — that
/// the update screen must be reachable by somebody who cannot log in.
///
/// Every field optional, for the reason written out on [`LicenceResponse`]:
/// this is a binary already on somebody's machine, and a response shape it
/// cannot parse must never be able to stop it opening. Both spellings are
/// accepted so the backend can send whichever it already sends elsewhere.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    /// The oldest version still allowed to run. Absent means no floor.
    #[serde(default, alias = "minimum_version")]
    pub minimum_version: Option<String>,
    /// Specific builds withdrawn irrespective of the floor. Separate from it
    /// because "too old" and "this exact build is bad" are different claims,
    /// and a floor cannot say the second without also condemning everything
    /// underneath it.
    #[serde(default, alias = "killed_versions")]
    pub killed_versions: Option<Vec<String>>,
    #[serde(default, alias = "latest_version")]
    pub latest_version: Option<String>,
    #[serde(default, alias = "download_url")]
    pub download_url: Option<String>,
    #[serde(default, alias = "notes_url")]
    pub notes_url: Option<String>,
}

/// Ask the platform which builds may run.
pub async fn desktop_config_of(base: &str, anon_key: &str) -> Result<DesktopConfig, PlatformError> {
    read(get_public(base, "desktop-config", anon_key).await?).await
}

/// Which build is asking, sent on every authenticated call.
///
/// Costs nothing today and is the only hook that makes an old build
/// identifiable later. Versions up to and including 0.2.0 send no version at
/// all — they predate this line — so once every supported build sends one,
/// *absence* becomes the signature of a release too old to have the update
/// gate compiled into it. That is the only lever those installs will ever
/// answer to, because they have no update check of their own to reach.
///
/// Bare semver, no `v`: exactly what `Cargo.toml` and `package.json` carry.
///
/// Sent on the authenticated calls only. `desktop-config` does not need it —
/// no build old enough to matter calls that endpoint at all — and the GoTrue
/// token endpoints are not ours to add headers to.
const APP_VERSION_HEADER: &str = "X-App-Version";

/// A GET with no session behind it.
///
/// The anon key alone, because this endpoint answers the same for everybody
/// and is asked before anybody has signed in.
///
/// Its own client, with a shorter timeout than [`client`]: this call sits in
/// front of the launch, and thirty seconds of a hung network before the app
/// will say anything is indistinguishable from a hung app. Ten is long enough
/// for a slow connection to answer, and short enough that giving up — which
/// here means *carrying on*, since the update check fails open — happens while
/// somebody is still watching the window open.
async fn get_public(base: &str, function: &str, anon_key: &str) -> Result<reqwest::Response, PlatformError> {
    let url = format!("{}/functions/v1/{function}", base.trim_end_matches('/'));
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| PlatformError::Unreachable(e.to_string()))?
        .get(url)
        .header("apikey", anon_key)
        .send()
        .await
        .map_err(|e| PlatformError::Unreachable(e.to_string()))
}

async fn get(
    base: &str,
    function: &str,
    anon_key: &str,
    access_token: &str,
) -> Result<reqwest::Response, PlatformError> {
    let url = format!("{}/functions/v1/{function}", base.trim_end_matches('/'));
    client()?
        .get(url)
        // The gateway reads the bearer and would let this through without an
        // apikey header; it is sent anyway because every other Supabase client
        // sends it and a gateway that starts requiring it should not be a
        // surprise outage.
        .header("apikey", anon_key)
        .header(APP_VERSION_HEADER, env!("CARGO_PKG_VERSION"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| PlatformError::Unreachable(e.to_string()))
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
mod access_tests {
    use super::*;

    /// A token shaped like a real one: header.payload.signature, payload base64url.
    fn token_with_exp(exp: u64) -> String {
        use base64::Engine;
        let payload = serde_json::json!({ "sub": "u1", "exp": exp }).to_string();
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{b64}.signature")
    }

    #[test]
    fn the_expiry_is_read_out_of_the_token_itself() {
        assert_eq!(token_expiry(&token_with_exp(1_800_000_000)), Some(1_800_000_000));
    }

    #[test]
    fn an_unreadable_token_expires_immediately_rather_than_never() {
        // The direction matters. Treating an unparseable token as "no expiry
        // known, assume fine" buys a silent 401 in the middle of somebody's
        // narration run; treating it as expired costs one refresh.
        for bad in ["", "not-a-jwt", "a.b", "a.!!!.c", "a.e30.c"] {
            assert!(token_expiry(bad).is_none(), "{bad} should not yield an expiry");
        }

        remember_access("not-a-jwt");
        assert!(
            access_valid_for(0).is_none(),
            "an unreadable token must not be handed out as valid"
        );
        forget_access();
    }

    #[test]
    fn a_token_inside_the_margin_is_not_good_enough() {
        // A call that starts valid and expires in flight fails for a reason the
        // member cannot act on, so the margin is the whole point of this check.
        remember_access(&token_with_exp(now_unix() + 30));
        assert!(access_valid_for(0).is_some(), "still valid right now");
        assert!(
            access_valid_for(REFRESH_MARGIN_SECS).is_none(),
            "30s left is inside a 60s margin and must be refreshed"
        );

        remember_access(&token_with_exp(now_unix() + 3600));
        assert!(access_valid_for(REFRESH_MARGIN_SECS).is_some(), "an hour is plenty");
        forget_access();
    }

    #[test]
    fn forgetting_the_session_forgets_the_token_with_it() {
        remember_access(&token_with_exp(now_unix() + 3600));
        assert!(current_access().is_some());
        forget_access();
        assert!(current_access().is_none(), "a signed-out session must not keep a token");
        assert!(access_valid_for(0).is_none());
    }
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

    /// Three different services sit behind one hostname and each phrases a
    /// refusal its own way. All three of these were copied from real
    /// responses; a reason that comes out blank is a person staring at
    /// "BuildnLaunchAI refused (401):" and nothing else.
    #[tokio::test]
    async fn every_refusal_shape_the_platform_actually_sends_is_readable() {
        for (body, expected) in [
            // The Supabase gateway, when no bearer is present at all.
            (r#"{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}"#,
             "Missing authorization header"),
            // The gateway again, on a token that is not a JWT.
            (r#"{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT","message":"Invalid JWT"}"#, "Invalid JWT"),
            // The edge function itself, past the gateway.
            (r#"{"error":"not authenticated"}"#, "not authenticated"),
            // GoTrue, which uses `msg` and puts a number in `code`.
            (r#"{"code":404,"error_code":"flow_state_not_found","msg":"invalid flow state, no valid flow state found"}"#,
             "invalid flow state, no valid flow state found"),
        ] {
            let (base, _) = stub("401 Unauthorized", Box::leak(body.to_string().into_boxed_str()));
            match licence(&base, "anon", "at").await {
                Err(PlatformError::Refused { message, .. }) => assert_eq!(message, expected),
                other => panic!("expected a refusal for {body}, got {other:?}"),
            }
        }
    }

    /// Unreachable is not refused. This distinction decides whether somebody
    /// keeps working on a plane or is shown a login wall.
    #[tokio::test]
    async fn every_authenticated_call_says_which_build_is_asking() {
        // The hook the retroactive lever needs. If this ever stops being sent,
        // the backend loses its only way to tell an old desktop from a current
        // one — and it would lose it silently.
        let expected = format!("x-app-version: {}", env!("CARGO_PKG_VERSION"));

        let (base, seen) = stub("200 OK", r#"{"active":true}"#);
        licence(&base, "anon", "at-1").await.expect("licence");
        let req = seen.recv().unwrap().to_lowercase();
        assert!(req.contains(&expected), "the licence call did not say which build it is: {req}");

        let (base, seen) = stub("200 OK", r#"{"openai":{"present":false},"elevenlabs":{"present":false}}"#);
        provider_keys(&base, "anon", "at-1").await.expect("keys");
        let req = seen.recv().unwrap().to_lowercase();
        assert!(req.contains(&expected), "the keys call did not say which build it is: {req}");
    }

    #[tokio::test]
    async fn which_builds_may_run_is_asked_without_a_session() {
        let (base, seen) = stub(
            "200 OK",
            r#"{"minimum_version":"0.3.0","killed_versions":["0.4.1"],
                "latest_version":"0.5.0","download_url":"https://example.com/d",
                "notes_url":"https://example.com/n"}"#,
        );
        let c = desktop_config_of(&base, "anon").await.expect("config");

        assert_eq!(c.minimum_version.as_deref(), Some("0.3.0"));
        assert_eq!(c.killed_versions, Some(vec!["0.4.1".to_string()]));
        assert_eq!(c.latest_version.as_deref(), Some("0.5.0"));
        assert_eq!(c.download_url.as_deref(), Some("https://example.com/d"));

        let req = seen.recv().unwrap();
        assert!(req.contains("GET /functions/v1/desktop-config"), "wrong endpoint: {req}");
        // The whole reason this endpoint is separate from `desktop-licence`:
        // it has to answer somebody who cannot sign in, because the update
        // they are missing may be the thing that fixes signing in.
        assert!(!req.contains("Bearer"), "the update check must not need a session: {req}");
        assert!(req.contains("apikey"), "the anon key is still sent: {req}");
    }

    #[tokio::test]
    async fn a_config_that_says_nothing_constrains_nothing() {
        let (base, _seen) = stub("200 OK", "{}");
        let c = desktop_config_of(&base, "anon").await.expect("config");
        assert_eq!(c, DesktopConfig::default());
    }

    #[tokio::test]
    async fn a_field_this_build_has_never_seen_does_not_cost_it_the_answer() {
        // camelCase on the wire, and something the backend grew later. Neither
        // may take the response down: this binary is already on a machine.
        let (base, _seen) = stub(
            "200 OK",
            r#"{"minimumVersion":"0.3.0","somethingAddedLater":{"a":1}}"#,
        );
        let c = desktop_config_of(&base, "anon").await.expect("config");
        assert_eq!(c.minimum_version.as_deref(), Some("0.3.0"));
        assert_eq!(c.killed_versions, None);
    }

    #[tokio::test]
    async fn a_refusal_from_the_config_endpoint_is_an_error_and_not_a_floor() {
        // The caller turns this into `config: None`, which means no constraint.
        let (base, _seen) = stub("500 Internal Server Error", r#"{"message":"boom"}"#);
        assert!(desktop_config_of(&base, "anon").await.is_err());
    }

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
        assert_eq!(k.mode_of(&k.openai), KeyMode::Byok);
        // Only ever the last four, so nothing longer reaches a screen or a log.
        assert_eq!(k.openai.hint().as_deref(), Some("1234"));

        // A provider the person has not set up is a different answer from a
        // broken one, and the app has to be able to tell them apart.
        assert!(!k.elevenlabs.present);
        assert!(k.elevenlabs.key.is_none());
        assert!(k.elevenlabs.hint().is_none());

        let req = seen.recv().unwrap();
        assert!(req.contains("Bearer at-1"), "the request was not authenticated");
        // The path is the edge function's, not the `/api/desktop/…` the stub
        // era guessed at.
        assert!(req.contains("GET /functions/v1/desktop-keys"), "wrong endpoint: {req}");
    }

    /// The licence endpoint, at the address it really lives at.
    #[tokio::test]
    async fn the_licence_is_asked_for_at_the_platforms_own_address() {
        let (base, seen) = stub(
            "200 OK",
            r#"{"active":true,"status":"active","plan":"pro","licence_token":"a.b.c"}"#,
        );
        let a = licence(&base, "anon-key", "at-1").await.expect("licence");

        assert!(a.body.entitled());
        assert_eq!(a.body.plan.as_deref(), Some("pro"));
        assert_eq!(a.body.licence_token.as_deref(), Some("a.b.c"));

        let req = seen.recv().unwrap();
        assert!(req.contains("GET /functions/v1/desktop-licence"), "wrong endpoint: {req}");
        assert!(req.contains("Bearer at-1"), "the request was not authenticated");
        assert!(req.contains("apikey: anon-key"), "the project key was not sent: {req}");
    }

    /// The exact spelling of the token field is the platform's to pick, and
    /// getting it wrong here would not fail — it would quietly leave the
    /// signature unchecked, which is the worst way for this to be wrong.
    #[test]
    fn the_licence_token_is_found_under_either_spelling() {
        for body in [
            r#"{"licence_token":"a.b.c"}"#,
            r#"{"license_token":"a.b.c"}"#,
            r#"{"licenceToken":"a.b.c"}"#,
            r#"{"licenseToken":"a.b.c"}"#,
        ] {
            let r: LicenceResponse = serde_json::from_str(body).expect("parses");
            assert_eq!(r.licence_token.as_deref(), Some("a.b.c"), "missed it in {body}");
        }
    }

    /// A response carrying fields this build has never seen must still parse:
    /// the alternative is a backend deploy locking every desktop out.
    #[test]
    fn an_unfamiliar_licence_response_still_parses_rather_than_locking_anyone_out() {
        let r: LicenceResponse =
            serde_json::from_str(r#"{"status":"trialing","seats":4,"renewsAt":"2026-09-01"}"#)
                .expect("parses");
        assert!(r.entitled(), "a trial is a live entitlement");
        assert!(r.licence_token.is_none());

        // And an empty body is read as "not entitled" rather than as an error,
        // because a licence that says nothing grants nothing.
        let r: LicenceResponse = serde_json::from_str("{}").expect("parses");
        assert!(!r.entitled());
    }

    // ── what a launch does to the file on disk ─────────────────────────────

    /// A suspension is *kept* now, and that is the change.
    ///
    /// The cache is the signed token, so for as long as the claims could not
    /// say why an account was refused, keeping a suspended account's token
    /// would have meant keeping one that read "active" — a month of exactly
    /// the access being withdrawn. It was deleted instead, and the price was
    /// that the next offline launch said "connect once" to somebody who
    /// deserved to be told they were suspended. The reason is signed now, the
    /// token agrees with the answer, and it stays.
    #[test]
    fn a_signed_refusal_is_written_down_so_it_can_be_read_offline() {
        // Suspended: the token says no, the answer is no, they agree.
        assert_eq!(cache_action(Some(false), false), CacheAction::Store);
        // And an ordinary yes, which is the case that was never in doubt.
        assert_eq!(cache_action(Some(true), true), CacheAction::Store);
    }

    /// The check that survived from the old behaviour, and the reason it did.
    #[test]
    fn a_token_that_contradicts_its_own_answer_is_never_written_down() {
        // The response says suspended; the token beside it still says active.
        // Writing that down would cache a month of access to an account that
        // has just been barred.
        assert_eq!(cache_action(Some(true), false), CacheAction::Forget);
        // The mirror image, which should be impossible and is handled anyway:
        // a token that says no beside an answer that says yes is not evidence
        // of the yes, so there is nothing here worth keeping.
        assert_eq!(cache_action(Some(false), true), CacheAction::Leave);
    }

    /// Nothing signed to write: a build with no key, a backend that sent no
    /// token, or a token about somebody else entirely.
    #[test]
    fn an_unverifiable_no_clears_the_cache_and_an_unverifiable_yes_leaves_it() {
        // A refusal this build could not verify still reached the platform,
        // so deleting a stale yes cannot lock out anybody who is not already
        // locked out.
        assert_eq!(cache_action(None, false), CacheAction::Forget);
        // But an unverifiable *yes* must not destroy the one record standing
        // between a paying customer and `offline-first-run`. This is the arm
        // that keeps a backend dropping a field from locking out everybody
        // who has been offline since.
        assert_eq!(cache_action(None, true), CacheAction::Leave);
    }

    /// The four reasons the platform sends, read out of the field it sends
    /// them in. Mirrors `denialFor` in `src/lib/entitlement.ts` — the two
    /// decide the same screen from the same word, and a difference between
    /// them is a suspended account being shown a billing page.
    #[test]
    fn each_reason_is_read_as_itself() {
        use crate::licence::Denial;
        for (body, expected) in [
            (r#"{"active":false,"reason":"suspended"}"#, Denial::Suspended),
            (r#"{"active":false,"reason":"no_membership"}"#, Denial::NoMembership),
            (
                r#"{"active":false,"reason":"membership_inactive","expires_at":"2026-07-01T00:00:00Z"}"#,
                Denial::MembershipInactive,
            ),
            (r#"{"active":false,"reason":"no_access"}"#, Denial::NoAccess),
        ] {
            let r: LicenceResponse = serde_json::from_str(body).expect("parses");
            assert_eq!(r.denial(), Some(expected), "the reason went unread in {body}");
            assert!(!r.entitled(), "a denial left the account entitled: {body}");
        }

        // The date rides along for the one screen that has a date to show,
        // under either spelling — the platform sends `expires_at`, and this
        // struct is otherwise camelCase, so both are accepted.
        let r: LicenceResponse =
            serde_json::from_str(r#"{"reason":"membership_inactive","expires_at":"2026-07-01T00:00:00Z"}"#)
                .expect("parses");
        assert_eq!(r.expires_at.as_deref(), Some("2026-07-01T00:00:00Z"));
        let r: LicenceResponse =
            serde_json::from_str(r#"{"reason":"membership_inactive","expiresAt":"2026-07-01T00:00:00Z"}"#)
                .expect("parses");
        assert_eq!(r.expires_at.as_deref(), Some("2026-07-01T00:00:00Z"));
    }

    /// A denial outranks an entitlement sitting beside it in the same body.
    ///
    /// The two should never disagree. If a backend ever bars an account
    /// without clearing its subscription flag, the restrictive reading is the
    /// one that is right about the account.
    #[test]
    fn a_denial_beats_an_active_flag_in_the_same_response() {
        for body in [
            r#"{"active":true,"status":"active","reason":"suspended"}"#,
            r#"{"active":true,"reason":"no_access"}"#,
        ] {
            let r: LicenceResponse = serde_json::from_str(body).expect("parses");
            assert!(!r.entitled(), "a denial was overruled by the flag beside it: {body}");
        }
    }

    /// And nothing else is a denial.
    ///
    /// The loose, case-insensitive search over two fields that used to live
    /// here was a hedge against not knowing the field or the spelling. Both
    /// are known now, so every string below has to come back as "no opinion" —
    /// including the ones the old search caught. An `active: false` with no
    /// reason is still a refusal; it is just the generic one, which is the
    /// right screen for a platform that did not say why.
    #[test]
    fn nothing_off_the_list_is_read_as_a_denial() {
        for body in [
            r#"{"active":false}"#,
            r#"{"active":false,"status":"canceled"}"#,
            r#"{"active":false,"status":"past_due"}"#,
            r#"{"active":false,"status":"suspended"}"#,
            r#"{"active":false,"reason":"Suspended"}"#,
            r#"{"active":false,"reason":"account_suspended"}"#,
            r#"{"active":false,"reason":"no_subscription"}"#,
            r#"{"active":false,"suspension_reason":"suspended"}"#,
            r#"{"active":true,"status":"active"}"#,
            r#"{}"#,
        ] {
            let r: LicenceResponse = serde_json::from_str(body).expect("parses");
            assert_eq!(r.denial(), None, "an ordinary answer was read as a denial: {body}");
        }

        // The reading of the *entitlement* is untouched by any of that: a
        // word off the list neither grants nor withdraws anything.
        let r: LicenceResponse =
            serde_json::from_str(r#"{"active":true,"reason":"grace_period"}"#).expect("parses");
        assert_eq!(r.denial(), None);
        assert!(r.entitled(), "an unknown reason locked out a paying account");
    }

    /// Credit mode, in the hub's own spelling and in its real shape.
    ///
    /// The JSON here is copied from `desktop-keys`, not imagined: in credit
    /// mode every slot comes back WITHHELD, because the member is entitled to
    /// run and not to a key — we spend ours. So this test also pins that credit
    /// mode is not a failure to read a key; it is a different answer.
    #[test]
    fn credit_mode_is_read_in_the_hub_s_own_word() {
        let k: ProviderKeys = serde_json::from_str(
            r#"{"mode":"credit",
                "openai":{"present":false,"reason":"credit_mode","consent_url":"https://x/credits"},
                "elevenlabs":{"present":false,"reason":"credit_mode","consent_url":"https://x/credits"}}"#,
        )
        .expect("the hub's own credit-mode response must parse");

        assert_eq!(k.mode, KeyMode::Credit);
        assert_eq!(k.mode_of(&k.openai), KeyMode::Credit, "the top-level mode did not reach the slot");
        assert!(!k.openai.present, "credit mode releases no key");

        // A slot that disagrees wins for that slot only.
        let k: ProviderKeys = serde_json::from_str(
            r#"{"mode":"credit","openai":{"present":true,"key":"x","mode":"byok"}}"#,
        )
        .expect("parses");
        assert_eq!(k.mode_of(&k.openai), KeyMode::Byok);
        assert_eq!(k.mode_of(&k.elevenlabs), KeyMode::Credit, "one slot's override leaked");

        // And a response that omits it entirely still means the user's own key.
        let k: ProviderKeys =
            serde_json::from_str(r#"{"openai":{"present":true,"key":"x"}}"#).expect("parses");
        assert_eq!(k.mode_of(&k.openai), KeyMode::Byok);
    }

    /// The bug this type actually had: an unknown mode was FATAL.
    ///
    /// `"platform"` is in here on purpose — it is the word this build used to
    /// expect, and it must now be treated like any other word the hub does not
    /// send. If a future rename ever makes this test pass for the wrong reason,
    /// the third case (`"mode":"quantum"`) still fails it.
    #[test]
    fn an_unknown_mode_does_not_destroy_the_whole_response() {
        for raw in [r#""platform""#, r#""quantum""#, r#""""#] {
            let json = format!(
                r#"{{"mode":{raw},"openai":{{"present":true,"key":"x"}}}}"#
            );
            let k: ProviderKeys = serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("mode {raw} must not fail the parse: {e}"));

            assert_eq!(k.mode, KeyMode::Unknown, "mode {raw}");
            // The key is still there and still readable. An unknown MODE must
            // not cost the member the slot they were actually sent.
            assert!(k.openai.present, "mode {raw} lost the slot");
            assert_eq!(k.openai.key.as_deref(), Some("x"), "mode {raw} lost the key");
        }
    }
}

// ── where the platform lives ────────────────────────────────────────────────

/// The production project. Overridable at runtime; see [`config`].
const DEFAULT_BASE: &str = "https://pezsxoynjjsipfnpfvva.supabase.co";

/// The project's **publishable** key.
///
/// This is not a secret and treating it as one would be a costume rather than
/// a control. Supabase serves it in every web page of the platform, and it is
/// readable with `strings` on any downloaded binary no matter how it gets in
/// there — so injecting it at build time would hide it from the repository and
/// from nobody else, at the price of a build that silently ships unable to
/// sign anybody in. Row-level security behind it is what protects the data.
///
/// The `service_role` key is the opposite of this in every respect and must
/// never come near this process. `scripts/preflight.sh` greps for it.
///
/// preflight-allow: publishable-anon-key
const DEFAULT_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlenN4b3luampzaXBmbnBmdnZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NjczMDksImV4cCI6MjA5OTU0MzMwOX0.rxBUNnceRXQNsWWh7ATS1QRIrG318UYHnakNu7iqNrI";

/// Which identity provider `/auth/v1/authorize` should hand off to.
///
/// GoTrue has no provider-less authorize endpoint — asking for one answers
/// `Unsupported provider: Provider  could not be found` — so this is required,
/// not decorative. Google is the only external provider enabled on the project
/// today, and it is what the manual end-to-end run went through.
///
/// A name rather than a hardcode so that enabling a second provider is an
/// environment variable and not a release.
const DEFAULT_PROVIDER: &str = "google";

/// Everything needed to talk to the platform. None of it is a secret.
pub struct PlatformConfig {
    pub base: String,
    /// See [`DEFAULT_ANON_KEY`].
    pub anon_key: String,
    pub provider: String,
}

/// Where the platform lives, for this run.
///
/// Compiled-in defaults, overridden by the environment. The original design
/// here was environment-only, on the principle that nothing about a deployment
/// belongs in an artifact people download — but a downloaded artifact has no
/// environment to read, so that principle produced a binary that could only
/// ever report "not configured" to the person who downloaded it. The values
/// are published anyway. What the environment is still good for is pointing a
/// build at staging without recompiling, which it still does.
///
/// `None` remains reachable: blank the constants, or set either variable to an
/// empty string, and the commands report an unconfigured build rather than
/// firing requests at an empty URL.
pub fn config() -> Option<PlatformConfig> {
    resolve(
        std::env::var("BUILDNLAUNCH_AUTH_URL").ok(),
        std::env::var("BUILDNLAUNCH_ANON_KEY").ok(),
        std::env::var("BUILDNLAUNCH_AUTH_PROVIDER").ok(),
    )
}

/// The resolution rule, apart from the environment so it can be tested without
/// mutating process-wide state that other tests are reading in parallel.
fn resolve(base: Option<String>, anon_key: Option<String>, provider: Option<String>) -> Option<PlatformConfig> {
    // An empty override is a deliberate "off", not an absent one. Anything
    // else and `BUILDNLAUNCH_AUTH_URL=` in a shell would silently mean
    // production.
    fn pick(given: Option<String>, fallback: &str) -> String {
        match given {
            Some(v) => v.trim().to_string(),
            None => fallback.to_string(),
        }
    }
    let base = pick(base, DEFAULT_BASE);
    let anon_key = pick(anon_key, DEFAULT_ANON_KEY);
    let provider = pick(provider, DEFAULT_PROVIDER);
    (!base.is_empty() && !anon_key.is_empty() && !provider.is_empty())
        .then_some(PlatformConfig { base, anon_key, provider })
}

/// The access token this session is using, in memory and nowhere else.
///
/// Refresh tokens rotate — spending one retires it — so a second half of the
/// app that wants an authenticated call must not go and spend another. The
/// licence check already obtains an access token on launch; this is where it
/// leaves it so the provider-key fetch can use the same one.
///
/// Deliberately not written to disk, for the reason [`crate::session`] gives:
/// it lives about an hour and is derivable from the refresh token, so putting
/// it at rest would be a second credential for no benefit.
///
/// THE EXPIRY IS STORED WITH IT, and that is new. It did not matter while this
/// token was spent once at launch to fetch a key that then lived in memory. In
/// credit mode it is spent on EVERY provider call, and a narration run is one
/// call per line for as long as the script takes — so "still valid?" became a
/// question asked hundreds of times, and a bare String cannot answer it.
struct Access {
    token: String,
    /// Unix seconds, read from the token's own `exp`. Zero when unreadable,
    /// which reads as "already expired" and costs one refresh rather than one
    /// silent 401 in the middle of somebody's script.
    expires_at: u64,
}

static ACCESS: std::sync::RwLock<Option<Access>> = std::sync::RwLock::new(None);

/// Serialises refreshing, and ONLY refreshing.
///
/// THE REASON THIS EXISTS IS WORTH SPELLING OUT. Refresh tokens rotate: spending
/// one retires it and yields the next. Two calls that refresh concurrently
/// therefore spend two tokens, and the loser's rotation invalidates the
/// winner's — the session dies, mid-run, for a user who did nothing wrong.
/// Narration calls one line at a time, so this should never contend; "should
/// never" is exactly the kind of claim that a hundred sequential calls and one
/// unlucky overlap turn into a support ticket.
static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Refresh this long before the token actually dies.
///
/// A call that starts valid and expires in flight fails for a reason the member
/// cannot act on. Sixty seconds is longer than any single gateway call.
const REFRESH_MARGIN_SECS: u64 = 60;

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The `exp` claim, read WITHOUT verifying the signature.
///
/// Deliberately unverified, and that is not a shortcut: this value is only ever
/// used to decide when to refresh EARLY. The server remains the only thing that
/// decides whether a token is accepted, so a forged `exp` buys an attacker one
/// pointless refresh of their own session. Verifying here would mean shipping a
/// key to check a hint with.
fn token_expiry(token: &str) -> Option<u64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    claims.get("exp")?.as_u64()
}

pub(crate) fn remember_access(token: &str) {
    if let Ok(mut slot) = ACCESS.write() {
        *slot = Some(Access {
            token: token.to_string(),
            expires_at: token_expiry(token).unwrap_or(0),
        });
    }
}

pub(crate) fn current_access() -> Option<String> {
    ACCESS.read().ok().and_then(|s| s.as_ref().map(|a| a.token.clone()))
}

/// The token if it will still be good in `margin` seconds, else nothing.
fn access_valid_for(margin: u64) -> Option<String> {
    let slot = ACCESS.read().ok()?;
    let a = slot.as_ref()?;
    (a.expires_at > now_unix() + margin).then(|| a.token.clone())
}

/// An access token that will still be valid when the call lands.
///
/// What every gateway call goes through, so no call site carries refresh logic
/// and no two of them can disagree about when to spend a rotation.
///
/// The double check around the lock is the whole point, not defensiveness: the
/// first one keeps the common case lock-free, and the second means that when
/// several calls do arrive together, ONE refreshes and the rest take its result.
/// Without it the mutex would serialise the damage instead of preventing it —
/// each waiter would wake up and spend its own refresh token in turn.
pub(crate) async fn fresh_access() -> Result<String, PlatformError> {
    if let Some(t) = access_valid_for(REFRESH_MARGIN_SECS) {
        return Ok(t);
    }

    let _guard = REFRESHING.lock().await;

    // Somebody refreshed while we waited. Their token is this token.
    if let Some(t) = access_valid_for(REFRESH_MARGIN_SECS) {
        return Ok(t);
    }

    let cfg = config().ok_or_else(|| PlatformError::Unreachable("not configured".into()))?;
    let stored = crate::session::load()
        .ok_or_else(|| PlatformError::Refused { status: 401, message: "signed out".into() })?;

    let tokens = refresh(&cfg.base, &cfg.anon_key, &stored.refresh_token).await?;

    // Written down BEFORE it is used, for the reason session::replace gives: a
    // rotated token spent but never saved signs somebody out permanently.
    crate::session::replace(&stored, &tokens.refresh_token, &now_iso())
        .map_err(|e| PlatformError::Malformed(e.to_string()))?;
    remember_access(&tokens.access_token);

    Ok(tokens.access_token)
}

/// Drop the token, and whatever was fetched with it.
///
/// Called wherever the session ends. Leaving one account's access token — and
/// the provider keys it bought — in memory for the next person to sign in is
/// the desktop version of not logging out.
pub(crate) fn forget_access() {
    if let Ok(mut slot) = ACCESS.write() {
        *slot = None;
    }
    crate::provider_keys::forget();
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

/// Where the browser is sent to start a login.
///
/// `provider` is required by GoTrue and there is no hosted login page in front
/// of it: the browser goes from here straight to the identity provider, which
/// is the "no web login page" half of the design. `response_type` is *not*
/// sent — GoTrue does not read it, and a parameter that looks meaningful and
/// is ignored is worse than one that is absent.
///
/// Sending `code_challenge` is what makes this a PKCE flow. There is no
/// separate `flow_type` switch on the wire; the challenge is the switch, and
/// its presence is why the callback arrives as `?code=` for
/// `grant_type=pkce` rather than as a token in a fragment.
fn authorize_url(cfg: &PlatformConfig, challenge: &str, redirect_uri: &str) -> String {
    format!(
        "{}/auth/v1/authorize?provider={}&code_challenge={}&code_challenge_method=S256&redirect_to={}",
        cfg.base.trim_end_matches('/'),
        urlencode(&cfg.provider),
        urlencode(challenge),
        urlencode(redirect_uri),
    )
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

    tauri_plugin_opener::open_url(&authorize_url(&cfg, &pkce.challenge, &pending.redirect_uri()), None::<&str>)
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

    // A fresh session starts with nothing carried over from the last one.
    forget_access();
    remember_access(&tokens.access_token);

    let _ = app;
    Ok(SignedIn { email: tokens.user.email, user_id: tokens.user.id })
}

/// What this build is, and what the platform says about builds like it.
///
/// **Never fails.** Every way of not getting an answer — no platform
/// configured, no network, a response this build cannot read — arrives as
/// `config: None`, which `updateGate.ts` treats as no constraint at all.
///
/// A version gate that could fail closed would turn one bad deploy, or one
/// typo in one JSON field, into every installed copy of the application
/// refusing to open, with the fix on the far side of the wall it had just
/// built. There is no remote way back from that: the mechanism that would
/// deliver the repair is the mechanism that stopped working.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopVersionState {
    /// Out of the binary itself rather than anything shipped beside it, so it
    /// cannot disagree with the code it is describing.
    pub installed: String,
    pub config: Option<DesktopConfig>,
}

#[tauri::command]
pub async fn desktop_version_state() -> DesktopVersionState {
    let installed = env!("CARGO_PKG_VERSION").to_string();
    let config = match config() {
        Some(cfg) => desktop_config_of(&cfg.base, &cfg.anon_key).await.ok(),
        None => None,
    };
    DesktopVersionState { installed, config }
}

/// Where this app keeps its own files. `None` on a platform that will not say,
/// which the callers treat as "no cache", never as an error: an offline grace
/// that cannot be written is a worse day later, not a failure now.
fn app_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok()
}

/// Forget the session on this machine.
///
/// And the cached licence with it. The cross-check in `licence_cache::recall`
/// would refuse it for the next person to sign in anyway, but leaving one
/// account's entitlement on disk after they asked to be signed out is not the
/// behaviour the words "sign out" describe.
#[tauri::command]
pub fn auth_sign_out(app: tauri::AppHandle) -> Result<(), GateError> {
    if let Some(dir) = app_dir(&app) {
        crate::licence_cache::forget(&dir);
    }
    forget_access();
    crate::session::clear().map_err(|e| GateError { code: "STORE".into(), message: e.to_string() })
}

/// What the last successful check found, for a launch that cannot make a new
/// one. Shaped to `CachedLicence` in `entitlement.ts`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalledLicence {
    pub active: bool,
    pub checked_at: String,
    /// The same word a live check would have sent, out of the signed claims.
    /// This is what makes a suspension survive going offline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// What this machine last knew, without touching the network.
///
/// Called on launch beside [`auth_current`], and before [`auth_licence`] is
/// given its chance to fail: the whole point of a cache is to already be in
/// place when the live check comes back with nothing.
///
/// A cache that does not survive [`crate::licence_cache::recall`] is deleted
/// rather than kept. It would fail the same way on every future launch, and a
/// file that is only ever going to be rejected is better gone than lingering
/// for somebody to find and wonder about.
#[tauri::command]
pub fn auth_cached_licence(app: tauri::AppHandle) -> Option<RecalledLicence> {
    let stored = crate::session::load()?;
    let dir = app_dir(&app)?;
    let cached = crate::licence_cache::load(&dir)?;
    match crate::licence_cache::recall(&cached, &stored.user_id, crate::licence::EMBEDDED_PUBLIC_KEY) {
        Some(r) => Some(RecalledLicence {
            active: r.active,
            checked_at: r.checked_at,
            reason: r.reason,
            expires_at: r.expires_at,
        }),
        None => {
            crate::licence_cache::forget(&dir);
            None
        }
    }
}

/// Who, if anyone, is signed in — without touching the network.
#[tauri::command]
pub fn auth_current() -> Option<SignedIn> {
    crate::session::load().map(|s| SignedIn { email: s.email, user_id: s.user_id })
}

/// The answer the gate is waiting for.
///
/// `checkedAt` is what the month-long grace period counts from, so it comes
/// from the platform's `Date` header rather than this machine's clock — a
/// laptop with the date set forward would otherwise expire its own grace, and
/// one set back would extend it indefinitely.
///
/// `verified` says whether the signature on `licence_token` was checked, not
/// whether it passed: a build with no key compiled in reports `false` here and
/// that is the honest answer. Nothing may be cached to disk on a `false`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenceState {
    pub active: bool,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// The platform's word for why not, exactly as it sent it. Parsed by
    /// `denialFor` in `entitlement.ts`, which picks the screen from it.
    ///
    /// Passed through rather than narrowed to the four known values, so that a
    /// word this build has never seen is still visible to anyone reading a log
    /// — it decides nothing on either side of the boundary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// When the membership ended, for the one screen that says so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub verified: bool,
}

/// What a live answer means for the licence file on disk.
#[derive(Debug, Clone, Copy, PartialEq)]
enum CacheAction {
    /// Write the signed token down.
    Store,
    /// Throw away whatever is there.
    Forget,
    /// Leave it exactly as it is.
    Leave,
}

/// Decide what this launch does to the cache.
///
/// `signed` is what the licence token says about **this** account: `None`
/// where there was nothing signed, nothing checkable — no key compiled into
/// this build — or nothing about this account to check. `active` is the answer
/// the gate is about to be given, which is the token's verdict *and* the
/// response's reason together.
///
/// It is deliberately not symmetrical, and each asymmetry is a bug somebody
/// would otherwise hit:
///
/// **A signed answer is written down whichever way it went.** Caching a "no"
/// matters as much as caching a "yes": without it, somebody who was refused
/// could close the lid, go offline, and have the refusal quietly become a
/// month of grace.
///
/// **A signed statement that contradicts the answer beside it is never
/// written down.** This used to be every suspension — the claims could not
/// express one, so a suspended account's token still read "active", and
/// caching it would have handed back a month of exactly the access the
/// suspension exists to withdraw. The claims carry `reason` now, so the
/// ordinary case is that the token says "suspended" too, agrees, and is kept,
/// which is what lets the offline screen be the right one. The check stays for
/// the case it was really about.
///
/// **An unverifiable "no" deletes the cache; an unverifiable "yes" leaves it
/// alone.** The two directions are not the same risk. This request reached the
/// platform, so a refused person is blocked at this moment regardless of
/// what is on disk, and deleting a stale "yes" cannot lock out anybody who is
/// not already locked out. But destroying the one record standing between a
/// paying customer and `offline-first-run` — because a backend stopped sending
/// a field, or because this build has no key yet — is the failure
/// `entitlement.ts` is organised around avoiding.
fn cache_action(signed: Option<bool>, active: bool) -> CacheAction {
    match signed {
        Some(s) if s == active => CacheAction::Store,
        _ if !active => CacheAction::Forget,
        _ => CacheAction::Leave,
    }
}

/// Ask the platform whether this account is entitled, right now.
///
/// The sequence matters and is not rearrangeable:
///
/// 1. Read the stored session. No session is not an error — it is the
///    signed-out state, and the gate already renders it.
/// 2. Spend the refresh token for an access token.
/// 3. **Write the rotated refresh token down before using anything.** A crash
///    between the server retiring the old token and this process saving the
///    new one signs somebody out permanently, so a failed write stops here
///    rather than being logged and stepped over. See `session::replace`.
/// 4. Ask about the licence.
///
/// A refusal at step 2 is the one case that clears the session: the platform
/// has said this refresh token is dead, and keeping it would mean retrying it
/// on every launch forever. A refusal at step 4 is *not* — the account is real
/// and merely unentitled, which the gate has its own screen for.
#[tauri::command]
pub async fn auth_licence(app: tauri::AppHandle) -> Result<Option<LicenceState>, GateError> {
    let cfg = config().ok_or_else(GateError::not_configured)?;
    let Some(stored) = crate::session::load() else { return Ok(None) };

    let tokens = match refresh(&cfg.base, &cfg.anon_key, &stored.refresh_token).await {
        Ok(t) => t,
        Err(e) if e.is_unauthorised() => {
            // Dead beyond retrying. Forgetting it is what turns a confusing
            // permanent failure into an ordinary "please sign in again".
            let _ = crate::session::clear();
            forget_access();
            // And the licence with it, for the same reason `auth_sign_out`
            // does: this is a sign-out, arrived at from the other direction.
            // `recall` would refuse the file once the session it names is
            // gone, so this changes no decision — it just declines to leave
            // one account's entitlement lying about after the session that
            // earned it has been thrown away.
            if let Some(dir) = app_dir(&app) {
                crate::licence_cache::forget(&dir);
            }
            return Err(GateError::from(e));
        }
        Err(e) => return Err(GateError::from(e)),
    };
    crate::session::replace(&stored, &tokens.refresh_token, &now_iso())
        .map_err(|e| GateError { code: "STORE".into(), message: e.to_string() })?;

    // Kept for the provider-key fetch, which would otherwise have to spend a
    // second refresh token to ask a question this one can already answer.
    remember_access(&tokens.access_token);

    let answer = licence(&cfg.base, &cfg.anon_key, &tokens.access_token).await.map_err(GateError::from)?;
    let body = answer.body;

    // The signed token wins over the plain fields where both are present and
    // the signature was actually checked. Where it is not checkable — no key
    // compiled in yet — the live answer over TLS stands on its own, and
    // `verified: false` travels with it so nothing downstream mistakes it for
    // something worth writing to disk.
    //
    // The key is in the binary and `sub` was confirmed against a real account
    // to be the auth user id, so `matches` is comparing the right two things.
    // What is still unproven is the *yes* answer: every live response seen so
    // far has been `active: false`, so no build has yet watched `entitled()`
    // read whatever word an entitled account produces. If the platform says
    // "paid" or "subscribed" rather than `active: true`, `trialing` or
    // "active", this returns a refusal to somebody who has paid — check it
    // with `--licence-probe` against an entitled account before the gate is
    // turned on for anyone.
    // `signed` is what the token on its own says, kept apart from `active`
    // because the cache below turns on whether the two agree. `None` means
    // there was nothing signed to ask.
    let user_id = if stored.user_id.is_empty() { tokens.user.id.clone() } else { stored.user_id.clone() };
    let (active, verified, signed) = match body.licence_token.as_deref().map(crate::licence::verify) {
        // A good licence and nothing to hold it against. `matches` would say
        // false — correctly, since an empty id matches nobody — and falling
        // through to the arm below would refuse a paying customer over a
        // missing field rather than a missing entitlement. The honest answer
        // is that this build could not check, so the plain fields stand and
        // `verified: false` travels with them: an entitlement that could not
        // be bound to an account is exactly what must never reach the disk.
        Some(Ok(_)) if user_id.is_empty() => (body.entitled(), false, None),
        Some(Ok(v)) if v.matches(&user_id) => (v.entitled(), true, Some(v.entitled())),
        // Signed, valid, and about somebody else. Not a licence for this
        // account, not something to fall back to the plain fields over, and
        // `None` rather than `Some(false)` because it is not a signed
        // statement about this account at all — which keeps it out of this
        // account's cache file instead of being written there to be refused
        // by `recall` on every launch until something deletes it.
        Some(Ok(_)) => (false, true, None),
        Some(Err(crate::licence::LicenceError::NoKey)) | None => (body.entitled(), false, None),
        Some(Err(e)) => return Err(GateError { code: "LICENCE".into(), message: e.to_string() }),
    };

    // A denial is a refusal even where something else in the same response
    // says otherwise. The two should never disagree; if a backend ever bars an
    // account without clearing its subscription flag, the restrictive reading
    // is the one that is right about the account, and taking it here keeps the
    // contradiction out of the offline cache below.
    let active = active && body.denial().is_none();

    let checked_at = answer.served_at.unwrap_or_else(now_iso);

    // What survives this launch — see [`cache_action`], which is the whole
    // decision and is tested on its own.
    if let Some(dir) = app_dir(&app) {
        match (cache_action(signed, active), body.licence_token.as_deref()) {
            (CacheAction::Store, Some(token)) => {
                let record = crate::licence_cache::Cached {
                    licence_token: token.to_string(),
                    checked_at: checked_at.clone(),
                };
                if let Err(e) = crate::licence_cache::store(&dir, &record) {
                    // Not returned: the check itself succeeded, and failing
                    // this only costs an offline grace the person may never
                    // need. Loud on stderr so it is not silent either.
                    eprintln!("the licence could not be cached for offline use: {e}");
                }
            }
            (CacheAction::Forget, _) => crate::licence_cache::forget(&dir),
            // `Store` with no token cannot happen — `signed` is only `Some`
            // when a token was verified — and `Leave` is the deliberate
            // do-nothing.
            _ => {}
        }
    }

    Ok(Some(LicenceState {
        active,
        checked_at,
        status: body.status,
        reason: body.reason,
        expires_at: body.expires_at,
        plan: body.plan,
        verified,
    }))
}

/// Now, as ISO-8601 UTC.
///
/// A real timestamp rather than the `@1755…` this used to produce: the grace
/// period is computed in the frontend with `Date.parse`, which reads that as
/// `NaN`, and a `NaN` age is infinitely old — which is to say every cached
/// licence would have gone straight to read-only.
pub(crate) fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_epoch(secs)
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Hinnant's civil-from-days, which is exact for every date in range and is
/// twenty lines against a calendar crate's dependency tree.
pub(crate) fn iso_from_epoch(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Shift the epoch to 0000-03-01 so leap days land at the end of the cycle.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// An RFC 7231 `Date` header — `Mon, 17 Aug 2026 21:04:25 GMT` — as ISO-8601.
///
/// Reformatted rather than passed through because the frontend parses this
/// with `Date.parse`, and while that happens to accept both, the cache is
/// compared and stored as one shape everywhere else.
fn http_date_to_iso(header: &str) -> Option<String> {
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = header.split_whitespace();
    let _weekday = parts.next()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let month_name = parts.next()?;
    let month = MONTHS.iter().position(|m| *m == month_name)? + 1;
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':');
    let (h, mi, s) = (hms.next()?, hms.next()?, hms.next()?);
    Some(format!("{year:04}-{month:02}-{day:02}T{h}:{mi}:{s}Z"))
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
mod live_tests {
    //! Against the real platform, over the real network.
    //!
    //! Ignored by default so an offline machine and a CI runner without egress
    //! both stay green, and run by hand when the wiring changes:
    //!
    //! ```text
    //! cargo test --lib live_tests -- --ignored --nocapture
    //! ```
    //!
    //! Nothing here signs anybody in, spends anything, or writes anything.
    //! Every request is one this code makes in production, with a credential
    //! that is either absent or deliberately worthless — which is enough to
    //! prove the addresses are right, because a wrong address answers 404 and
    //! these answer 401.
    use super::*;

    /// The one that would have failed in a beta.
    ///
    /// The stub-era URL was `{base}/authorize` with no provider. The real one
    /// is `/auth/v1/authorize?provider=…`, and getting either wrong is a
    /// browser opening on an error page after somebody clicked "Sign in".
    #[tokio::test]
    #[ignore = "hits the real platform"]
    async fn the_authorize_url_really_does_send_the_browser_to_the_provider() {
        let cfg = config().expect("configured");
        let url = authorize_url(&cfg, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "http://127.0.0.1:49152/callback?state=t");

        // No redirect following: the redirect *is* the thing being checked.
        let resp = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client")
            .get(&url)
            .send()
            .await
            .expect("reachable");

        assert_eq!(resp.status(), 302, "the platform did not hand off to a provider: {url}");
        let location = resp.headers()[reqwest::header::LOCATION].to_str().expect("a location").to_string();
        assert!(location.starts_with("https://"), "not sent to a provider: {location}");
        // And it carries our loopback address through, which is what makes the
        // callback come back here rather than to the site's home page.
        assert!(
            location.contains("127.0.0.1%3A49152%2Fcallback"),
            "the redirect was dropped, so the allow-list did not accept it: {location}"
        );
        println!("→ {url}\n← 302 {location}");
    }

    /// An unauthenticated licence request is refused, and says so in words.
    ///
    /// Two things at once: the endpoint is where this code thinks it is — a
    /// wrong path answers 404, not 401 — and the reason survives the trip into
    /// `PlatformError`, so the gate has something to show a person.
    #[tokio::test]
    #[ignore = "hits the real platform"]
    async fn the_licence_endpoint_refuses_an_unauthenticated_request() {
        let cfg = config().expect("configured");
        for token in ["", "not-a-jwt"] {
            match licence(&cfg.base, &cfg.anon_key, token).await {
                Err(PlatformError::Refused { status, message }) => {
                    assert_eq!(status, 401, "expected a refusal, got {status}: {message}");
                    assert!(!message.is_empty(), "refused with no reason to show anyone");
                    println!("token {token:?} → 401 {message}");
                }
                other => panic!("expected a 401, got {other:?}"),
            }
        }
    }

    /// The confirmed shape, against the real endpoint, with a real session.
    ///
    /// The one thing no stub can check: that the platform actually sends what
    /// it says it sends. Everything else about `consent_url` is verified
    /// against a hand-written copy of the contract, which proves the parser
    /// matches the document and nothing about whether the document matches the
    /// server.
    ///
    /// Prints the shape rather than asserting a particular account's contents —
    /// whether this tester happens to have an OpenAI key linked is a fact about
    /// them, not about the API. What it *does* assert is the contract: every
    /// slot carries exactly one absolute link, and it is the one its `present`
    /// state calls for.
    ///
    /// **Never prints key material.** Presence, the last four characters, the
    /// reason and the link — the link is a public URL and the rest is what the
    /// UI already shows.
    ///
    /// Spends a refresh token, which rotates it and writes the replacement back
    /// exactly as a launch does. That is routine — `auth_licence` does it every
    /// time the app opens — but it does mean this touches the real keychain, so
    /// expect a permission prompt from a test binary that is not the signed
    /// app.
    #[tokio::test]
    #[ignore = "hits the real platform and spends a refresh token"]
    async fn the_keys_endpoint_sends_the_shape_it_promised() {
        let cfg = config().expect("configured");
        let Some(stored) = crate::session::load() else {
            eprintln!("no session on this machine; sign in to the app first");
            return;
        };

        let tokens = refresh(&cfg.base, &cfg.anon_key, &stored.refresh_token)
            .await
            .expect("the stored session could not be refreshed");
        // Written down before it is used, exactly as the app does it.
        crate::session::replace(&stored, &tokens.refresh_token, &now_iso())
            .expect("the rotated token must be saved before it is spent");

        let keys = provider_keys(&cfg.base, &cfg.anon_key, &tokens.access_token)
            .await
            .expect("keys");

        println!("\n  response mode: {:?}", keys.mode);
        for (name, k) in [("openai", &keys.openai), ("elevenlabs", &keys.elevenlabs)] {
            println!(
                "    {name:<11} present={} mode={:?} hint={:?} reason={:?}",
                k.present,
                keys.mode_of(k),
                k.hint(),
                k.reason,
            );
            println!("      consent_url: {:?}", k.consent_url);
            println!("      manage_url:  {:?}", k.manage_url);

            // The settled rule: exactly one link per slot, never both, never
            // neither. Checked before anything else, because every button in
            // the app is built on it.
            let carried: Vec<&str> = [("consent_url", k.consent_url.is_some()), ("manage_url", k.manage_url.is_some())]
                .into_iter()
                .filter_map(|(n, present)| present.then_some(n))
                .collect();
            assert_eq!(
                carried.len(),
                1,
                "{name} carried {carried:?}; the rule is exactly one link per slot",
            );

            // And it must be the one this state calls for, since that is the
            // only field the app will read.
            let link = k.link().unwrap_or_else(|| {
                panic!(
                    "{name} (present={}) carried {carried:?}, which is not the field for its state — the app has no button to show",
                    k.present,
                )
            });
            assert!(
                link.starts_with("https://"),
                "{name} sent a relative link ({link}); the app opens it as-is and cannot resolve it",
            );

            if k.present {
                assert!(k.key.is_some(), "{name} says present with no key to use");
                println!("      → Manage key: {link}");
                continue;
            }

            // The reason, if sent, must be one the app has been taught — an
            // unknown word is tolerated but worth seeing in the output.
            match k.withheld_reason() {
                Some(r) => println!("      understood as: {r:?}"),
                None => println!("      reason not recognised by this build (falls back to generic wording)"),
            }
        }
    }

    /// The same, for the keys endpoint. Its path moved from the invented
    /// `/api/desktop/keys` to the edge function that exists.
    #[tokio::test]
    #[ignore = "hits the real platform"]
    async fn the_keys_endpoint_refuses_an_unauthenticated_request() {
        let cfg = config().expect("configured");
        match provider_keys(&cfg.base, &cfg.anon_key, "not-a-jwt").await {
            Err(PlatformError::Refused { status, message }) => {
                assert_eq!(status, 401, "{message}");
                println!("→ 401 {message}");
            }
            other => panic!("expected a 401, got {other:?}"),
        }
    }

    /// `grant_type=pkce` with `auth_code` and `code_verifier` is the exchange
    /// this code performs. A backend that did not know that grant would answer
    /// 400 `unsupported_grant_type`; one that does answers that this
    /// particular code was never issued, which is the correct complaint.
    #[tokio::test]
    #[ignore = "hits the real platform"]
    async fn the_token_endpoint_speaks_the_pkce_grant() {
        let cfg = config().expect("configured");
        match exchange_code(&cfg.base, &cfg.anon_key, "never-issued", "never-used").await {
            Err(PlatformError::Refused { status, message }) => {
                assert!(
                    message.contains("flow state"),
                    "the grant itself was rejected, not the code ({status}): {message}"
                );
                println!("→ {status} {message}");
            }
            other => panic!("expected a refusal about the code, got {other:?}"),
        }
    }

    /// Not used by anything yet, and recorded because it was the assumption
    /// that turned out wrong: the project signs *session* tokens with ES256
    /// through this endpoint, not HS256. If the offline cache ever gains the
    /// extra `sub`-matching check described on [`licence`], this is where its
    /// key comes from.
    #[tokio::test]
    #[ignore = "hits the real platform"]
    async fn the_projects_session_tokens_are_es256() {
        let cfg = config().expect("configured");
        let jwks: serde_json::Value = reqwest::get(format!(
            "{}/auth/v1/.well-known/jwks.json",
            cfg.base.trim_end_matches('/')
        ))
        .await
        .expect("reachable")
        .json()
        .await
        .expect("json");
        let algs: Vec<&str> =
            jwks["keys"].as_array().expect("keys").iter().filter_map(|k| k["alg"].as_str()).collect();
        assert!(algs.contains(&"ES256"), "session tokens are not ES256 any more: {jwks}");
        println!("→ {algs:?}");
    }
}

// ── the live pass ───────────────────────────────────────────────────────────

/// `--licence-probe <access-token>`: print what `desktop-licence` really says.
///
/// Everything else about this wiring can be settled from a machine with no
/// account — the 401s, the URLs, the parsing, the verifier. The one thing that
/// cannot is the *shape* of a successful answer, which needs a real session
/// token from a real signed-in user. Rather than guess at field names and find
/// out in a beta, this prints the raw JSON beside what this build made of it,
/// so the two can be compared by eye in one command:
///
/// ```text
/// ./Raw\ Footage\ Real\ Story.app/Contents/MacOS/… --licence-probe eyJ…
/// ```
///
/// Get the token from the same manual PKCE round trip the flow uses: it is
/// the `access_token` in the `grant_type=pkce` response.
///
/// Prints, and stores, nothing. The token is read from the argument and dies
/// with the process.
pub fn probe_licence(access_token: &str) -> i32 {
    let Some(cfg) = config() else {
        eprintln!("not configured: no platform URL or anon key");
        return 2;
    };
    if access_token.trim().is_empty() {
        eprintln!("usage: --licence-probe <access-token>");
        return 2;
    }
    println!("→ GET {}/functions/v1/desktop-licence", cfg.base.trim_end_matches('/'));
    println!(
        "  signature checking: {}",
        if crate::licence::verification_available() {
            "on — keys/hub-jwt-public.pem holds a key"
        } else {
            "OFF — keys/hub-jwt-public.pem is still the placeholder"
        }
    );

    // Tauri's runtime rather than a direct tokio dependency, which is only in
    // dev-dependencies and should stay there.
    tauri::async_runtime::block_on(async {
        let resp = match get(&cfg.base, "desktop-licence", &cfg.anon_key, access_token.trim()).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        let status = resp.status();
        let served_at =
            resp.headers().get(reqwest::header::DATE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let text = resp.text().await.unwrap_or_default();

        println!("← {status}   Date: {}", served_at.as_deref().unwrap_or("(none)"));
        println!("\n--- raw body ---\n{text}\n");
        if !status.is_success() {
            return 1;
        }

        match serde_json::from_str::<LicenceResponse>(&text) {
            Ok(body) => {
                println!("--- as this build reads it ---");
                println!("  active (plain fields): {}", body.entitled());
                println!("  status: {:?}   plan: {:?}", body.status, body.plan);
                // The field the screen is chosen from. A `reason` the raw
                // body plainly carries that comes out as `None` here is a
                // fifth word the platform has started sending, and
                // `licence::Denial` is the one place to teach it — until then
                // it falls to the generic "no subscription" screen.
                println!(
                    "  reason: {:?}   → read as: {:?}",
                    body.reason,
                    body.denial().map(crate::licence::Denial::as_str)
                );
                println!("  expires_at: {:?}", body.expires_at);
                match body.licence_token.as_deref() {
                    None => println!(
                        "  licence_token: ABSENT — the offline cache would have nothing signed \
                         to rest on. Check the field name against the raw body above."
                    ),
                    Some(t) => {
                        println!("  licence_token: present ({} chars)", t.len());
                        match crate::licence::claims_unverified(t) {
                            Ok(c) => println!("  claims (UNVERIFIED): {}", serde_json::to_string_pretty(&c).unwrap_or_default()),
                            Err(e) => println!("  claims could not be read: {e}"),
                        }
                        println!(
                            "  signature: {}",
                            match crate::licence::verify(t) {
                                Ok(v) => format!("verified, sub={}", v.claims().sub),
                                Err(e) => format!("NOT CHECKED — {e}"),
                            }
                        );
                    }
                }
                0
            }
            Err(e) => {
                eprintln!("the body did not parse as a licence response: {e}");
                1
            }
        }
    })
}

#[cfg(test)]
mod command_tests {
    use super::*;

    /// The shape `auth_cached_licence` hands the frontend is `CachedLicence`
    /// in `src/lib/entitlement.ts`, and the two are checked against each other
    /// here because nothing else checks them at all.
    ///
    /// A command whose field names drift is not a compile error in either
    /// language; it is a `undefined` in the webview and a gate that decides
    /// somebody has never been checked. `checkedAt` in particular is what the
    /// grace period is counted from, and `Date.parse(undefined)` is `NaN`,
    /// which `daysBetween` reads as infinitely old — every returning user sent
    /// straight to read-only by a rename.
    #[test]
    fn the_cached_licence_reaches_the_frontend_under_the_names_it_reads() {
        let json = serde_json::to_value(RecalledLicence {
            active: true,
            checked_at: "2026-08-18T09:00:00Z".into(),
            reason: None,
            expires_at: None,
        })
        .expect("serialises");

        assert_eq!(json["active"], serde_json::json!(true));
        assert_eq!(json["checkedAt"], serde_json::json!("2026-08-18T09:00:00Z"));
        assert!(json.get("checked_at").is_none(), "snake_case leaked across the boundary: {json}");

        // And the half that closes the offline gap: a refusal recalled from
        // disk has to reach the frontend saying *why*, under the same names a
        // live answer uses, or `gateFor` falls back to the generic screen and
        // a suspended user on a plane is pointed at a billing page again.
        let json = serde_json::to_value(RecalledLicence {
            active: false,
            checked_at: "2026-08-18T09:00:00Z".into(),
            reason: Some("membership_inactive".into()),
            expires_at: Some("2026-07-01T00:00:00Z".into()),
        })
        .expect("serialises");
        assert_eq!(json["reason"], serde_json::json!("membership_inactive"));
        assert_eq!(json["expiresAt"], serde_json::json!("2026-07-01T00:00:00Z"));
        assert!(json.get("expires_at").is_none(), "snake_case leaked: {json}");
    }

    /// `LicenceState` is read by `fromLicence` in `src/lib/entitlement.ts`,
    /// which picks one of five screens on the strength of these names. A
    /// rename on this side is not a compile error on that one; it is an
    /// `undefined`, and an `undefined` reason is a suspended account shown a
    /// "Manage subscription" button.
    #[test]
    fn a_denial_reaches_the_frontend_under_the_names_it_reads() {
        let json = serde_json::to_value(LicenceState {
            active: false,
            checked_at: "2026-08-18T09:00:00Z".into(),
            status: Some("canceled".into()),
            reason: Some("membership_inactive".into()),
            expires_at: Some("2026-07-01T00:00:00Z".into()),
            plan: None,
            verified: true,
        })
        .expect("serialises");

        assert_eq!(json["reason"], serde_json::json!("membership_inactive"));
        assert_eq!(json["expiresAt"], serde_json::json!("2026-07-01T00:00:00Z"));
        assert_eq!(json["checkedAt"], serde_json::json!("2026-08-18T09:00:00Z"));
        assert!(json.get("plan").is_none(), "an absent plan should not be sent as null: {json}");
        assert!(json.get("expires_at").is_none(), "snake_case leaked: {json}");

        // The word is passed through exactly as the platform spelled it. The
        // frontend matches on it character for character, so anything that
        // normalises it here — a lowercasing, a trim, a rename to something
        // tidier — silently sends every denial to the generic screen.
        for word in ["suspended", "no_membership", "membership_inactive", "no_access"] {
            let json = serde_json::to_value(LicenceState {
                active: false,
                checked_at: "2026-08-18T09:00:00Z".into(),
                status: None,
                reason: Some(word.into()),
                expires_at: None,
                plan: None,
                verified: true,
            })
            .expect("serialises");
            assert_eq!(json["reason"], serde_json::json!(word));
        }
    }

    /// With nothing in the environment, a downloaded build talks to
    /// production. This is the case that used to report "not configured" to
    /// everyone who was not running from a shell with the variables set.
    #[test]
    fn a_build_with_no_environment_still_knows_where_the_platform_is() {
        let c = resolve(None, None, None).expect("configured");
        assert_eq!(c.base, "https://pezsxoynjjsipfnpfvva.supabase.co");
        assert!(c.anon_key.starts_with("eyJ"), "the publishable key is missing");
        assert_eq!(c.provider, "google");
    }

    /// Pointing a build at staging must not need a recompile.
    #[test]
    fn the_environment_overrides_the_compiled_in_default() {
        let c = resolve(
            Some("https://staging.example.com/".into()),
            Some("staging-anon".into()),
            Some("github".into()),
        )
        .expect("configured");
        assert_eq!(c.base, "https://staging.example.com/");
        assert_eq!(c.anon_key, "staging-anon");
        assert_eq!(c.provider, "github");
    }

    /// An explicitly empty value is a way to switch the gate off entirely, and
    /// has to stay one — otherwise there is no way to get an unconfigured
    /// build any more, and `NOT_CONFIGURED` becomes unreachable.
    #[test]
    fn an_empty_override_means_unconfigured_rather_than_production() {
        assert!(resolve(Some(String::new()), None, None).is_none());
        assert!(resolve(None, Some("  ".into()), None).is_none());
        assert_eq!(GateError::not_configured().code, "NOT_CONFIGURED");
    }

    /// The `service_role` key must never be what this ships with. A
    /// belt-and-braces reading of the compiled-in key's own claims, so that
    /// pasting the wrong one in fails here rather than in the wild.
    #[test]
    fn the_compiled_in_key_is_the_publishable_one() {
        use base64::Engine;
        let payload = DEFAULT_ANON_KEY.split('.').nth(1).expect("a JWT");
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).expect("base64url");
        let claims: serde_json::Value = serde_json::from_slice(&raw).expect("json");
        assert_eq!(claims["role"], "anon", "this is not the publishable key: {claims}");
        assert_eq!(claims["ref"], "pezsxoynjjsipfnpfvva", "wrong project: {claims}");
    }

    /// The whole authorize URL, because every part of it has been wrong once.
    ///
    /// `/auth/v1/` was missing, which answered 404. `provider` was missing,
    /// which answered `Unsupported provider`. Both were quiet failures that
    /// only a real project could reveal.
    #[test]
    fn the_authorize_url_is_the_one_the_platform_answers() {
        let cfg = resolve(None, None, None).expect("configured");
        let url = authorize_url(&cfg, "the-challenge", "http://127.0.0.1:49152/callback?state=xyz");
        assert_eq!(
            url,
            "https://pezsxoynjjsipfnpfvva.supabase.co/auth/v1/authorize\
             ?provider=google&code_challenge=the-challenge&code_challenge_method=S256\
             &redirect_to=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback%3Fstate%3Dxyz"
        );
        // A trailing slash on the base must not produce a doubled one.
        let cfg = resolve(Some("https://x.example.com/".into()), None, None).expect("configured");
        assert!(authorize_url(&cfg, "c", "r").starts_with("https://x.example.com/auth/v1/authorize?"));
    }

    /// The redirect has to survive being put in a query string, or the
    /// provider sends the browser somewhere that is not us. The `state` in it
    /// is what makes the encoding load-bearing rather than cosmetic: an
    /// unencoded `?` would truncate the whole parameter.
    #[test]
    fn the_redirect_is_encoded_for_a_query_string() {
        assert_eq!(
            urlencode("http://127.0.0.1:49152/callback"),
            "http%3A%2F%2F127.0.0.1%3A49152%2Fcallback"
        );
        assert_eq!(
            urlencode("http://127.0.0.1:49152/callback?state=a-b_c"),
            "http%3A%2F%2F127.0.0.1%3A49152%2Fcallback%3Fstate%3Da-b_c"
        );
    }

    /// The grace period is measured in days between two timestamps, and the
    /// frontend measures it with `Date.parse`. A stamp that reads as `NaN`
    /// there is an infinitely old cache, which is read-only for everybody.
    #[test]
    fn timestamps_are_the_shape_the_grace_period_can_be_measured_in() {
        assert_eq!(iso_from_epoch(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_epoch(1_787_000_665), "2026-08-17T21:04:25Z");
        // A leap day, because the arithmetic is the only part worth doubting.
        assert_eq!(iso_from_epoch(1_709_164_800), "2024-02-29T00:00:00Z");
        assert!(now_iso().ends_with('Z') && now_iso().len() == 20, "{}", now_iso());
    }

    /// The check time comes from the platform's clock, off its own `Date`
    /// header, so a laptop with the wrong date cannot lengthen or shorten its
    /// own grace period.
    #[test]
    fn the_servers_own_clock_is_understood() {
        assert_eq!(
            http_date_to_iso("Mon, 17 Aug 2026 21:04:25 GMT").as_deref(),
            Some("2026-08-17T21:04:25Z")
        );
        // Anything unexpected falls back to the local clock rather than
        // producing a stamp that cannot be parsed.
        assert_eq!(http_date_to_iso("whenever"), None);
        assert_eq!(http_date_to_iso("Mon, 17 Aug 2026"), None);
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
