// Самообновление лаунчера через GitHub Releases.
//
// Вместо встроенного tauri-plugin-updater (который требует подписывать
// артефакты приватным ключом) лаунчер сам опрашивает GitHub Releases API,
// сравнивает версию и при наличии новой скачивает установщик NSIS
// (`*-setup.exe`) и запускает его. Транспортная безопасность обеспечивается
// HTTPS GitHub. Целостность установщика проверяется через SHA-256 (файл
// `*.sha256` рядом с установщиком в релизе).
//
// URL релизного API можно переопределить переменной `LAUNCHER_UPDATE_URL`
// (как `LAUNCHER_AUTH_URL` для auth-сервера). Она должна указывать на JSON
// одного релиза GitHub Releases API (.../releases/latest).

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Эндпоинт GitHub Releases API по умолчанию.
const RELEASES_API: &str = "https://api.github.com/repos/Zeragorn-ru/stardust/releases/latest";

/// User-Agent обязателен для запросов к GitHub API.
const USER_AGENT: &str = "stardust-launcher-updater";

/// Результат проверки обновлений для фронтенда.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    /// Доступна ли новая версия.
    pub available: bool,
    /// Текущая версия лаунчера.
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    /// Версия обновления (если доступно).
    pub version: Option<String>,
    /// Заметки к релизу (если есть).
    pub notes: Option<String>,
}

/// Минимально необходимые поля релиза из ответа GitHub API.
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Прикреплённый к релизу файл.
#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// URL релизного API с учётом переопределения через окружение.
fn api_url() -> String {
    std::env::var("LAUNCHER_UPDATE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RELEASES_API.to_string())
}

/// HTTP-клиент с корректным User-Agent для GitHub API.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .proxy(reqwest::Proxy::all("http://assets.zeragorn.xyz:3128").map_err(|e| e.to_string())?)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Загружает данные о последнем релизе.
async fn fetch_latest() -> Result<GhRelease, String> {
    let resp = http_client()?
        .get(api_url())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Не удалось получить данные о релизе: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API ответил статусом {}", resp.status()));
    }

    resp.json::<GhRelease>()
        .await
        .map_err(|e| format!("Не удалось разобрать ответ GitHub: {e}"))
}

/// Убирает ведущий `v`/`V` и пробелы из строки версии.
fn normalize(v: &str) -> &str {
    v.trim().trim_start_matches(['v', 'V'])
}

/// Возвращает true, если `latest` строго новее `current`.
/// Сравнение покомпонентно по числам, разделённым точками (semver-подобно).
/// Суффиксы `-rc1`, `-beta` и т.п. игнорируются — `1.2.0-rc1` считается равным `1.2.0`.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        normalize(s)
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let a = parse(latest);
    let b = parse(current);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Выбирает подходящий установщик для текущей платформы.
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    #[cfg(target_os = "windows")]
    {
        assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with("-setup.exe"))
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_lowercase().ends_with(".msi"))
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        assets.iter().find(|a| {
            let n = a.name.to_lowercase();
            n.ends_with(".appimage") || n.ends_with(".dmg")
        })
    }
}

/// Ищет SHA-256 хеш для given installer name в ассетах релиза.
/// Ожидает файл `*.sha256` с содержимым вида `<hex>\n` или `<hex>  <filename>\n`.
fn find_sha256_asset<'a>(assets: &'a [GhAsset], installer_name: &str) -> Option<&'a GhAsset> {
    let sha256_name = format!("{installer_name}.sha256");
    assets.iter().find(|a| a.name == sha256_name)
}

/// Скачивает и парсит содержимое .sha256 файла, возвращая hex-строку хеша.
async fn fetch_expected_sha256(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let text = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать .sha256: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ошибка скачивания .sha256: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Не удалось прочитать .sha256: {e}"))?;

    // Формат: `<64 hex chars>` или `<64 hex chars>  <filename>` (coreutils sha256sum).
    let hex = text
        .split_whitespace()
        .next()
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|h| h.to_lowercase())
        .ok_or_else(|| format!("Некорректный формат .sha256: {text}"))?;
    Ok(hex)
}

/// Вычисляет SHA-256 файла и возвращает hex-строку.
fn compute_sha256(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Не удалось открыть файл для SHA-256: {e}"))?;
    let mut hasher = Sha256Hasher::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize_hex())
}

