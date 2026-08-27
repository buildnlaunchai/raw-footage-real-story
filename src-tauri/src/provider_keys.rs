//! Which key a cloud provider is used with, and where it came from.
//!
//! There is exactly one answer now: the account. A person signs in, the
//! platform is asked what keys it holds for them, and those are what OpenAI
//! and ElevenLabs are called with. There is no second path.
//!
//! ## Why the local one went
//!
//! It used to be possible to paste a key into the app and have it kept in the
//! OS keychain for that machine. Two credentials for the same provider is one
//! more than can be reasoned about: a key rotated on the dashboard stayed live
//! in somebody's keychain until they thought to go and clear it, "which key is
//! this actually using?" had no answer visible from either side, and a person
//! on two machines had two different states to keep in step. Rotation and
//! revocation only mean anything if there is a single place the key comes
//! from.
//!
//! ## What is left, and why
//!
//! `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` are still read from the
//! environment, and only from there. That is not the local-key path coming
//! back in through a side door — nothing in the app writes them, no screen
//! offers them, and a packaged build inherits an environment with neither. It
//! is how the test suite and CI exercise the cloud providers at all, on a
//! runner with no keychain and nobody to sign in as. See [`env_override`].
//!
//! ## Where every link comes from
//!
//! From the platform, verbatim, or not at all — in *every* state, not just the
//! broken ones. A slot carries exactly one link: `manage_url` when the key
//! works, `consent_url` when it does not. The app opens what it was given and
//! composes nothing, so there is no state in which a screen here has to know
//! what the dashboard is called. See the note where the composed URL used to be
//! for why a guess is worse than nothing.
//!
//! ## Nothing is written down
//!
//! Keys live in memory for the session and are dropped when it ends. The
//! reasoning is [`crate::platform`]'s: a key is only useful with a network
//! connection, and with one the platform can simply be asked — so caching to
//! disk buys nothing and costs revocation.

use crate::platform::{self, KeyMode, PlatformError, ProviderKey, ProviderKeys, WithheldReason};
use serde::Serialize;

// There is no dashboard address in this file, and that is the design.
//
// A composed URL was here — `{dashboard}/keys?provider={slug}` — as a fallback
// for a backend that sent no link. It has gone, because the confirmed shape
// sends one on every withheld slot and because the composition was wrong in the
// case that matters most: the destination follows the *reason*, not the
// provider. `consent_required` belongs at `/dashboard/keys/desktop`, which has
// no provider in its path at all, and is the one page that can grant an app
// permission to read a key. A guessed provider link would have looked correct,
// opened cleanly, and left the person on a page that could not fix their
// problem — the worst of the three possible failures, because it does not look
// like one.
//
// So the app renders the platform's link or renders no button. It never
// invents a destination — and now that a working key carries a `manage_url`
// too, there is no state left in which it would have anything to invent.

/// The two providers this applies to.
///
/// An enum rather than a string, so a typo is a build failure instead of a
/// silent "that provider has no key". The `slug` is what the platform and the
/// dashboard both call it, and is the `?provider=` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    OpenAi,
    ElevenLabs,
}

impl Provider {
    pub fn slug(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::ElevenLabs => "elevenlabs",
        }
    }

    /// How the provider is written where a person will read it.
    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::ElevenLabs => "ElevenLabs",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "openai" => Some(Self::OpenAi),
            "elevenlabs" => Some(Self::ElevenLabs),
            _ => None,
        }
    }

    fn of(self, keys: &ProviderKeys) -> ProviderKey {
        match self {
            Self::OpenAi => keys.openai.clone(),
            Self::ElevenLabs => keys.elevenlabs.clone(),
        }
    }
}

/// What the platform last said, for this session only.
static KEYS: std::sync::RwLock<Option<ProviderKeys>> = std::sync::RwLock::new(None);

fn cached() -> Option<ProviderKeys> {
    KEYS.read().ok().and_then(|k| k.clone())
}

fn store(keys: &ProviderKeys) {
    if let Ok(mut slot) = KEYS.write() {
        *slot = Some(keys.clone());
    }
}

/// Drop everything fetched for the session that is ending.
pub(crate) fn forget() {
    if let Ok(mut slot) = KEYS.write() {
        *slot = None;
    }
}

