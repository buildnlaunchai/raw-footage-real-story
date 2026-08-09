//! Thin HTTP client for a locally running Ollama server.
//!
//! This lives in Rust rather than the webview on purpose: the webview's origin
//! is `tauri://localhost`, which Ollama's CORS policy rejects. Going through a
//! Tauri command sidesteps CORS entirely and keeps the network call on the
//! native side, where the rest of the local pipeline (TTS, ffmpeg) will also run.
//!
//! It deliberately knows nothing about narration or scripts — it forwards a
//! prompt and returns text. Prompt construction and parsing live in the
//! frontend's `scriptGeneration` module so that stage can be swapped or
//! extended without touching Rust.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Errors are returned as a typed code plus a human-readable message so the UI
/// can show something actionable instead of a raw transport error.
#[derive(Debug, Serialize)]
pub struct OllamaError {
    pub code: String,
    pub message: String,
}

impl OllamaError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

#[derive(Deserialize)]
struct GenerateResponse {
    response: String,
}

/// Local generation can legitimately take a while on CPU; this only guards
/// against a wedged server, not against slow-but-working inference.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

#[tauri::command]
pub async fn ollama_generate(
    host: String,
    model: String,
    prompt: String,
    system: Option<String>,
    format: Option<serde_json::Value>,
    temperature: Option<f32>,
    seed: Option<i64>,
) -> Result<String, OllamaError> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| OllamaError::new("CLIENT_INIT", e.to_string()))?;

    let mut options = serde_json::Map::new();
    if let Some(t) = temperature {
        options.insert("temperature".into(), serde_json::json!(t));
    }
    if let Some(s) = seed {
        options.insert("seed".into(), serde_json::json!(s));
    }

    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": options,
    });
    if let Some(sys) = system {
        body["system"] = serde_json::json!(sys);
    }
    if let Some(fmt) = format {
        body["format"] = fmt;
    }

    let url = format!("{}/api/generate", host.trim_end_matches('/'));
    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_connect() {
            OllamaError::new(
                "OLLAMA_UNREACHABLE",
                format!("Could not reach Ollama at {host}."),
            )
        } else if e.is_timeout() {
            OllamaError::new("TIMEOUT", "Ollama took too long to respond.")
        } else {
            OllamaError::new("REQUEST_FAILED", e.to_string())
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        // Ollama answers 404 with a "model ... not found" body when the tag
        // has never been pulled — by far the most likely 404 here.
        let code = if status.as_u16() == 404 { "MODEL_NOT_FOUND" } else { "HTTP_ERROR" };
        return Err(OllamaError::new(
            code,
            format!("Ollama returned {status}: {}", detail.trim()),
        ));
    }

    let parsed: GenerateResponse = resp
        .json()
        .await
        .map_err(|e| OllamaError::new("BAD_RESPONSE", e.to_string()))?;

    Ok(parsed.response)
}

/// Used by the UI to tell "server down" apart from "model missing" before the
/// user waits through a generation.
#[tauri::command]
pub async fn ollama_health(host: String) -> Result<Vec<String>, OllamaError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| OllamaError::new("CLIENT_INIT", e.to_string()))?;

    let url = format!("{}/api/tags", host.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_connect() {
            OllamaError::new(
                "OLLAMA_UNREACHABLE",
                format!("Could not reach Ollama at {host}."),
            )
        } else {
            OllamaError::new("REQUEST_FAILED", e.to_string())
        }
    })?;

    #[derive(Deserialize)]
    struct Tag {
        name: String,
    }
    #[derive(Deserialize)]
    struct Tags {
        models: Vec<Tag>,
    }

    let tags: Tags = resp
        .json()
        .await
        .map_err(|e| OllamaError::new("BAD_RESPONSE", e.to_string()))?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "http://localhost:11434";
    const MODEL: &str = "qwen2.5:7b";

    /// The exact schema `src/lib/scriptGeneration.ts` sends.
    fn schema(count: usize) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "sentences": {
                    "type": "array",
                    "minItems": count,
                    "maxItems": count,
                    "items": { "type": "string" }
                }
            },
            "required": ["sentences"]
        })
    }

    #[tokio::test]
    async fn generates_one_sentence_per_clip() {
        let clips = [
            "Plane landing at sunrise, frost on the window",
            "Empty harbour, boats frozen in",
            "Black sand beach, big waves",
        ];
        let block: Vec<String> = clips
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{}. {c}", i + 1))
            .collect();

        let out = ollama_generate(
            HOST.into(),
            MODEL.into(),
            format!(
                "Clips:\n{}\n\nReturn JSON with a \"sentences\" array containing exactly {} \
                 narration sentences, one per clip, in order.",
                block.join("\n"),
                clips.len()
            ),
            Some(
                "You write concise documentary voiceover narration for travel footage. \
                 You write exactly one sentence per clip, in the order given. \
                 Each sentence describes only what that clip shows. \
                 Never invent details that are not in the description. \
                 Keep each sentence under 25 words and easy to read aloud."
                    .into(),
            ),
            Some(schema(clips.len())),
            Some(0.7),
            Some(42),
        )
        .await
        .expect("generation should succeed against a running Ollama");

        let parsed: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        let sentences = parsed["sentences"].as_array().expect("sentences array");
        assert_eq!(sentences.len(), clips.len(), "one sentence per clip");
        for s in sentences {
            assert!(!s.as_str().unwrap().trim().is_empty(), "no empty sentences");
        }
        println!("\n  generated {} sentences:", sentences.len());
        for (i, s) in sentences.iter().enumerate() {
            println!("    {}. {}", i + 1, s.as_str().unwrap());
        }
    }

    #[tokio::test]
    async fn missing_model_is_reported_as_model_not_found() {
        let err = ollama_generate(
            HOST.into(),
            "definitely-not-a-real-model:1b".into(),
            "hello".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("a missing model must be an error");
        assert_eq!(err.code, "MODEL_NOT_FOUND", "got: {err:?}");
        println!("\n  missing model -> {} / {}", err.code, err.message);
    }

    #[tokio::test]
    async fn unreachable_server_is_reported_as_unreachable() {
        // Nothing listens on this port; connect must fail fast and cleanly.
        let err = ollama_health("http://localhost:1".into())
            .await
            .expect_err("a dead server must be an error");
        assert_eq!(err.code, "OLLAMA_UNREACHABLE", "got: {err:?}");
        println!("\n  dead server -> {} / {}", err.code, err.message);
    }
}
