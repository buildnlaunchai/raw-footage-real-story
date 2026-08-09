//! English grapheme-to-phoneme, deliberately without espeak-ng.
//!
//! espeak-ng is the usual G2P backend for Kokoro and it is GPL. Linking it into
//! a distributed app would put GPL obligations on the whole bundle, so this
//! module reaches the same place using permissively-licensed data only:
//!
//!   1. misaki `us_gold` lexicon  — Apache-2.0, already in Kokoro's IPA symbols
//!   2. regular suffix rules      — walked -> walk + d
//!   3. CMUdict                   — BSD-2-Clause, ARPAbet converted to IPA
//!
//! Measured at 100% coverage on a representative travel-narration paragraph,
//! where the lexicon alone left proper nouns (Reykjavik, Vik) unresolved.
//! Anything still unresolved is reported to the caller rather than silently
//! dropped, because a missing word in narration should be visible.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::resources;

#[derive(Debug, Serialize)]
pub struct Phonemization {
    pub phonemes: String,
    /// Words no lexicon could resolve. Surfaced in the UI as a warning.
    pub skipped: Vec<String>,
}

static MISAKI: OnceLock<HashMap<String, String>> = OnceLock::new();
static CMU: OnceLock<HashMap<String, String>> = OnceLock::new();

/// misaki entries are either a plain IPA string or a map keyed by part of
/// speech; without a POS tagger we take DEFAULT, which is what misaki itself
/// falls back to.
fn load_misaki() -> HashMap<String, String> {
    let path = resources::lexicon().join("us_gold.json");
    let Ok(raw) = std::fs::read(&path) else {
        return HashMap::new();
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return HashMap::new();
    };
    let Some(obj) = json.as_object() else {
        return HashMap::new();
    };

    let mut out = HashMap::with_capacity(obj.len());
    for (word, value) in obj {
        let ipa = match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Object(m) => m
                .get("DEFAULT")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            _ => None,
        };
        if let Some(ipa) = ipa {
            if !ipa.is_empty() {
                out.insert(word.to_lowercase(), ipa);
            }
        }
    }
    out
}

/// ARPAbet -> Kokoro IPA. A/I/O/W/Y are Kokoro's diphthong shorthands.
fn arpa_symbol(base: &str, stressed: bool) -> Option<&'static str> {
    Some(match base {
        "AA" => "ɑ",
        "AE" => "æ",
        "AH" => {
            return Some(if stressed { "ʌ" } else { "ə" });
        }
        "AO" => "ɔ",
        "AW" => "W",
        "AY" => "I",
        "B" => "b",
        "CH" => "ʧ",
        "D" => "d",
        "DH" => "ð",
        "EH" => "ɛ",
        "ER" => {
            return Some(if stressed { "ɜɹ" } else { "ɚ" });
        }
        "EY" => "A",
        "F" => "f",
        "G" => "ɡ",
        "HH" => "h",
        "IH" => "ɪ",
        "IY" => "i",
        "JH" => "ʤ",
        "K" => "k",
        "L" => "l",
        "M" => "m",
        "N" => "n",
        "NG" => "ŋ",
        "OW" => "O",
        "OY" => "Y",
        "P" => "p",
        "R" => "ɹ",
        "S" => "s",
        "SH" => "ʃ",
        "T" => "t",
        "TH" => "θ",
        "UH" => "ʊ",
        "UW" => "u",
        "V" => "v",
        "W" => "w",
        "Y" => "j",
        "Z" => "z",
        "ZH" => "ʒ",
        _ => return None,
    })
}

fn arpa_to_ipa(phones: &str) -> Option<String> {
    let mut out = String::new();
    for ph in phones.split_whitespace() {
        let (base, stress) = match ph.chars().last() {
            Some(c) if c.is_ascii_digit() => (&ph[..ph.len() - 1], c),
            _ => (ph, '0'),
        };
        let mark = match stress {
            '1' => "ˈ",
            '2' => "ˌ",
            _ => "",
        };
        out.push_str(mark);
        out.push_str(arpa_symbol(base, !mark.is_empty())?);
    }
    Some(out)
}