/// Why there is no key to use.
///
/// The distinctions are the whole point. "You have not linked a key" is
/// answered by a button to the dashboard; "we could not reach the platform" is
/// answered by trying again later; and telling somebody offline to go and add
/// a key they already added is the failure this separation exists to avoid.
#[derive(Debug)]
pub enum KeyProblem {
    /// This build has no platform to ask.
    NotConfigured,
    /// Nobody is signed in on this machine.
    SignedOut,
    /// The platform could not be reached. Says nothing about the account.
    Unreachable(String),
    /// The platform answered, and this app cannot use a key for this provider.
    ///
    /// Three different situations behind one variant, told apart by `reason` —
    /// and they must be told apart, because "your account has no key" is
    /// simply false for `consent_required`, where the key exists and only the
    /// permission is missing.
    NotLinked {
        provider: Provider,
        reason: Option<WithheldReason>,
        /// The platform's own link. `None` only if it sent none, which the
        /// confirmed shape says it will not — the app still has to render
        /// something rather than a button pointing nowhere.
        consent_url: Option<String>,
    },
    /// The platform answered with something unexpected.
    Malformed(String),
}

impl KeyProblem {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "KEYS_NOT_CONFIGURED",
            Self::SignedOut => "KEYS_SIGNED_OUT",
            Self::Unreachable(_) => "KEYS_UNREACHABLE",
            Self::NotLinked { .. } => "KEY_NOT_LINKED",
            Self::Malformed(_) => "KEYS_MALFORMED",
        }
    }

    /// What to put in front of a person.
    ///
    /// No sentence here mentions pasting, entering or saving a key, because
    /// none of those is a thing this app can do any more. Every message either
    /// names an action available on screen or explains a wait.
    pub fn message(&self) -> String {
        match self {
            Self::NotConfigured => {
                "This build has no account to fetch provider keys from.".into()
            }
            Self::SignedOut => {
                "Sign in to use cloud providers — their keys come from your account.".into()
            }
            Self::Unreachable(e) => format!(
                "Couldn't reach your account to fetch provider keys. Check your connection and try again. ({e})"
            ),
            Self::NotLinked { provider, reason, .. } => withheld_message(*provider, *reason),
            Self::Malformed(e) => format!("Your account returned something unreadable ({e})."),
        }
    }

    /// The page that fixes it, exactly as the platform addressed it.
    pub fn consent_url(&self) -> Option<String> {
        match self {
            Self::NotLinked { consent_url, .. } => consent_url.clone(),
            _ => None,
        }
    }

    /// What to put on the button that opens it.
    pub fn action_label(&self) -> Option<&'static str> {
        match self {
            Self::NotLinked { reason, .. } => Some(action_label(*reason)),
            _ => None,
        }
    }
}

/// What to tell somebody about a withheld provider.
///
/// One place, shared by the error path and the settings screen, for the same
/// reason `entitlement.ts` keeps `blockedBy` in one place: two copies of a
/// reason-to-wording mapping is how the same situation comes to be described
/// two different ways depending on which screen you arrived from.
///
/// An unrecognised or absent reason gets wording that is true of all three. It
/// claims nothing about which of them it is, because it does not know — and the
/// link beside it is still the right link either way.
fn withheld_message(provider: Provider, reason: Option<WithheldReason>) -> String {
    let name = provider.label();
    match reason {
        Some(WithheldReason::ConsentRequired) => format!(
            "Your {name} key is on your account, but this app hasn't been allowed to use it yet. That permission is granted once, on your dashboard.",
        ),
        Some(WithheldReason::NoKey) => format!(
            "Your account has no {name} key yet. Add one on your dashboard and it will work on every machine you sign in on.",
        ),
        Some(WithheldReason::KeyInvalid) => format!(
            "The {name} key on your account was rejected by {name}. Replace it on your dashboard.",
        ),
        None => format!(
            "This app can't use an {name} key from your account yet. Your dashboard has the details.",
        ),
    }
}

fn action_label(reason: Option<WithheldReason>) -> &'static str {
    match reason {
        Some(WithheldReason::ConsentRequired) => "Allow this app",
        Some(WithheldReason::NoKey) => "Add a key",
        Some(WithheldReason::KeyInvalid) => "Replace the key",
        None => "Open my dashboard",
    }
}

impl From<PlatformError> for KeyProblem {
    fn from(e: PlatformError) -> Self {
        match &e {
            PlatformError::Unreachable(m) => Self::Unreachable(m.clone()),
            PlatformError::Malformed(m) => Self::Malformed(m.clone()),
            // A refusal that is not a dead token is the platform declining to
            // answer about this account, which from here is indistinguishable
            // from being signed out and has the same remedy.
            PlatformError::Refused { .. } => Self::SignedOut,
        }
    }
}