/// Минимальная реализация SHA-256 без внешних зависимостей.
/// Использует оптимизированный алгоритм FIPS 180-4.
struct Sha256Hasher {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Sha256Hasher {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        let mut i = 0;
        self.total_len += data.len() as u64;

        if self.buf_len > 0 {
            while i < data.len() && self.buf_len < 64 {
                self.buf[self.buf_len] = data[i];
                self.buf_len += 1;
                i += 1;
            }
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }

        while i + 64 <= data.len() {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[i..i + 64]);
            self.compress(&block);
            i += 64;
        }

        while i < data.len() {
            self.buf[self.buf_len] = data[i];
            self.buf_len += 1;
            i += 1;
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..(i + 1) * 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.total_len * 8;
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;

        if self.buf_len > 56 {
            while self.buf_len < 64 {
                self.buf[self.buf_len] = 0;
                self.buf_len += 1;
            }
            let block = self.buf;
            self.compress(&block);
            self.buf_len = 0;
            self.buf = [0u8; 64];
        }

        while self.buf_len < 56 {
            self.buf[self.buf_len] = 0;
            self.buf_len += 1;
        }

        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        self.compress(&block);

        let mut hex = String::with_capacity(64);
        for &word in &self.state {
            hex.push_str(&format!("{:08x}", word));
        }
        hex
    }
}

/// Безопасно извлекает basename файла, отвергая пути с traversal.
fn sanitize_filename(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Имя файла пустое".into());
    }
    if name.contains(['/', '\\']) || name == ".." || name.starts_with("..") || name.contains("..") {
        return Err(format!("Подозрительное имя файла: {name}"));
    }
    // Дополнительно: берём только последний компонент (на случай строковых артефактов).
    let basename = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Некорректное имя файла: {name}"))?;
    Ok(basename.to_string())
}

/// Запускает скачанный установщик в тихом режиме. На прочих платформах не поддержано.
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(path)
            // NSIS: полностью тихая установка без мастера и выбора удаления данных.
            // В hooks.nsh для silent-деинсталляции задан /SD IDNO, поэтому AppData сохраняется.
            .arg("/S")
            .spawn()
            .map_err(|e| format!("Не удалось запустить установщик: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Автоустановка поддерживается только на Windows".into())
    }
}

/// Проверить наличие обновления, ничего не устанавливая.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let release = fetch_latest().await?;
    let latest = normalize(&release.tag_name).to_string();

    if is_newer(&latest, &current_version) {
        Ok(UpdateInfo {
            available: true,
            current_version,
            version: Some(latest),
            notes: release.body,
        })
    } else {
        Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
        })
    }
}

