//! The last licence answer, kept somewhere it outlives the window.
//!
//! Without this the month-long grace in `entitlement.ts` cannot happen at all:
//! the gate's cache was React state, so quitting the app forgot every check
//! ever made, and the next offline launch had nothing to fall back to and
//! blocked. Everything below exists to make "the platform said yes on the
//! third" a thing this machine can still know on the twelfth, on a plane.
//!
//! ## Why a plain file, and not the keychain
//!
//! The session's refresh token is in the keychain because it is a *secret* —
//! anyone holding it can act as that person. A licence token is the opposite:
//! it is a signed public statement about an account, useless to anybody it is
//! not about, and its worth comes from being unforgeable rather than from
//! being unread. Confidentiality would buy nothing.
//!
//! It would cost something, though. A keychain item is bound to the code
//! signature of the app that made it, so a second item means a second
//! permission prompt after every rebuild, for a file whose entire contents the
//! platform would happily print on a web page.
//!
//! ## What is stored is the token, not the answer
//!
//! `{"active": true}` in a file is a suggestion — the person it gates can
//! open it in a text editor. So what is written down is the platform's signed
//! token, exactly as it arrived, and the *answer is recomputed from it* on
//! every launch by [`recall`]. Editing the file does not change what the app
//! believes; it only breaks the signature and throws the grace away.
//!
//! Even the date works this way. A grace period counted from a timestamp in
//! the file could be extended for ever by touching one field, so it is counted
//! from the token's signed `iat` — see [`crate::licence::Verified::issued_at`]
//! — and the file's own `checkedAt` is a fallback for a platform that does not
//! send one, plus something legible when somebody opens the file to see what
//! is in it.
//!
//! ## The cross-check, and what it is honestly worth
//!
//! [`recall`] refuses a token whose `sub` is not the account signed in on this
//! machine. That is what stops the obvious sharing move: a subscriber sends a
//! friend their cache file, the friend signs in as themselves, and the licence
//! in the file is visibly about somebody else.
//!
//! It is not a lock, and `entitlement.ts` is already clear about why nothing
//! here can be. Somebody willing to hand-write their own keychain entry can
//! put another person's user id next to a refresh token that is not theirs,
//! and offline nothing catches it — offline there is no access token to check
//! against, because getting one needs the network this whole path exists to do
//! without. The moment they have a connection the refresh is refused and the
//! session is cleared. Thirty days of inconvenient, detectable cheating is the
//! ceiling, and buying it down further would cost the people who paid.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Beside `settings.json` in the app's own data directory.
const FILE: &str = "licence.json";

/// What is written down after a check the signature was actually checked on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cached {
    /// The platform's signed token, byte for byte as it arrived. Re-verified
    /// on every read; never trusted for having been in a file this app wrote.
    pub licence_token: String,
    /// The platform's clock at the moment of that check, ISO-8601.
    ///
    /// A fallback and a courtesy, not evidence: used to date the cache only
    /// when the token carries no `iat`, and readable by anyone wondering what
    /// this file is.
    pub checked_at: String,
}

/// A stored answer that survived being checked.
#[derive(Debug, Clone, PartialEq)]
pub struct Recalled {
    pub active: bool,
    /// ISO-8601, from the token's signed `iat` where there is one.
    pub checked_at: String,
    /// Why the platform said no, in its own word, out of the signed claims.
    ///
    /// This is what stops a suspended account being told the wrong thing on a
    /// plane. The reason is in the token, so it is as unforgeable as the
    /// entitlement beside it, and reading it here means an offline launch
    /// reaches the same screen a live check would.
    pub reason: Option<String>,
    /// When the membership ended, if the platform signed the date in too.
    pub expires_at: Option<String>,
}

/// Decide what a stored answer is worth to the account signed in right now.
///
/// `None` covers every way a cache can be worthless — forged, edited, signed
/// by a key this build does not know, or about somebody else — because they
/// all lead to the same place: ask the platform again. The caller deletes the
/// file rather than carrying a cache that will fail identically next launch.
///
/// Split from the file handling so the rules can be argued with in tests
/// without a disk.
pub fn recall(stored: &Cached, user_id: &str, pem: &str) -> Option<Recalled> {
    let v = crate::licence::verify_cached_with(&stored.licence_token, pem).ok()?;
    // An empty `user_id` fails this, which is the intended answer: with
    // nobody established as signed in, there is nothing for the licence to be
    // *about*, and a cache that matches everyone is a cache that matches a
    // copied file.
    if !v.matches(user_id) {
        return None;
    }
    // `entitled` already folds in the reason — see `LicenceClaims::entitled`
    // — so a token that says "suspended" while claiming `active: true` comes
    // back as a refusal here without this function having to know why.
    Some(Recalled {
        active: v.entitled(),
        checked_at: v
            .issued_at()
            .map(crate::platform::iso_from_epoch)
            .unwrap_or_else(|| stored.checked_at.clone()),
        reason: v.claims().reason.clone(),
        expires_at: v.claims().expires_at.clone(),
    })
}