/// The environment variable for a provider, if it is set to anything.
///
/// Read before the account, and this is the one place that ordering is
/// decided. It exists for CI and for working on the cloud paths without a
/// signed-in session; see the module note on why it is not the local-key path
/// under another name.
fn env_override(provider: Provider) -> Option<String> {
    let var = match provider {
        Provider::OpenAi => "OPENAI_API_KEY",
        Provider::ElevenLabs => "ELEVENLABS_API_KEY",
    };
    std::env::var(var).ok().filter(|v| !v.trim().is_empty())
}

/// Ask the platform what it holds, or hand back what it said earlier.
///
/// `force` skips the session cache, which is what the settings screen's
/// refresh does: somebody who has just added a key on the dashboard is
/// standing in front of the app expecting it to notice.
///
/// The access token from the launch licence check is tried first. Only if it
/// is missing or has expired is a refresh token spent — refresh tokens rotate,
/// so spending one per question would be both wasteful and a way to lose a
/// session to a crash at the wrong moment.
pub async fn load(force: bool) -> Result<ProviderKeys, KeyProblem> {
    if !force {
        if let Some(k) = cached() {
            return Ok(k);
        }
    }

    let cfg = platform::config().ok_or(KeyProblem::NotConfigured)?;

    if let Some(access) = platform::current_access() {
        match platform::provider_keys(&cfg.base, &cfg.anon_key, &access).await {
            Ok(keys) => {
                store(&keys);
                return Ok(keys);
            }
            // An expired access token is the ordinary case an hour in, and the
            // only one worth spending a refresh token to get past.
            Err(e) if e.is_unauthorised() => {}
            Err(e) => return Err(e.into()),
        }
    }

    let stored = crate::session::load().ok_or(KeyProblem::SignedOut)?;
    let tokens = platform::refresh(&cfg.base, &cfg.anon_key, &stored.refresh_token)
        .await
        .map_err(|e| if e.is_unauthorised() { KeyProblem::SignedOut } else { e.into() })?;

    // Written down before it is used, for the reason `session::replace` gives:
    // a rotated token spent but never saved signs somebody out permanently.
    crate::session::replace(&stored, &tokens.refresh_token, &platform::now_iso())
        .map_err(|e| KeyProblem::Malformed(e.to_string()))?;
    platform::remember_access(&tokens.access_token);

    let keys = platform::provider_keys(&cfg.base, &cfg.anon_key, &tokens.access_token).await?;
    store(&keys);
    Ok(keys)
}

/// WHERE a provider call goes, and WHAT to send with it.
///
/// The one place that answers "who is paying", so neither openai.rs nor
/// elevenlabs.rs contains a branch on the mode — they build one request from
/// this and never learn there are two kinds.
///
///   byok    the member's own key, straight to the provider
///   credit  the member's SESSION, to the hub's gateway, which spends OUR key
///           against credit they bought
///
/// Getting this backwards is the expensive one: a key spent while the account
/// is on credits bills the member twice, once by their provider and once in
/// credits, for a single call — and nothing afterwards can tell, because a
/// wrong release is byte-for-byte identical to a right one.
#[derive(Debug, Clone)]
pub struct CallTarget {
    /// Absolute, with no trailing slash. The caller appends the provider's own
    /// path — `/v1/responses`, `/v1/text-to-speech/{voice}` — and the same
    /// string works for both destinations because the gateway mirrors the
    /// provider's route shape underneath its own prefix.
    pub base: String,
    /// Header name/value pairs, already formed. A list rather than named fields
    /// because the two providers do not agree on the header: OpenAI takes a
    /// bearer, ElevenLabs takes `xi-api-key`, and in credit mode both take the
    /// session bearer plus the project's `apikey`.
    pub headers: Vec<(String, String)>,
    pub mode: KeyMode,
}

