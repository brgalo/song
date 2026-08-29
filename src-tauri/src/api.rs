//! HTTP-Client gegen songou-api.
//!
//! Jeder Aufruf traegt das Geraetetoken als Bearer. Die Identitaet leitet der
//! Server daraus ab; der Agent behauptet nirgends, wer er ist.

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct Api {
    base_url: String,
    token: String,
    client: reqwest::Client,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    pub known: bool,
    pub version_id: String,
}

#[derive(Deserialize, Debug)]
pub struct FeedVersion {
    pub filename: String,
    pub song_name: String,
    pub uploaded_by: String,
}

#[derive(Deserialize, Debug)]
pub struct FeedResponse {
    pub versions: Vec<FeedVersion>,
    pub now: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageResponse {
    pub bytes: u64,
    pub limit_bytes: u64,
}

#[derive(Deserialize, Debug)]
pub struct BootstrapResponse {
    pub identity: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareRequest<'a> {
    sha256: &'a str,
    filename: &'a str,
    song_name: &'a str,
    bytes: u64,
}

#[derive(Serialize)]
struct CompleteRequest {
    duration: f64,
    peaks: Vec<Vec<f32>>,
}

/// Fehler, die der Aufrufer unterscheiden muss.
#[derive(Debug)]
pub enum ApiError {
    /// Speicherlimit erreicht (HTTP 507). Kein Grund zum Wiederholen -
    /// erst muss jemand aufraeumen oder das Limit anheben.
    StorageLimit(String),
    /// Alles andere: Netzwerk, Serverfehler, ungueltige Antwort.
    Other(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::StorageLimit(m) | ApiError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(err: reqwest::Error) -> Self {
        ApiError::Other(err.to_string())
    }
}

type Result<T> = std::result::Result<T, ApiError>;

impl Api {
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            client: reqwest::Client::builder()
                // Ein haengender Upload darf den Watcher nicht dauerhaft
                // blockieren.
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .unwrap_or_default(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Wandelt eine Fehlerantwort in eine lesbare Meldung, statt nur den
    /// Statuscode zu melden - der Server schickt bereits deutschen Klartext.
    async fn check(response: reqwest::Response) -> Result<reqwest::Response> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or(body);

        if status.as_u16() == 507 {
            Err(ApiError::StorageLimit(message))
        } else {
            Err(ApiError::Other(format!("HTTP {status}: {message}")))
        }
    }

    pub async fn bootstrap(&self) -> Result<BootstrapResponse> {
        let res = self
            .client
            .get(self.url("/api/bootstrap"))
            .bearer_auth(&self.token)
            .send()
            .await?;
        Ok(Self::check(res).await?.json().await?)
    }

    pub async fn prepare(
        &self,
        sha256: &str,
        filename: &str,
        song_name: &str,
        bytes: u64,
    ) -> Result<PrepareResponse> {
        let res = self
            .client
            .post(self.url("/api/upload/prepare"))
            .bearer_auth(&self.token)
            .json(&PrepareRequest {
                sha256,
                filename,
                song_name,
                bytes,
            })
            .send()
            .await?;
        Ok(Self::check(res).await?.json().await?)
    }

    pub async fn upload_blob(&self, version_id: &str, bytes: Vec<u8>) -> Result<()> {
        let res = self
            .client
            .put(self.url(&format!("/api/upload/blob/{version_id}")))
            .bearer_auth(&self.token)
            .header("content-type", "audio/mpeg")
            .body(bytes)
            .send()
            .await?;
        Self::check(res).await?;
        Ok(())
    }

    pub async fn complete(
        &self,
        version_id: &str,
        duration: f64,
        peaks: Vec<Vec<f32>>,
    ) -> Result<()> {
        let res = self
            .client
            .post(self.url(&format!("/api/upload/complete/{version_id}")))
            .bearer_auth(&self.token)
            .json(&CompleteRequest { duration, peaks })
            .send()
            .await?;
        Self::check(res).await?;
        Ok(())
    }

    pub async fn feed(&self, since: &str) -> Result<FeedResponse> {
        let res = self
            .client
            .get(self.url("/api/feed"))
            .query(&[("since", since)])
            .bearer_auth(&self.token)
            .send()
            .await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// Beliebiger Aufruf, durchgereicht fuer die Oberflaeche. Sie kennt das
    /// Geraetetoken nicht - es bliebe sonst in den Entwicklerwerkzeugen
    /// sichtbar - und laesst deshalb Rust anfragen.
    pub async fn raw(&self, method: &str, path: &str, body: Option<String>) -> Result<String> {
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| ApiError::Other(format!("Unbekannte Methode {method}")))?;
        let mut builder = self
            .client
            .request(method, self.url(path))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            builder = builder
                .header("content-type", "application/json")
                .body(body);
        }
        Ok(Self::check(builder.send().await?).await?.text().await?)
    }

    /// Audio als Bytes - mit Token, der Bucket ist nicht oeffentlich.
    pub async fn audio(&self, version_id: &str) -> Result<Vec<u8>> {
        let res = self
            .client
            .get(self.url(&format!("/api/audio/{version_id}")))
            .bearer_auth(&self.token)
            .send()
            .await?;
        Ok(Self::check(res).await?.bytes().await?.to_vec())
    }

    pub async fn usage(&self) -> Result<UsageResponse> {
        let res = self
            .client
            .get(self.url("/api/usage"))
            .bearer_auth(&self.token)
            .send()
            .await?;
        Ok(Self::check(res).await?.json().await?)
    }
}
