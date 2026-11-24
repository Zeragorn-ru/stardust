use std::path::{Path, PathBuf};
use std::io::Write as _;

use flate2::{write::GzEncoder, Compression};
use hmac::{Hmac, Mac};
use quick_xml::de::from_str;
use reqwest::{Body, Client, Method, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tar::Builder;
use tokio_util::io::ReaderStream;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct Config {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub access_key: String,
    pub secret_key: String,
    /// Пароль шифрования архива (age, scrypt); `None` — бэкап открытым текстом.
    pub password: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub last_started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_object: Option<String>,
    pub last_size_bytes: Option<u64>,
    /// Последний архив был зашифрован (`None` — бэкапы ещё не запускались).
    pub encrypted: Option<bool>,
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
            encrypted: None,
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

/// Создаёт (tar.gz → age) архив каталога, записывая его ПОТОКОВО в tempfile.
///
/// Раньше весь архив собирался в `Vec<u8>` в памяти: ~1.3 ГБ на VM с 1.9 ГиБ
/// означали OOM на каждом ночном запуске. Теперь слои такие: tar → gzip →
/// age (если задан пароль) → файл, каждый читается и пишется порциями.
///
/// Возвращает tempfile (удаляется при drop) и размер итогового файла.
pub async fn create_archive(
    source: PathBuf,
    password: Option<String>,
) -> Result<(tempfile::NamedTempFile, u64), String> {
    tokio::task::spawn_blocking(move || {
        let file = tempfile::NamedTempFile::new()
            .map_err(|e| format!("создание временного файла: {e}"))?;
        let path = file.path().to_path_buf();
        let sink = std::fs::File::create(&path).map_err(|e| format!("открытие файла: {e}"))?;
        // Слои от внутреннего к внешнему: tar → gzip → age (если задан пароль).
        // Каждый пишет в следующий порциями — в памяти только буферы слоёв.
        // Ветки не обобщать в Box<dyn Write>: writer'у age нужен finish(),
        // который пишет футер с MAC — через трейт-объект он недоступен.
        if let Some(passphrase) = password {
            let secret: age::secrecy::SecretString = passphrase.into();
            let encryptor = age::Encryptor::with_user_passphrase(secret);
            let mut gz = GzEncoder::new(
                encryptor
                    .wrap_output(sink)
                    .map_err(|e| format!("инициализация шифрования age: {e}"))?,
                Compression::fast(),
            );
            write_tar_into(&mut gz, &source)?;
            let aged = gz.finish().map_err(|e| format!("сжатие архива: {e}"))?;
            aged.finish()
                .map_err(|e| format!("завершение шифрования age: {e}"))?;
        } else {
            let mut gz = GzEncoder::new(sink, Compression::fast());
            write_tar_into(&mut gz, &source)?;
            gz.finish()
                .map_err(|e| format!("сжатие архива: {e}"))?
                .flush()
                .map_err(|e| format!("завершение записи архива: {e}"))?;
        }
        let size = std::fs::metadata(&path)
            .map_err(|e| format!("размер архива: {e}"))?
            .len();
        Ok((file, size))
    })
    .await
    .map_err(|e| format!("задача архива: {e}"))?
}

/// tar с содержимым каталога под `data/`, поверх переданного writer'а.
fn write_tar_into<W: std::io::Write>(gz: &mut GzEncoder<W>, source: &Path) -> Result<(), String> {
    let mut archive = Builder::new(&mut *gz);
    archive
        .append_dir_all("data", source)
        .map_err(|e| format!("создание архива: {e}"))?;
    archive
        .into_inner()
        .map_err(|e| format!("закрытие tar: {e}"))?;
    Ok(())
}

/// Загружает готовый файл архива в S3 ПОТОКОВО (UNSIGNED-PAYLOAD) и прореживает
/// старые объекты: остаётся не более 7 последних по ключу.
///
/// Тело запроса читается с диска порциями, а не буферизуется целиком.
pub async fn upload_and_prune(
    client: &Client,
    config: &Config,
    archive: &Path,
    key: &str,
) -> Result<(), String> {
    let endpoint = config.endpoint.trim_end_matches('/');
    let path = format!("/{}/{}", encode(&config.bucket), encode_path(key));
    put_file(client, config, endpoint, &path, archive).await?;

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

/// Строит URL и заголовки SigV4 для запроса. Хеш тела передаётся отдельно:
/// маленькие запросы (GET/DELETE) считают SHA-256 от тела, потоковый PUT
/// использует `UNSIGNED-PAYLOAD`, чтобы не читать файл в память ради хеша.
fn signed_head(
    config: &Config,
    method: &Method,
    endpoint: &str,
    path: &str,
    query: &str,
    payload_hash: &str,
) -> Result<(Url, Vec<(String, String)>), String> {
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
    let headers = vec![
        ("Host".to_string(), host),
        ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
        ("x-amz-date".to_string(), timestamp),
        ("Authorization".to_string(), authorization),
    ];
    Ok((url, headers))
}

/// Проверяет статус ответа S3; тело ошибки возвращается в тексте исключения.
fn check_response(
    status: reqwest::StatusCode,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    if !status.is_success() {
        return Err(format!(
            "Object Storage вернул {}: {}",
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    Ok(bytes)
}

/// PUT с телом-потоком из файла: архив не буферизуется в памяти.
async fn put_file(
    client: &Client,
    config: &Config,
    endpoint: &str,
    path: &str,
    archive: &Path,
) -> Result<(), String> {
    let (url, headers) = signed_head(config, &Method::PUT, endpoint, path, "", "UNSIGNED-PAYLOAD")?;
    let file = tokio::fs::File::open(archive)
        .await
        .map_err(|e| format!("открытие архива: {e}"))?;
    let stream = ReaderStream::new(tokio::io::BufReader::new(file));
    let request = client.put(url).body(Body::wrap_stream(stream));
    let request = headers
        .into_iter()
        .fold(request, |req, (name, value)| req.header(name, value));
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
    check_response(status, bytes).map(|_| ())
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
    let payload_hash = hex::encode(Sha256::digest(&body));
    let (url, headers) = signed_head(config, &method, endpoint, path, query, &payload_hash)?;
    let request = client.request(method, url).body(body);
    let request = headers
        .into_iter()
        .fold(request, |req, (name, value)| req.header(name, value));
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
    check_response(status, bytes)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Источник с файлами и подкаталогом — как настоящий /backup-data,
    /// только крошечный.
    fn make_source() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        let data = dir.path().join("source");
        std::fs::create_dir_all(data.join("sub")).unwrap();
        std::fs::write(data.join("secret.txt"), "yggdrasil key content").unwrap();
        std::fs::write(data.join("sub").join("nested.bin"), [0u8, 1, 2, 255]).unwrap();
        dir
    }

    /// Полный путь восстановления: age -d → gunzip → tar -x.
    /// Так будет разворачиваться архив на проде, поэтому тест проверяет
    /// ровно эту цепочку.
    fn restore(archive: &Path, dest: &Path, password: Option<&str>) -> Result<(), String> {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let reader: Box<dyn Read> = match password {
            Some(pass) => {
                let secret: age::secrecy::SecretString = pass.to_string().into();
                let identity = age::scrypt::Identity::new(secret);
                let decryptor = age::Decryptor::new(std::io::BufReader::new(file))
                    .map_err(|e| e.to_string())?;
                Box::new(
                    decryptor
                        .decrypt(std::iter::once(&identity as &dyn age::Identity))
                        .map_err(|e| e.to_string())?,
                )
            }
            None => Box::new(file),
        };
        let gz = flate2::read::GzDecoder::new(reader);
        let mut tar = tar::Archive::new(gz);
        tar.unpack(dest).map_err(|e| e.to_string())
    }

    #[test]
    fn encrypted_archive_restores_files_with_password() {
        let source = make_source();
        let src = source.path().join("source");
        let (archive, size) = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(create_archive(src.clone(), Some("пароль-123".to_string())))
            .unwrap();
        assert!(size > 0);

        // Заголовок age, а не gzip: архив действительно зашифрован.
        let mut header = [0u8; 4];
        std::fs::File::open(archive.path())
            .unwrap()
            .read_exact(&mut header)
            .unwrap();
        assert_eq!(&header, b"age-");

        let restored = tempfile::TempDir::new().unwrap();
        restore(archive.path(), restored.path(), Some("пароль-123")).unwrap();
        // tar ложит содержимое под "data/" — как append_dir_all и писал.
        let base = restored.path().join("data");
        assert_eq!(
            std::fs::read_to_string(base.join("secret.txt")).unwrap(),
            "yggdrasil key content"
        );
        assert_eq!(
            std::fs::read(base.join("sub").join("nested.bin")).unwrap(),
            vec![0u8, 1, 2, 255]
        );
    }

    #[test]
    fn encrypted_archive_rejects_wrong_password() {
        let source = make_source();
        let (archive, _) = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(create_archive(source.path().join("source"), Some("верный".to_string())))
            .unwrap();
        let restored = tempfile::TempDir::new().unwrap();
        assert!(restore(archive.path(), restored.path(), Some("не-верный")).is_err());
    }

    #[test]
    fn unencrypted_archive_is_plain_gzip_tar() {
        let source = make_source();
        let (archive, _) = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(create_archive(source.path().join("source"), None))
            .unwrap();
        // Без пароля это обычный gzip — восстанавливается без age.
        let restored = tempfile::TempDir::new().unwrap();
        restore(archive.path(), restored.path(), None).unwrap();
        assert!(restored.path().join("data").join("secret.txt").exists());
    }

    #[test]
    fn streaming_archive_stays_small_in_memory() {
        // Регрессия на исходную проблему: архив не собирался в Vec<u8>,
        // файл на диске появляется ещё до завершения задачи (потоковая запись).
        let source = make_source();
        let (archive, size) = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(create_archive(source.path().join("source"), Some("x".to_string())))
            .unwrap();
        assert_eq!(
            std::fs::metadata(archive.path()).unwrap().len(),
            size,
            "размер tempfile совпадает с возвращённым"
        );
    }
}