/// `direct_base` is passed IN rather than held here, and not for tidiness: a
/// guard test in this file forbids a literal `https://` anywhere in it, because
/// the platform's addresses must come from the platform and never be composed
/// locally. A provider's own API base is a different kind of thing — it belongs
/// to OpenAI and ElevenLabs, not to us — so it stays in each provider's own
/// client, which is where it has always lived, and this function decides only
/// the thing it is actually about: who pays.
pub async fn target_for(provider: Provider, direct_base: &str) -> Result<CallTarget, KeyProblem> {
    let direct = |key: String| CallTarget {
        base: direct_base.to_string(),
        headers: match provider {
            Provider::OpenAi => vec![("authorization".into(), format!("Bearer {key}"))],
            Provider::ElevenLabs => vec![("xi-api-key".into(), key)],
        },
        mode: KeyMode::Byok,
    };

    // The developer escape hatch, unchanged and still first: a key in the
    // environment means this machine is testing against a provider directly and
    // has said so out loud.
    if let Some(v) = env_override(provider) {
        return Ok(direct(v));
    }

    let keys = load(false).await?;
    let held = provider.of(&keys);

    if keys.mode_of(&held) == KeyMode::Credit {
        let cfg = platform::config().ok_or(KeyProblem::NotConfigured)?;
        // Proactively refreshed and serialised — see platform::fresh_access. A
        // narration run spends this token once per line for as long as the
        // script takes, which is what makes an hour-long expiry a real event
        // rather than a theoretical one.
        let access = platform::fresh_access()
            .await
            .map_err(|e| if e.is_unauthorised() { KeyProblem::SignedOut } else { e.into() })?;

        return Ok(CallTarget {
            base: format!(
                "{}/functions/v1/ai-gateway/{}",
                cfg.base.trim_end_matches('/'),
                provider.slug()
            ),
            headers: vec![
                // `apikey` identifies the project, the bearer identifies the
                // member — the same pair every other hub call uses.
                ("apikey".into(), cfg.anon_key.clone()),
                ("authorization".into(), format!("Bearer {access}")),
            ],
            mode: KeyMode::Credit,
        });
    }

    // Byok, or a mode this build has not been taught. Falling back to the
    // member's own key is the safe direction: an unknown mode must never become
    // a licence to spend the platform's.
    match held.key.as_deref().map(str::trim) {
        Some(k) if held.present && !k.is_empty() => Ok(direct(k.to_string())),
        _ => Err(KeyProblem::NotLinked {
            provider,
            reason: held.withheld_reason(),
            consent_url: held.consent_link(),
        }),
    }
}

/// The key to call a provider with.
///
/// The only way either client gets one. Both used to read the keychain
/// directly, which is what made "remove local keys" a change to the UI *and* a
/// change to where the credential actually came from.
pub async fn key_for(provider: Provider) -> Result<String, KeyProblem> {
    if let Some(v) = env_override(provider) {
        return Ok(v);
    }

    let keys = load(false).await?;
    let held = provider.of(&keys);

    // `present: false` and a present-but-empty key are the same thing to a
    // caller about to put it in a header, and both mean "not linked" rather
    // than "rejected". Telling those apart is what stops the app reporting a
    // bad key to somebody who never had one.
    match held.key.as_deref().map(str::trim) {
        Some(k) if held.present && !k.is_empty() => Ok(k.to_string()),
        _ => Err(KeyProblem::NotLinked {
            provider,
            reason: held.withheld_reason(),
            consent_url: held.consent_link(),
        }),
    }
}

// --- what the settings screen shows -----------------------------------------

/// One provider, as a screen needs to describe it.
///
/// Carries no key and never will: `hint` is four characters, which is enough
/// to recognise a key by and useless to anyone who intercepts it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: &'static str,
    /// How it is written in a sentence.
    pub label: &'static str,
    /// Is there a key this app can actually use right now?
    pub linked: bool,
    /// Whose key it is: the account holder's, or the platform's credits.
    pub mode: KeyMode,
    /// The last four characters of the key in use, when there is one.
    pub hint: Option<String>,
    /// The platform's link for this slot, verbatim, whichever field carried it.
    ///
    /// Resolved here rather than in the UI so there is exactly one place in the
    /// app where a destination is decided, and that place only ever copies. The
    /// UI's whole rule is "a button if this is `Some`, no button if not" — it
    /// never needs to know that a working key's link arrives under a different
    /// name from a withheld one's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_url: Option<String>,
    /// Which of the three situations this is, when the platform said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<WithheldReason>,
    /// What to tell the person. `None` when the key works and there is nothing
    /// to explain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// What to put on the button that opens `link_url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_label: Option<&'static str>,
    /// True when the key is coming from the environment rather than the
    /// account — a development and CI arrangement, surfaced rather than hidden
    /// so nobody debugs a dashboard that is not being consulted.
    pub from_environment: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyError {
    pub code: String,
    pub message: String,
    /// The platform's link, when the failure is one a page can fix.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_label: Option<&'static str>,
}