/// Write the answer down. Errors are the caller's to decide about: failing to
/// cache is a worse offline experience later, never a failed check now.
pub fn store(dir: &Path, c: &Cached) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(c).map_err(std::io::Error::other)?;
    std::fs::write(dir.join(FILE), json)
}

/// Read whatever is there. A missing or unreadable file is "nothing cached",
/// which is a state the gate already knows how to be in.
pub fn load(dir: &Path) -> Option<Cached> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).ok()?).ok()
}

/// Throw it away. Signing out, and any cache that failed to recall.
pub fn forget(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same throwaway key the licence fixtures are signed with.
    const TEST_PUBLIC: &str = include_str!("../keys/testing-only.pub.pem");

    /// `sub: u-1`, `status: active`, `iat` 2026-01-01, expiring in 2100.
    const VALID: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzIjoiYnVpbGRubGF1bmNoYWkiLCJzdGF0dXMiOiJhY3RpdmUiLCJwbGFuIjoicHJvIn0.Km_EqfNNNw7_G93eTo-EmmrI5oVAl0Jhoj-4IR5AlWzmXt-Rozj7Q0O1cF2DMd21gT6FdEdYoOdRv7PvK49s2NwRNiE5uoRdP5TiQCJkVFo4HQ8f45Onr1GLbT6vfk9cEdOaAdkYbz2Ar0eoz7kJCObJ3CksRG-2jpkudBL_4i9rMMQrCpnyAzsR6Gbku8FRI0q4oW8_rdq1w9UnKbgwCH5jKWzZ9dpSzwRLWqxBayEtFHoOcUlWUNMnaya7Mm6Jlv1S92Z_d_487DDzZVB0WWRWEXXF3L0N4DRz1Jwznd3z4MPrE0nvew6Y2p0EcRfJnPfKXueyE_OEuxLdT9Fbig";
    /// Genuinely signed, `active: true`, and expired since 2020.
    const EXPIRED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE1Nzc3NTA0MDAsImV4cCI6MTU3NzgzNjgwMCwiYWN0aXZlIjp0cnVlfQ.rEhjTvVtvoyxc-JdvHOmUzBwFWil77IAsvNgx9Z3haZ2Vg2hZHKtMlhOsTsAtbYfmcy7YDokYsUYlihScpV4NEgUVzxIf_qa75KS3fFOpQcu90upPPUSvry6mpqaOTB1I15BFqES6khD4QQhcSvvCOdAwa143tXgVnq57ytKxudLlJ1RjvMXokBt2W3_tRjmYsmFhxBuc_Ur0vu3Z6mbznhHo94YHbIBeJRpk9uj-9wcVTOEmngey4XAJgV4mQL8susNCvKaFXDr_fobm0acs9bAz-6k6jZl0oXaMVjErL7SXy5kkPYXVrFjK_ts4d8pOfbTDN6nVT5l8i0-aJCJ-g";
    /// A real licence, for `u-other`.
    const OTHER: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LW90aGVyIiwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjQxMDI0NDQ4MDAsImFjdGl2ZSI6dHJ1ZX0.tuts1gorXg9WJx6DEnQ30hGEBa-gvl47sWOxqEpFi_FaST4XRhtNSlXDnGe1-2sF2T402Yz9vlfzrUsDZxyVwP4GBcj-FzqaY2nXuMiN-zzmKg6INavYVzSBu6PjFK3xwENZnGCbVziZvwQNSyv7IsKk0f0ibAZst7J5rbDawBvKCGnPSezFRd8vsYFpkgkJHfHkrqxdG7NHdEjnYQrNkjFhmjUeKYfByO8KjT7I1kQf_zYwEtyayDL3KoM-BFAUc9X-iesTwO2NDcL5Wpuxknb6yfK1oVPE_iXPUiPsjsnEvZEU3mzQu2GXRb5_9rAwgxsKTJfJeowZmI8RIXxFsw";

    /// `reason: suspended`, with `active: true` still beside it in the same
    /// signed payload. The reason has to win, offline as well as online.
    const SUSPENDED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjp0cnVlLCJzdGF0dXMiOiJhY3RpdmUiLCJyZWFzb24iOiJzdXNwZW5kZWQifQ.rhgf604dz7TrvxQOwNLyuL0DkSsTywhNWgwplW-RgSPlCIrksgNwfUFHrCEOLcm2DpmVX8_LuKHiy3IMNgqpynhpPWQ-wl902oerlEZ_kIctzF4KssSd2P8MU7SD9_srYanDMX7PY9NUyrJV1ZlCgcLjBNNzTjMkxpeWKqJ-dZJtYZW3VJYRHr0UQluPokLJqLR57Ni2PSj5UglPeWCtBCqG0-5cQdH3HpFA82rL1wH6vwhYPmij9YB22mFoeqpLx96e7pjPEQmFxAGRsIgjqfRukK19Xbzi9czx18D3lQMvOwq57DRxcp-01T7aYBPPXkRcp3FlsgNzVYmdSRN_kg";
    /// `reason: membership_inactive`, carrying the date it lapsed.
    const ENDED: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjpmYWxzZSwic3RhdHVzIjoiY2FuY2VsZWQiLCJyZWFzb24iOiJtZW1iZXJzaGlwX2luYWN0aXZlIiwiZXhwaXJlc19hdCI6IjIwMjYtMDctMDFUMDA6MDA6MDBaIn0.svbI-2UohdIyBOnGL7e882rBV6Q8y7auPIMpJ3t4Y5H_hXRU9WfOIrm5dSArxYQ6KBU2APQE6q1RwIUEym2XnNHrwwkQpOJQUdFvsI8AdVnoNG93OYf8Uh3FfxZujddp66z0sy0TKzm-NEUb_64egin42EhLnejbmqeenAWirKulbZvvANO3WDAki4REofeZ8QhofsJF_rCqlvlme8BJMdg_ibrv3xJyCzjpS-OfeU2bCBvJTZ9AK1I6oed8JrzXgyKjo41gsnfqplqBMxwHero0DgWd-IsvLzqp7k9puwX6cRZMr34waHMa2XdfrhedmuA7Ne4Ol0DVCZ11pYSu7Q";
    /// A word this build has never been taught, on an entitled account.
    const ODD_REASON: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6NDEwMjQ0NDgwMCwiYWN0aXZlIjp0cnVlLCJyZWFzb24iOiJncmFjZV9wZXJpb2QifQ.bVRnPwClzgzhPFy6D5I-DDJT7F5UHlVAECMeBc9sbQnwJgszkM7_tlE9mCq_SIgM3-vnpwmEoN-hQWhh35vmjca4XE-o9hEQWOi7spAnx4XuGemW52ovL8dultmmILyx0jO22MISyt8iiS9wecvNvENGm3XAxA_PGl6utXeAa_GEa_M1TEKs4ISbTi9BzKzv15QT80JzGTNSSdYrZQVmQTfbzLEIQ9o1A7KYtaSjyJKP5rHz-O8-BslUTp-vgcoLDAdcY5Ln-d09Rz8yVyg0SwxQYyyMopoWhixRGP4RXbo9InuANQxMwXZmPkI7QMtRQf23nBcuz5z9Lv6a6iDoFw";

    fn cached(token: &str) -> Cached {
        Cached { licence_token: token.into(), checked_at: "2026-08-18T09:00:00Z".into() }
    }

    /// A scratch directory of this test's own. No `tempfile` dependency for
    /// four tests, and named after the test so a leftover is traceable.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rfrs-licence-cache-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_cached_licence_comes_back_dated_by_its_signature_not_by_the_file() {
        // The file claims the check happened in 2099. The token says 2026,
        // and the token is the half nobody can edit.
        let mut c = cached(VALID);
        c.checked_at = "2099-01-01T00:00:00Z".into();
        let r = recall(&c, "u-1", TEST_PUBLIC).expect("recalls");
        assert!(r.active);
        assert_eq!(r.checked_at, "2026-01-01T00:00:00Z", "the file's date was believed over the signature's");
    }

    /// The grace period's whole point: an answer older than the token's own
    /// expiry is still the answer the platform gave.
    #[test]
    fn an_expired_token_still_dates_and_answers_a_cache() {
        let r = recall(&cached(EXPIRED), "u-1", TEST_PUBLIC).expect("recalls");
        assert!(r.active);
        assert_eq!(r.checked_at, "2019-12-31T00:00:00Z");
    }

    /// Every way a cache can be worth nothing arrives as the same answer,
    /// because there is only one thing to do about any of them.
    #[test]
    fn a_cache_that_is_not_this_accounts_is_worth_nothing() {
        // Somebody else's, which is the file-sharing case.
        assert_eq!(recall(&cached(OTHER), "u-1", TEST_PUBLIC), None);
        // Nobody signed in — a cache must not answer for an empty account.
        assert_eq!(recall(&cached(VALID), "", TEST_PUBLIC), None);
        // Edited on disk.
        let mut broken = cached(VALID);
        broken.licence_token = VALID.replace("dWIiOiJ1LTEi", "dWIiOiJ1LTIi");
        assert_eq!(recall(&broken, "u-1", TEST_PUBLIC), None);
        // Not a token at all.
        assert_eq!(recall(&cached("nonsense"), "u-1", TEST_PUBLIC), None);
        // A build with no key cannot read a cache, and says nothing rather
        // than guessing.
        assert_eq!(recall(&cached(VALID), "u-1", "not a pem"), None);
    }

    // ── the gap this used to have ──────────────────────────────────────────
    //
    // The cache is the signed token and nothing else, so for as long as the
    // claims could not say *why* an account was refused, a suspension could
    // not survive a restart: the app went offline knowing only "not entitled"
    // and fell back to the generic billing screen — the one message that is
    // actively wrong for somebody who was barred, because it points them at a
    // page that will take their money and change nothing. The platform signs
    // `reason` into the claims now, and these pin that it is read.

    #[test]
    fn a_suspension_survives_going_offline() {
        let r = recall(&cached(SUSPENDED), "u-1", TEST_PUBLIC).expect("recalls");
        assert!(!r.active, "a suspended token granted access offline");
        assert_eq!(
            r.reason.as_deref(),
            Some("suspended"),
            "offline, a suspension degraded to the generic no-subscription screen"
        );
    }

    #[test]
    fn a_lapsed_membership_comes_back_with_the_date_it_lapsed() {
        let r = recall(&cached(ENDED), "u-1", TEST_PUBLIC).expect("recalls");
        assert!(!r.active);
        assert_eq!(r.reason.as_deref(), Some("membership_inactive"));
        assert_eq!(r.expires_at.as_deref(), Some("2026-07-01T00:00:00Z"));
    }

    /// The direction that costs money to get wrong. A cached token carrying a
    /// word this build has never seen must still let a paying customer in.
    #[test]
    fn an_unrecognised_reason_does_not_refuse_a_cached_licence() {
        let r = recall(&cached(ODD_REASON), "u-1", TEST_PUBLIC).expect("recalls");
        assert!(r.active, "an unknown reason locked a paying account out offline");
        assert_eq!(r.reason.as_deref(), Some("grace_period"), "the word is still carried");
    }

    /// An ordinary yes says nothing about why, and must not invent one.
    #[test]
    fn an_entitled_cache_carries_no_reason_at_all() {
        let r = recall(&cached(VALID), "u-1", TEST_PUBLIC).expect("recalls");
        assert!(r.active);
        assert_eq!(r.reason, None);
        assert_eq!(r.expires_at, None);
    }

    #[test]
    fn what_is_written_is_what_comes_back_and_forgetting_means_forgotten() {
        let dir = scratch("round-trip");
        assert_eq!(load(&dir), None, "an empty directory is not a cached licence");

        let c = cached(VALID);
        store(&dir, &c).expect("stores");
        assert_eq!(load(&dir).as_ref(), Some(&c));

        forget(&dir);
        assert_eq!(load(&dir), None, "signing out left the licence behind");
        // Forgetting what is already gone is not an error worth having.
        forget(&dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The file is written for a person to read, and holds nothing secret.
    #[test]
    fn the_file_holds_a_signed_statement_and_no_credential() {
        let dir = scratch("contents");
        store(&dir, &cached(VALID)).expect("stores");
        let raw = std::fs::read_to_string(dir.join(FILE)).expect("reads");

        assert!(raw.contains("licenceToken"), "the signed half is the point: {raw}");
        assert!(!raw.contains("refresh"), "a refresh token has no business here: {raw}");
        assert!(!raw.contains("access"), "an access token has no business here: {raw}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
