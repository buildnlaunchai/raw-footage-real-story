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
//! ## Nothing is written down
//!
//! Keys live in memory for the session and are dropped when it ends. The
//! reasoning is [`crate::platform`]'s: a key is only useful with a network
//! connection, and with one the platform can simply be asked — so caching to
//! disk buys nothing and costs revocation.

use crate::platform::{self, KeyMode, PlatformError, ProviderKey, ProviderKeys};
use serde::Serialize;

/// Where somebody manages the keys held against their account.
///
/// The fallback, and only the fallback. Whenever the platform sends a
/// `consentUrl` for a provider that is used instead — it is the side that
/// knows whether this account has yet agreed to release a key it already
/// holds, and which page to land on to say so. Composing a URL here is what
/// happens when it sends nothing.
const DASHBOARD_KEYS: &str = "https://buildnlaunchai.com/dashboard/keys";

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
    /// The platform answered, and it holds no usable key for this provider —
    /// or holds one this account has not consented to release.
    NotLinked { provider: Provider, manage_url: String },
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
            Self::NotLinked { provider, .. } => format!(
                "Your account has no {} key available yet. Open your dashboard to add one or allow this app to use it.",
                provider.label()
            ),
            Self::Malformed(e) => format!("Your account returned something unreadable ({e})."),
        }
    }

    /// The page that fixes it, when a page can.
    pub fn manage_url(&self) -> Option<String> {
        match self {
            Self::NotLinked { manage_url, .. } => Some(manage_url.clone()),
            _ => None,
        }
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

/// Where to send the browser for this provider.
///
/// The platform's own link wins. It is the side that knows whether the account
/// holds a key awaiting consent or holds nothing at all, and those are two
/// different pages; guessing between them from out here would be guessing.
fn manage_url(provider: Provider, key: Option<&ProviderKey>) -> String {
    key.and_then(|k| k.consent_url.clone())
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("{DASHBOARD_KEYS}?provider={}", provider.slug()))
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
            manage_url: manage_url(provider, Some(&held)),
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
    /// Where the browser goes to put it right. Always populated, so a screen
    /// never has to decide what to do with a button that has nowhere to go.
    pub manage_url: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manage_url: Option<String>,
}

impl From<KeyProblem> for KeyError {
    fn from(p: KeyProblem) -> Self {
        Self { code: p.code().into(), message: p.message(), manage_url: p.manage_url() }
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
            ProviderStatus {
                provider: p.slug(),
                label: p.label(),
                linked: usable,
                mode: held.mode,
                hint: held.hint(),
                manage_url: manage_url(*p, Some(&held)),
                from_environment: false,
            }
        })
        .collect())
}

fn from_environment(p: Provider) -> ProviderStatus {
    ProviderStatus {
        provider: p.slug(),
        label: p.label(),
        linked: true,
        mode: KeyMode::Byok,
        hint: env_override(p).map(|k| k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()),
        manage_url: manage_url(p, None),
        from_environment: true,
    }
}

/// Where to send somebody for one provider, without asking the platform
/// anything.
///
/// For the screens that need a destination while offline or signed out — the
/// readiness panel among them. Falls back to the dashboard, which is the right
/// answer when there is no session to have a consent link for.
#[tauri::command]
pub fn provider_manage_url(provider: String) -> String {
    match Provider::parse(&provider) {
        Some(p) => {
            let held = cached().map(|k| p.of(&k));
            manage_url(p, held.as_ref())
        }
        None => DASHBOARD_KEYS.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_with(consent: Option<&str>, present: bool) -> ProviderKey {
        ProviderKey {
            present,
            key: present.then(|| "sk-proj-abcd1234".to_string()),
            mode: KeyMode::Byok,
            consent_url: consent.map(str::to_string),
        }
    }

    /// The platform's link is used verbatim when it sends one. It is the only
    /// side that knows whether this account is missing a key or merely has not
    /// consented to release one, and those are different pages.
    #[test]
    fn the_platforms_own_consent_link_wins() {
        let k = key_with(Some("https://buildnlaunchai.com/consent?app=rfrs&provider=openai"), false);
        assert_eq!(
            manage_url(Provider::OpenAi, Some(&k)),
            "https://buildnlaunchai.com/consent?app=rfrs&provider=openai",
        );
    }

    /// And a backend that sends none still leaves the user with somewhere to
    /// go. A button with no destination is worse than the key entry it
    /// replaced.
    #[test]
    fn without_one_the_dashboard_is_addressed_per_provider() {
        assert_eq!(
            manage_url(Provider::OpenAi, Some(&key_with(None, false))),
            "https://buildnlaunchai.com/dashboard/keys?provider=openai",
        );
        assert_eq!(
            manage_url(Provider::ElevenLabs, Some(&key_with(None, false))),
            "https://buildnlaunchai.com/dashboard/keys?provider=elevenlabs",
        );
        // Nothing known at all — signed out, nothing fetched — still resolves.
        assert_eq!(
            manage_url(Provider::ElevenLabs, None),
            "https://buildnlaunchai.com/dashboard/keys?provider=elevenlabs",
        );
    }

    /// An empty string is not a link. A backend sending `""` would otherwise
    /// hand the browser nowhere, which is the one outcome the fallback exists
    /// to prevent.
    #[test]
    fn an_empty_consent_url_is_not_treated_as_one() {
        let k = key_with(Some("   "), false);
        assert_eq!(
            manage_url(Provider::OpenAi, Some(&k)),
            "https://buildnlaunchai.com/dashboard/keys?provider=openai",
        );
    }

    /// `present: false` is answered with a place to go, never with a
    /// complaint about the key being wrong.
    #[test]
    fn an_unlinked_provider_reports_where_to_go_and_does_not_blame_a_key() {
        let p = KeyProblem::NotLinked {
            provider: Provider::ElevenLabs,
            manage_url: manage_url(Provider::ElevenLabs, None),
        };
        assert_eq!(p.code(), "KEY_NOT_LINKED");
        assert!(p.manage_url().is_some(), "nowhere for the button to go");
        let m = p.message();
        assert!(m.contains("ElevenLabs"), "does not say which provider: {m}");
        for banned in ["paste", "Paste", "keychain", "enter your key"] {
            assert!(!m.contains(banned), "still offers a local key: {m}");
        }
    }

    /// Being offline must never be reported as a missing key. One is fixed by
    /// waiting, the other by visiting a dashboard, and telling somebody to go
    /// and re-add a key they already have is the wrong instruction.
    #[test]
    fn unreachable_is_not_confused_with_unlinked() {
        let p: KeyProblem = PlatformError::Unreachable("dns".into()).into();
        assert_eq!(p.code(), "KEYS_UNREACHABLE");
        assert!(p.manage_url().is_none(), "offered a dashboard trip for a network problem");
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
        let held = key_with(None, true);
        let status = ProviderStatus {
            provider: Provider::OpenAi.slug(),
            label: Provider::OpenAi.label(),
            linked: true,
            mode: held.mode,
            hint: held.hint(),
            manage_url: manage_url(Provider::OpenAi, Some(&held)),
            from_environment: false,
        };
        let json = serde_json::to_string(&status).expect("serialises");
        assert!(json.contains("1234"), "no way to recognise the key in use: {json}");
        assert!(!json.contains("sk-proj-abcd1234"), "the key reached the webview: {json}");
    }
}