impl From<KeyProblem> for KeyError {
    fn from(p: KeyProblem) -> Self {
        Self {
            code: p.code().into(),
            message: p.message(),
            consent_url: p.consent_url(),
            action_label: p.action_label(),
        }
    }
}

/// What this account has, for both providers at once.
///
/// One call rather than one per provider: they come from a single response, and
/// asking twice would be two round trips to learn one thing — and two chances
/// for the two halves of a settings screen to disagree.
///
/// A failure here is returned rather than flattened into "nothing linked". The
/// difference between "you have not added a key" and "we could not ask" is the
/// difference between a useful button and a wrong accusation.
#[tauri::command]
pub async fn provider_key_status(refresh: bool) -> Result<Vec<ProviderStatus>, KeyError> {
    let providers = [Provider::OpenAi, Provider::ElevenLabs];

    // An environment key stands on its own and needs no account behind it, so
    // a build running on one is described without the platform being asked.
    if providers.iter().all(|p| env_override(*p).is_some()) {
        return Ok(providers.iter().map(|p| from_environment(*p)).collect());
    }

    let keys = load(refresh).await.map_err(KeyError::from)?;
    Ok(providers
        .iter()
        .map(|p| {
            if env_override(*p).is_some() {
                return from_environment(*p);
            }
            let held = p.of(&keys);
            let usable = held.present && held.key.as_deref().is_some_and(|k| !k.trim().is_empty());
            let reason = held.withheld_reason();
            // Only ever what the platform sent, in either state. `link`
            // decides which of the two fields carries it; nothing here builds
            // one.
            let link_url = held.link();
            ProviderStatus {
                provider: p.slug(),
                label: p.label(),
                linked: usable,
                mode: keys.mode_of(&held),
                hint: held.hint(),
                action_label: link_url
                    .is_some()
                    .then(|| if usable { MANAGE_LABEL } else { action_label(reason) }),
                link_url,
                reason: (!usable).then_some(reason).flatten(),
                message: (!usable).then(|| withheld_message(*p, reason)),
                from_environment: false,
            }
        })
        .collect())
}

/// The button on a working key. The only piece of link copy the app owns, and
/// it is a label rather than a destination.
const MANAGE_LABEL: &str = "Manage key";

fn from_environment(p: Provider) -> ProviderStatus {
    ProviderStatus {
        provider: p.slug(),
        label: p.label(),
        linked: true,
        mode: KeyMode::Byok,
        hint: env_override(p).map(|k| k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()),
        // A key from the environment belongs to whoever set the variable. The
        // account holds nothing to manage, so there is nowhere to send anybody.
        link_url: None,
        reason: None,
        message: None,
        action_label: None,
        from_environment: true,
    }
}

// `provider_manage_url` was here. It answered "where does this provider's
// button go?" without asking the platform, which it could only do while there
// was a URL to compose. There is not, and there should not be: the answer lives
// in the response and nowhere else, so the screens ask `provider_key_status`
// like everything else does. One command, one source.

#[cfg(test)]
mod tests {
    use super::*;

    fn withheld(reason: &str, consent: Option<&str>) -> ProviderKey {
        ProviderKey {
            present: false,
            key: None,
            mode: None,
            consent_url: consent.map(str::to_string),
            manage_url: None,
            reason: Some(reason.to_string()),
        }
    }

    fn working(manage: Option<&str>) -> ProviderKey {
        ProviderKey {
            present: true,
            key: Some("sk-proj-abcd1234".into()),
            mode: None,
            consent_url: None,
            manage_url: manage.map(str::to_string),
            reason: None,
        }
    }

    /// A slot carries exactly one link, and `present` says which.
    ///
    /// The settled rule, and the reason the UI only ever sees a single
    /// `link_url`: it never has to know that the field's name changes with the
    /// state.
    #[test]
    fn each_slot_offers_the_one_link_its_state_carries() {
        let manage = "https://buildnlaunchai.com/dashboard/keys?provider=openai";
        assert_eq!(working(Some(manage)).link().as_deref(), Some(manage));

        let consent = "https://buildnlaunchai.com/dashboard/keys/desktop";
        assert_eq!(withheld("consent_required", Some(consent)).link().as_deref(), Some(consent));
    }