fn load_cmu() -> HashMap<String, String> {
    let path = resources::lexicon().join("cmudict.dict");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };

    let mut out = HashMap::new();
    for line in raw.lines() {
        if line.starts_with(";;;") {
            continue;
        }
        let Some((word, phones)) = line.split_once(' ') else {
            continue;
        };
        // "word(2)" marks an alternate pronunciation; keep only the first.
        if word.ends_with(')') {
            continue;
        }
        // Trailing "# comment" appears on some entries.
        let phones = phones.split('#').next().unwrap_or(phones).trim();
        if let Some(ipa) = arpa_to_ipa(phones) {
            out.entry(word.to_lowercase()).or_insert(ipa);
        }
    }
    out
}

fn misaki() -> &'static HashMap<String, String> {
    MISAKI.get_or_init(load_misaki)
}

fn cmu() -> &'static HashMap<String, String> {
    CMU.get_or_init(load_cmu)
}

/// Lexicon hit, then the regular English inflections misaki applies.
fn lookup(word: &str) -> Option<String> {
    let lex = misaki();
    if let Some(p) = lex.get(word) {
        return Some(p.clone());
    }

    const SUFFIXES: &[(&str, &str, &str)] = &[
        ("ed", "", "d"),
        ("ed", "e", "d"),
        ("s", "", "z"),
        ("ing", "", "ɪŋ"),
        ("ing", "e", "ɪŋ"),
    ];
    for (suffix, replacement, addition) in SUFFIXES {
        if let Some(stem) = word.strip_suffix(suffix) {
            let candidate = format!("{stem}{replacement}");
            if let Some(base) = lex.get(&candidate) {
                return Some(format!("{base}{addition}"));
            }
        }
    }

    cmu().get(word).cloned()
}

const SMALL: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/// Spell an integer so it can be looked up as ordinary words. Narration from an
/// LLM contains numbers often enough ("2019", "three days") that dropping them
/// would be worse than a slightly plain reading.
fn number_to_words(n: u64) -> Vec<String> {
    if n < 20 {
        return vec![SMALL[n as usize].to_string()];
    }
    if n < 100 {
        let mut out = vec![TENS[(n / 10) as usize].to_string()];
        if n % 10 != 0 {
            out.push(SMALL[(n % 10) as usize].to_string());
        }
        return out;
    }
    if n < 1000 {
        let mut out = vec![SMALL[(n / 100) as usize].to_string(), "hundred".into()];
        if n % 100 != 0 {
            out.extend(number_to_words(n % 100));
        }
        return out;
    }
    if n < 1_000_000 {
        let mut out = number_to_words(n / 1000);
        out.push("thousand".into());
        if n % 1000 != 0 {
            out.extend(number_to_words(n % 1000));
        }
        return out;
    }
    let mut out = number_to_words(n / 1_000_000);
    out.push("million".into());
    if n % 1_000_000 != 0 {
        out.extend(number_to_words(n % 1_000_000));
    }
    out
}

/// Punctuation Kokoro understands; anything else is dropped rather than
/// becoming an unknown token.
fn punctuation(c: char) -> Option<char> {
    match c {
        ',' | '.' | '!' | '?' | ';' | ':' | '(' | ')' => Some(c),
        '—' | '–' | '-' => Some('—'),
        '…' => Some('…'),
        '"' | '“' | '”' => Some('"'),
        _ => None,
    }
}

