use std::path::PathBuf;

use flate2::{write::GzEncoder, Compression};
use hmac::{Hmac, Mac};
use quick_xml::de::from_str;
use reqwest::{Client, Method, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tar::Builder;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct Config {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub access_key: String,
    pub secret_key: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub last_started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_object: Option<String>,
    pub last_size_bytes: Option<u64>,
    pub error: Option<String>,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            last_started_at: None,
            last_finished_at: None,
            last_object: None,
            last_size_bytes: None,
            error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ListResult {
    #[serde(rename = "Contents", default)]
    contents: Vec<Object>,
}

#[derive(Debug, Deserialize)]
struct Object {
    #[serde(rename = "Key")]
    key: String,
}

pub async fn create_archive(source: PathBuf) -> Result<(Vec<u8>, u64), String> {
    tokio::task::spawn_blocking(move || {
        let mut compressed = Vec::new();
        {
            let encoder = GzEncoder::new(&mut compressed, Compression::fast());
            let mut archive = Builder::new(encoder);
            archive
                .append_dir_all("data", &source)
                .map_err(|e| format!("создание архива: {e}"))?;
            let encoder = archive
                .into_inner()
                .map_err(|e| format!("закрытие tar: {e}"))?;
            encoder
                .finish()
                .map_err(|e| format!("сжатие архива: {e}"))?;
        }
        let size = compressed.len() as u64;
        Ok((compressed, size))
    })
    .await
    .map_err(|e| format!("задача архива: {e}"))?
}

pub async fn upload_and_prune(
    client: &Client,
    config: &Config,
    archive: Vec<u8>,
    key: &str,
) -> Result<(), String> {
    let endpoint = config.endpoint.trim_end_matches('/');
    let path = format!("/{}/{}", encode(&config.bucket), encode_path(key));
    signed_request(client, config, Method::PUT, endpoint, &path, "", archive).await?;

    let query = format!("list-type=2&prefix={}", encode_query(&config.prefix));
    let list_path = format!("/{}/", encode(&config.bucket));
    let body = signed_request(
        client,
        config,
        Method::GET,
        endpoint,
        &list_path,
        &query,
        Vec::new(),
    )
    .await?;
    let parsed: ListResult =
        from_str(&String::from_utf8_lossy(&body)).map_err(|e| format!("ответ списка S3: {e}"))?;
    let mut keys: Vec<String> = parsed.contents.into_iter().map(|o| o.key).collect();
    keys.sort();
    if keys.len() > 7 {
        let remove_count = keys.len() - 7;
        for old in keys.into_iter().take(remove_count) {
            let old_path = format!("/{}/{}", encode(&config.bucket), encode_path(&old));
            signed_request(
                client,
                config,
                Method::DELETE,
                endpoint,
                &old_path,
                "",
                Vec::new(),
            )
            .await?;
        }
    }
    Ok(())
}

async fn signed_request(
    client: &Client,
    config: &Config,
    method: Method,
    endpoint: &str,
    path: &str,
    query: &str,
    body: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let url = Url::parse(&format!(
        "{}{}{}",
        endpoint,
        path,
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    ))
    .map_err(|e| format!("URL Object Storage: {e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "у S3 endpoint нет host".to_string())?
        .to_string();
    let now = time::OffsetDateTime::now_utc();
    let date = now
        .format(&time::format_description::parse_borrowed::<1>("[year][month][day]").unwrap())
        .unwrap();
    let timestamp = now
        .format(
            &time::format_description::parse_borrowed::<1>(
                "[year][month][day]T[hour][minute][second]Z",
            )
            .unwrap(),
        )
        .unwrap();
    let payload_hash = hex::encode(Sha256::digest(&body));
    let canonical_query = if query.is_empty() {
        String::new()
    } else {
        query.to_string()
    };
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, timestamp
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method, path, canonical_query, canonical_headers, signed_headers, payload_hash
    );
    let scope = format!("{}/{}/s3/aws4_request", date, config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        timestamp,
        scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signing_key = signing_key(&config.secret_key, &date, &config.region);
    let signature = hex::encode(hmac_bytes(&signing_key, string_to_sign.as_bytes()));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key, scope, signed_headers, signature
    );
    let mut request = client.request(method, url).body(body);
    request = request
        .header("Host", host)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", timestamp)
        .header("Authorization", authorization);
    let response = request
        .send()
        .await
        .map_err(|e| format!("запрос Object Storage: {e}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("ответ Object Storage: {e}"))?
        .to_vec();
    if !status.is_success() {
        return Err(format!(
            "Object Storage вернул {}: {}",
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    Ok(bytes)
}

fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_bytes(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_bytes(&k_date, region.as_bytes());
    let k_service = hmac_bytes(&k_region, b"s3");
    hmac_bytes(&k_service, b"aws4_request")
}

fn hmac_bytes(key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC принимает ключ любой длины");
    mac.update(value);
    mac.finalize().into_bytes().to_vec()
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn encode_path(value: &str) -> String {
    value.split('/').map(encode).collect::<Vec<_>>().join("/")
}

fn encode_query(value: &str) -> String {
    encode(value)
}