    /// A withheld slot must never be answered with a `manage_url`.
    ///
    /// The one crossing-over that would be actively wrong rather than merely
    /// untidy: `consent_required` means the key exists and this app lacks
    /// permission to read it, and the provider page cannot grant that. A
    /// missing button is cosmetic; a button onto a page that cannot help is the
    /// failure that does not look like one.
    #[test]
    fn a_withheld_slot_never_borrows_the_manage_link() {
        let mut k = withheld("consent_required", None);
        k.manage_url = Some("https://buildnlaunchai.com/dashboard/keys?provider=openai".into());
        assert_eq!(k.link(), None, "a withheld slot was sent to the manage page");
    }

    /// And the same in the other direction, for symmetry of reasoning: a
    /// working slot reads its own field and not the withheld one.
    #[test]
    fn a_working_slot_reads_its_own_field() {
        let mut k = working(None);
        k.consent_url = Some("https://buildnlaunchai.com/dashboard/keys/desktop".into());
        assert_eq!(k.link(), None);
    }

    /// A working key's link survives into what the screen renders, and brings
    /// a button label with it.
    #[test]
    fn a_working_key_is_given_somewhere_to_be_managed() {
        let manage = "https://buildnlaunchai.com/dashboard/keys?provider=openai";
        let held = working(Some(manage));
        let link = held.link();
        let status = ProviderStatus {
            provider: Provider::OpenAi.slug(),
            label: Provider::OpenAi.label(),
            linked: true,
            mode: KeyMode::Byok,
            hint: held.hint(),
            action_label: link.is_some().then_some(MANAGE_LABEL),
            link_url: link,
            reason: None,
            message: None,
            from_environment: false,
        };
        assert_eq!(status.link_url.as_deref(), Some(manage));
        assert_eq!(status.action_label, Some("Manage key"));
        // Nothing to explain about a key that works.
        assert!(status.message.is_none());
    }

    /// The exact response the platform confirmed, parsed field for field.
    ///
    /// Written out verbatim rather than paraphrased: this is the contract, and
    /// a test that restates it in the shape the code already expects proves
    /// nothing. Note `consent_url` in snake_case and `mode` at the top level —
    /// both differ from what this struct would guess on its own.
    #[test]
    fn the_confirmed_response_shape_parses() {
        let body = r#"{
          "mode": "byok",
          "openai":     { "present": true,  "key": "sk-abcd1234",
                          "manage_url": "https://buildnlaunchai.com/dashboard/keys?provider=openai" },
          "elevenlabs": { "present": false, "reason": "no_key",
                          "consent_url": "https://buildnlaunchai.com/dashboard/keys?provider=elevenlabs" }
        }"#;
        let keys: ProviderKeys = serde_json::from_str(body).expect("the confirmed shape must parse");

        assert!(keys.openai.present);
        assert_eq!(keys.openai.hint().as_deref(), Some("1234"));
        // A working slot carries the manage link, and no consent link.
        assert_eq!(
            keys.openai.link().as_deref(),
            Some("https://buildnlaunchai.com/dashboard/keys?provider=openai"),
        );
        assert_eq!(keys.openai.consent_link(), None, "a working slot must not carry a consent link");

        assert!(!keys.elevenlabs.present);
        assert_eq!(keys.elevenlabs.withheld_reason(), Some(WithheldReason::NoKey));
        assert_eq!(
            keys.elevenlabs.link().as_deref(),
            Some("https://buildnlaunchai.com/dashboard/keys?provider=elevenlabs"),
        );

        // Never both, never neither: each slot answered with exactly one.
        for (name, k) in [("openai", &keys.openai), ("elevenlabs", &keys.elevenlabs)] {
            let carried = [k.consent_url.is_some(), k.manage_url.is_some()];
            assert_eq!(
                carried.iter().filter(|c| **c).count(),
                1,
                "{name} carried {carried:?} links; the rule is exactly one",
            );
        }