/// Скачать доступное обновление и запустить установщик, затем закрыть лаунчер.
///
/// Прогресс скачивания эмитится событием `launcher://update-progress`
/// с долей 0..1 (или null, если общий размер неизвестен).
///
/// Целостность проверяется через SHA-256 файл рядом с установщиком в релизе.
/// Если .sha256 файл недоступен — выводится предупреждение, но установка продолжается.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use std::io::Write;
    use tauri::Emitter;

    let release = fetch_latest().await?;
    let asset = pick_asset(&release.assets)
        .ok_or_else(|| "В релизе нет подходящего установщика".to_string())?;

    // Санитизация имени файла: только basename, отвергаем traversal.
    let safe_name = sanitize_filename(&asset.name)?;
    let path = std::env::temp_dir().join(&safe_name);

    let mut resp = http_client()?
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать обновление: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Загрузка вернула статус {}", resp.status()));
    }

    let total = resp.content_length();
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Не удалось создать файл обновления: {e}"))?;

    let mut downloaded: u64 = 0;
    let _ = app.emit("launcher://update-progress", Some(0.0));
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let fraction = total.map(|t| {
            if t > 0 {
                downloaded as f64 / t as f64
            } else {
                0.0
            }
        });
        let _ = app.emit("launcher://update-progress", fraction);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    // Верификация размера.
    if let Some(cl) = total {
        if downloaded != cl {
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "Размер установщика: скачано {downloaded} байт, Content-Length {cl}"
            ));
        }
    }

    // Верификация SHA-256 через .sha256 файл в релизе.
    let sha256_asset = find_sha256_asset(&release.assets, &asset.name);
    match sha256_asset {
        Some(sha256_a) => {
            let http = http_client()?;
            let expected = fetch_expected_sha256(&http, &sha256_a.browser_download_url).await;
            match expected {
                Ok(expected_hex) => {
                    let actual = tauri::async_runtime::spawn_blocking({
                        let p = path.clone();
                        move || compute_sha256(&p)
                    })
                    .await
                    .map_err(|e| format!("Ошибка потока SHA-256: {e}"))?;
                    match actual {
                        Ok(actual_hex) if actual_hex == expected_hex => {
                            eprintln!("[update] SHA-256 OK: {actual_hex}");
                        }
                        Ok(actual_hex) => {
                            let _ = std::fs::remove_file(&path);
                            return Err(format!(
                                "SHA-256 не совпал: получен {actual_hex}, ожидался {expected_hex}"
                            ));
                        }
                        Err(e) => {
                            let _ = std::fs::remove_file(&path);
                            return Err(format!("Не удалось вычислить SHA-256: {e}"));
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[update] предупреждение: не удалось проверить SHA-256 ({e}), продолжаем без верификации");
                }
            }
        }
        None => {
            eprintln!("[update] предупреждение: .sha256 файл не найден в релизе, продолжаем без верификации хеша");
        }
    }

    // Запускаем установщик в тихом режиме и закрываем лаунчер, чтобы он мог заменить файлы.
    launch_installer(&path)?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_v_prefix() {
        assert_eq!(normalize("v1.2.3"), "1.2.3");
        assert_eq!(normalize("V2.0.0"), "2.0.0");
        assert_eq!(normalize("1.0.0"), "1.0.0");
        assert_eq!(normalize("  v3.1.4  "), "3.1.4");
    }

    #[test]
    fn is_newer_basic() {
        assert!(is_newer("1.2.0", "1.1.0"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.1.0"));
        assert!(!is_newer("1.1.0", "1.2.0"));
    }

    #[test]
    fn is_newer_ignores_prerelease_suffix() {
        assert!(!is_newer("1.2.0-rc1", "1.2.0"));
        assert!(!is_newer("1.2.0-beta", "1.2.0"));
        assert!(!is_newer("1.2.0", "1.2.0-rc1"));
        assert!(is_newer("1.2.1-rc1", "1.2.0"));
    }

    #[test]
    fn is_newer_handles_different_lengths() {
        assert!(is_newer("1.2.3.4", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3.4"));
        assert!(is_newer("10.0", "9.9.9"));
    }

    #[test]
    fn sanitize_filename_valid() {
        assert_eq!(
            sanitize_filename("stardust-setup.exe").unwrap(),
            "stardust-setup.exe"
        );
        assert_eq!(
            sanitize_filename("launcher-1.2.3.msi").unwrap(),
            "launcher-1.2.3.msi"
        );
    }

    #[test]
    fn sanitize_filename_rejects_traversal() {
        assert!(sanitize_filename("../../../etc/passwd").is_err());
        assert!(sanitize_filename("..\\windows\\system32").is_err());
        assert!(sanitize_filename("foo/../bar").is_err());
        assert!(sanitize_filename("foo\\bar").is_err());
    }

    #[test]
    fn sanitize_filename_rejects_empty() {
        assert!(sanitize_filename("").is_err());
        assert!(sanitize_filename("   ").is_err());
    }

    #[test]
    fn sanitize_filename_rejects_dotdot() {
        assert!(sanitize_filename("..").is_err());
    }

    #[test]
    fn compute_sha256_empty_file() {
        let dir = std::env::temp_dir().join("stardust_test_sha256");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        let hash = compute_sha256(&path).unwrap();
        // SHA-256 of empty string is well-known.
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_sha256_known_input() {
        let dir = std::env::temp_dir().join("stardust_test_sha256_2");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("hello.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let hash = compute_sha256(&path).unwrap();
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_sha256_asset_present() {
        let assets = vec![
            GhAsset {
                name: "setup.exe".into(),
                browser_download_url: "".into(),
            },
            GhAsset {
                name: "setup.exe.sha256".into(),
                browser_download_url: "https://example.com/sha".into(),
            },
        ];
        let found = find_sha256_asset(&assets, "setup.exe");
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "setup.exe.sha256");
    }

    #[test]
    fn find_sha256_asset_absent() {
        let assets = vec![GhAsset {
            name: "setup.exe".into(),
            browser_download_url: "".into(),
        }];
        assert!(find_sha256_asset(&assets, "setup.exe").is_none());
    }
}