/// Convert English text to a Kokoro IPA phoneme string.
pub fn text_to_phonemes(text: &str) -> Phonemization {
    let mut phonemes = String::new();
    let mut skipped = Vec::new();

    // Split into word / number / punctuation tokens.
    let mut token = String::new();
    let mut pending: Vec<String> = Vec::new();

    let flush = |token: &mut String, pending: &mut Vec<String>| {
        if !token.is_empty() {
            pending.push(std::mem::take(token));
        }
    };

    let mut tokens: Vec<Result<String, char>> = Vec::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '\'' {
            token.push(ch);
        } else {
            flush(&mut token, &mut pending);
            for w in pending.drain(..) {
                tokens.push(Ok(w));
            }
            if let Some(p) = punctuation(ch) {
                tokens.push(Err(p));
            } else if ch.is_whitespace() {
                tokens.push(Err(' '));
            }
        }
    }
    flush(&mut token, &mut pending);
    for w in pending.drain(..) {
        tokens.push(Ok(w));
    }

    for tok in tokens {
        match tok {
            Err(p) => {
                // Collapse runs of whitespace.
                if p == ' ' && phonemes.ends_with(' ') {
                    continue;
                }
                phonemes.push(p);
            }
            Ok(word) => {
                let lower = word.to_lowercase();
                let words: Vec<String> = if lower.chars().all(|c| c.is_ascii_digit()) {
                    match lower.parse::<u64>() {
                        Ok(n) if n < 1_000_000_000 => number_to_words(n),
                        _ => vec![lower.clone()],
                    }
                } else {
                    vec![lower.clone()]
                };

                for (i, w) in words.iter().enumerate() {
                    if i > 0 {
                        phonemes.push(' ');
                    }
                    match lookup(w) {
                        Some(p) => phonemes.push_str(&p),
                        None => {
                            if !skipped.contains(&word) {
                                skipped.push(word.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // Kokoro is sensitive to a trailing boundary; give it one if absent.
    let trimmed = phonemes.trim().to_string();
    let phonemes = if trimmed.is_empty()
        || trimmed.ends_with(['.', '!', '?', ',', ';', ':'])
    {
        trimmed
    } else {
        format!("{trimmed}.")
    };

    Phonemization { phonemes, skipped }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexicons_load() {
        assert!(misaki().len() > 80_000, "misaki lexicon: {}", misaki().len());
        assert!(cmu().len() > 100_000, "cmudict: {}", cmu().len());
        println!("\n  misaki: {} entries", misaki().len());
        println!("  cmudict: {} entries", cmu().len());
    }

    #[test]
    fn covers_the_measured_paragraph_completely() {
        let text = "We landed in Reykjavik just after sunrise. The harbour was still frozen, \
                    and the light came in low across the water. We hiked out to the black sand \
                    beach and watched the waves break for an hour. Later we drove south toward \
                    Vik, stopping wherever the road looked interesting. By evening the sky had \
                    turned a deep orange over the glacier, and nobody said very much.";
        let result = text_to_phonemes(text);
        println!("\n  skipped: {:?}", result.skipped);
        println!("  phonemes: {}…", &result.phonemes[..80.min(result.phonemes.len())]);
        assert!(
            result.skipped.is_empty(),
            "expected full coverage, missing: {:?}",
            result.skipped
        );
        assert!(!result.phonemes.is_empty());
    }

    #[test]
    fn resolves_via_each_tier() {
        // misaki direct
        assert!(lookup("harbour").is_some(), "misaki tier");
        // suffix rule — 'hiked' is absent from misaki, 'hike' is present
        assert!(lookup("hiked").is_some(), "suffix tier");
        // cmudict fallback — proper noun absent from misaki
        assert!(lookup("reykjavik").is_some(), "cmudict tier");
    }

    #[test]
    fn expands_numbers() {
        assert_eq!(number_to_words(7).join(" "), "seven");
        assert_eq!(number_to_words(21).join(" "), "twenty one");
        assert_eq!(number_to_words(2019).join(" "), "two thousand nineteen");
        let r = text_to_phonemes("We stayed 3 days.");
        assert!(r.skipped.is_empty(), "numbers should resolve: {:?}", r.skipped);
    }

    #[test]
    fn reports_unresolvable_words_instead_of_dropping_silently() {
        let r = text_to_phonemes("We visited Zzyzxqqq today.");
        assert_eq!(r.skipped, vec!["Zzyzxqqq"], "should report the nonsense word");
        assert!(!r.phonemes.is_empty(), "rest of sentence still phonemised");
    }

    #[test]
    fn keeps_punctuation_kokoro_understands() {
        let r = text_to_phonemes("Wait, really?");
        assert!(r.phonemes.contains(','), "comma preserved: {}", r.phonemes);
        assert!(r.phonemes.ends_with('?'), "question mark preserved: {}", r.phonemes);
    }
}