        // Mode is carried once, at the top, and applies to both slots.
        assert_eq!(keys.mode, KeyMode::Byok);
        assert_eq!(keys.mode_of(&keys.openai), KeyMode::Byok);
        assert_eq!(keys.mode_of(&keys.elevenlabs), KeyMode::Byok);
    }

    /// The link is opened as it arrives — not joined, not appended to, not
    /// normalised.
    ///
    /// `consent_required` is the case that makes this matter: its page has no
    /// provider in the address, so anything composed from a provider slug is
    /// not merely a different URL but a page that cannot grant the permission
    /// being asked for.
    #[test]
    fn every_reasons_link_is_passed_through_untouched() {
        for (reason, url) in [
            ("consent_required", "https://buildnlaunchai.com/dashboard/keys/desktop"),
            ("no_key", "https://buildnlaunchai.com/dashboard/keys?provider=openai"),
            ("key_invalid", "https://buildnlaunchai.com/dashboard/keys?provider=openai"),
        ] {
            let k = withheld(reason, Some(url));
            assert_eq!(k.consent_link().as_deref(), Some(url), "{reason} was not passed through");
        }
    }

    /// Nothing in this module composes a URL any more.
    ///
    /// Read out of the source, because the guarantee is the *absence* of code
    /// and there is no value to assert against. A fallback creeping back in is
    /// exactly the regression that would go unnoticed: it would look like a
    /// button that works, and only somebody with `consent_required` would ever
    /// find out it was the wrong page.
    #[test]
    fn no_dashboard_address_is_composed_anywhere_here() {
        let source = include_str!("provider_keys.rs");
        let working = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let code: String = working
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // Addresses only. The *word* "dashboard" is wanted in the messages —
        // telling somebody where to go in prose is the job — so banning it
        // caught the copy this module is supposed to contain. What must never
        // appear is a host or a scheme, because those are the makings of a URL.
        for banned in ["buildnlaunchai.com", "https://", "http://"] {
            assert!(
                !code.contains(banned),
                "{banned} is back in the working code; the link belongs to the platform",
            );
        }
    }

    /// `consent_required` must never be described as a missing key.
    ///
    /// The key exists. Telling somebody to go and add one they already have
    /// sends them looking for a problem that is not there, and the page that
    /// actually fixes it is not the one that wording implies.
    #[test]
    fn consent_required_is_not_described_as_a_missing_key() {
        let m = withheld_message(Provider::ElevenLabs, Some(WithheldReason::ConsentRequired));
        assert!(m.contains("ElevenLabs"), "does not say which provider: {m}");
        assert!(m.contains("permission") || m.contains("allowed"), "does not say what is missing: {m}");
        assert!(!m.contains("no ElevenLabs key"), "claims the key is absent when it is not: {m}");
        // And the three situations must not share one sentence.
        let no_key = withheld_message(Provider::ElevenLabs, Some(WithheldReason::NoKey));
        let invalid = withheld_message(Provider::ElevenLabs, Some(WithheldReason::KeyInvalid));
        assert_ne!(m, no_key);
        assert_ne!(m, invalid);
        assert_ne!(no_key, invalid);
    }

    /// A word this build has never seen decides nothing and blocks nothing.
    ///
    /// The same rule `entitlement.ts` applies to licence reasons: a desktop
    /// binary with opinions about vocabulary it has not been taught is one that
    /// breaks when the backend adds a word. The generic wording is true of all
    /// three, and the link beside it is still the platform's.
    #[test]
    fn an_unknown_reason_falls_back_to_wording_that_claims_nothing() {
        let k = withheld("some_future_reason", Some("https://buildnlaunchai.com/somewhere"));
        assert_eq!(k.withheld_reason(), None, "an unknown word must not be forced into one of the three");
        assert_eq!(k.consent_link().as_deref(), Some("https://buildnlaunchai.com/somewhere"));

        let m = withheld_message(Provider::OpenAi, None);
        for claim in ["no OpenAI key", "rejected", "permission"] {
            assert!(!m.contains(claim), "claims to know which situation it is: {m}");
        }
    }

    /// A missing link is one absent button, not a failure to read the response.
    ///
    /// The field is required by the contract, so this should never happen. It
    /// is handled anyway because the alternative — refusing to parse — takes
    /// *both* providers' keys down over a field that only draws a button, in a
    /// binary already on somebody's machine.
    #[test]
    fn a_slot_missing_its_link_still_parses_and_still_delivers_the_other_key() {
        let body = r#"{
          "mode": "byok",
          "openai":     { "present": true, "key": "sk-abcd1234" },
          "elevenlabs": { "present": false, "reason": "no_key" }
        }"#;
        let keys: ProviderKeys = serde_json::from_str(body).expect("a missing link must not fail the parse");
        assert_eq!(keys.elevenlabs.consent_link(), None, "no link means no button");
        // The point of tolerating it: OpenAI still works.
        assert_eq!(keys.openai.hint().as_deref(), Some("1234"));
    }

    /// Whitespace is not a link. An inert button is worse than no button — it
    /// is the only thing on that screen a person can act on.
    #[test]
    fn an_empty_consent_url_is_not_treated_as_one() {
        assert_eq!(withheld("no_key", Some("   ")).consent_link(), None);
        assert_eq!(withheld("no_key", Some("")).consent_link(), None);
    }

    /// Being offline must never be reported as a missing key. One is fixed by
    /// waiting, the other by visiting a dashboard, and telling somebody to go
    /// and re-add a key they already have is the wrong instruction.
    #[test]
    fn unreachable_is_not_confused_with_unlinked() {
        let p: KeyProblem = PlatformError::Unreachable("dns".into()).into();
        assert_eq!(p.code(), "KEYS_UNREACHABLE");
        assert!(p.consent_url().is_none(), "offered a dashboard trip for a network problem");
        assert!(p.action_label().is_none(), "offered a button for a network problem");
    }

    /// No message anywhere here offers to store a key on this machine.
    #[test]
    fn nothing_offers_a_local_key() {
        let mut messages = vec![
            KeyProblem::SignedOut.message(),
            KeyProblem::NotConfigured.message(),
            KeyProblem::Unreachable("x".into()).message(),
        ];
        for r in [None, Some(WithheldReason::ConsentRequired), Some(WithheldReason::NoKey), Some(WithheldReason::KeyInvalid)] {
            messages.push(withheld_message(Provider::OpenAi, r));
        }
        for m in messages {
            for banned in ["paste", "Paste", "keychain", "enter your key", "this Mac"] {
                assert!(!m.contains(banned), "still offers a local key: {m}");
            }
        }
    }

    /// The environment variables are read here, are per provider, and do not
    /// bleed into each other.
    ///
    /// Process-global state, so one test rather than three: split across
    /// parallel tests these raced and failed intermittently, which was a
    /// property of the test design and not of the code. Inherited from the
    /// credential store this moved out of, along with the reason.
    #[test]
    fn environment_overrides_are_read_here_and_are_per_provider() {
        // Safety: the only test touching these variables, and each is removed
        // before anything depends on its absence.
        unsafe { std::env::set_var("ELEVENLABS_API_KEY", "test-key-from-env") };
        assert_eq!(env_override(Provider::ElevenLabs).as_deref(), Some("test-key-from-env"));
        // A key exported for one provider must not answer for the other.
        assert!(env_override(Provider::OpenAi).is_none(), "the variables bled into each other");

        // Whitespace is not a key.
        unsafe { std::env::set_var("ELEVENLABS_API_KEY", "   ") };
        assert!(env_override(Provider::ElevenLabs).is_none());
        unsafe { std::env::remove_var("ELEVENLABS_API_KEY") };

        unsafe { std::env::set_var("OPENAI_API_KEY", "sk-test-openai") };
        assert_eq!(env_override(Provider::OpenAi).as_deref(), Some("sk-test-openai"));
        unsafe { std::env::remove_var("OPENAI_API_KEY") };

        assert!(env_override(Provider::OpenAi).is_none(), "the variable outlived the test");
    }

    /// The parsed slugs are the ones the platform and the dashboard use.
    #[test]
    fn the_slugs_round_trip() {
        for p in [Provider::OpenAi, Provider::ElevenLabs] {
            assert_eq!(Provider::parse(p.slug()), Some(p));
        }
        assert_eq!(Provider::parse("anthropic"), None);
    }

    /// The status a screen renders must never be able to carry the key.
    #[test]
    fn a_status_carries_a_hint_and_never_the_key() {
        let held = working(None);
        let status = ProviderStatus {
            provider: Provider::OpenAi.slug(),
            label: Provider::OpenAi.label(),
            linked: true,
            mode: KeyMode::Byok,
            hint: held.hint(),
            link_url: None,
            reason: None,
            message: None,
            action_label: None,
            from_environment: false,
        };
        let json = serde_json::to_string(&status).expect("serialises");
        assert!(json.contains("1234"), "no way to recognise the key in use: {json}");
        assert!(!json.contains("sk-proj-abcd1234"), "the key reached the webview: {json}");
    }
}
