//! Работа со сборкой (модпаком): таблицы `builds` и `build_files`.
//!
//! Метаданные файлов хранятся в БД, а сами байты модов/конфигов — на диске
//! в каталоге `modpack-data` под именем `storage_key`. Здесь только метаданные
//! и генерация манифеста для лаунчера.

use protocol::{FileEntry, FileKind, LoaderInfo, LoaderKind, Manifest, Side};
use sqlx::Row;

use crate::{Store, StoreError};

/// Заголовок сборки (без файлов).
#[derive(Debug, Clone)]
pub struct BuildHeader {
    pub id: i64,
    pub name: String,
    pub version: String,
    pub loader_kind: String,
    pub mc_version: String,
    pub loader_version: String,
    pub is_active: bool,
}

/// Изменяемые метаданные сборки.
#[derive(Debug, Clone)]
pub struct UpdateBuild {
    pub name: String,
    pub version: String,
    pub loader_kind: String,
    pub mc_version: String,
    pub loader_version: String,
}

/// Параметры создания сборки.
#[derive(Debug, Clone)]
pub struct NewBuild {
    pub name: String,
    pub version: String,
    pub loader_kind: String,
    pub mc_version: String,
    pub loader_version: String,
}

/// Изменяемые метаданные файла (без контента/пути).
#[derive(Debug, Clone)]
pub struct BuildFileMeta {
    pub side: String,
    pub kind: String,
    pub overwrite: bool,
    pub optional: bool,
    pub enabled_by_default: bool,
    pub disabled: bool,
    pub mod_id: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    /// Профили, в которых состоит файл (ключи build_mod_profiles.key).
    /// Пусто = «общий», есть во всех профилях.
    pub profile_keys: Vec<String>,
}

/// Файл сборки для вставки/обновления (метаданные; байты уже на диске).
#[derive(Debug, Clone)]
pub struct BuildFileInput {
    pub path: String,
    pub sha1: String,
    pub size_bytes: i64,
    pub side: String,
    pub kind: String,
    pub overwrite: bool,
    pub optional: bool,
    pub enabled_by_default: bool,
    pub disabled: bool,
    pub mod_id: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub storage_key: String,
    /// Профили, в которых состоит файл; пусто = «общий».
    pub profile_keys: Vec<String>,
}

/// Полная сборка: заголовок + файлы + профили модов.
#[derive(Debug, Clone)]
pub struct BuildRecord {
    pub header: BuildHeader,
    pub files: Vec<BuildFileRow>,
    pub mod_profiles: Vec<ModProfileRow>,
}

/// Строка файла сборки, как она лежит в БД.
#[derive(Debug, Clone)]
pub struct BuildFileRow {
    pub id: i64,
    pub path: String,
    pub sha1: String,
    pub size_bytes: i64,
    pub side: String,
    pub kind: String,
    pub overwrite: bool,
    pub optional: bool,
    pub enabled_by_default: bool,
    pub disabled: bool,
    pub mod_id: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub storage_key: String,
    /// Профили, в которых состоит файл; пусто = «общий» (есть во всех).
    pub profile_keys: Vec<String>,
}

const BUILD_COLUMNS: &str = "id, name, version, loader_kind, mc_version, loader_version, is_active";

const FILE_COLUMNS: &str = "id, path, sha1, size_bytes, side, kind, overwrite, optional, \
     enabled_by_default, disabled, mod_id, display_name, description, storage_key, profile_keys";

impl Store {
    /// Создаёт новую сборку. Не делает её активной автоматически.
    pub async fn create_build(&self, new: NewBuild) -> Result<i64, StoreError> {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO builds (name, version, loader_kind, mc_version, loader_version, is_active)
             VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id",
        )
        .bind(&new.name)
        .bind(&new.version)
        .bind(&new.loader_kind)
        .bind(&new.mc_version)
        .bind(&new.loader_version)
        .fetch_one(self.pool())
        .await?;
        Ok(id)
    }

    /// Клонирует сборку: создаёт новую (неактивную) с тем же набором файлов.
    ///
    /// Байты на диске не копируются — контент адресуется по `storage_key`
    /// (sha1), а блобы иммутабельны (правка контента пишет новый sha1), поэтому
    /// несколько сборок могут безопасно ссылаться на один и тот же блоб.
    /// Копируются только строки БД, всё в одной транзакции. Возвращает id копии.
    pub async fn clone_build(&self, src_id: i64, new_name: &str) -> Result<i64, StoreError> {
        let mut tx = self.pool().begin().await?;

        // Копируем заголовок: имя задаёт вызывающий, копия всегда неактивна.
        let new_id: Option<i64> = sqlx::query_scalar(
            "INSERT INTO builds (name, version, loader_kind, mc_version, loader_version, is_active)
             SELECT $2, version, loader_kind, mc_version, loader_version, FALSE
             FROM builds WHERE id = $1
             RETURNING id",
        )
        .bind(src_id)
        .bind(new_name)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(new_id) = new_id else {
            // Исходной сборки нет — откатываемся.
            tx.rollback().await?;
            return Err(StoreError::NotFound);
        };

        // Копируем все строки файлов на новый build_id (id/created_at — свои).
        sqlx::query(
            "INSERT INTO build_files
                (build_id, path, sha1, size_bytes, side, kind, overwrite, optional,
                 enabled_by_default, disabled, mod_id, display_name, description,
                 storage_key, profile_keys)
             SELECT $2, path, sha1, size_bytes, side, kind, overwrite, optional,
                 enabled_by_default, disabled, mod_id, display_name, description,
                 storage_key, profile_keys
             FROM build_files WHERE build_id = $1",
        )
        .bind(src_id)
        .bind(new_id)
        .execute(&mut *tx)
        .await?;

        // Копируем и профили модов сборки.
        sqlx::query(
            "INSERT INTO build_mod_profiles
                (build_id, key, name, description, sort_order)
             SELECT $2, key, name, description, sort_order
             FROM build_mod_profiles WHERE build_id = $1",
        )
        .bind(src_id)
        .bind(new_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(new_id)
    }

    /// Список заголовков всех сборок.
    pub async fn list_builds(&self) -> Result<Vec<BuildHeader>, StoreError> {
        let sql = format!("SELECT {BUILD_COLUMNS} FROM builds ORDER BY id DESC");
        let rows = sqlx::query(&sql).fetch_all(self.pool()).await?;
        Ok(rows.iter().map(row_to_header).collect())
    }

    /// Возвращает активную сборку с файлами, если она есть.
    pub async fn active_build(&self) -> Result<Option<BuildRecord>, StoreError> {
        let sql = format!(
            "SELECT {BUILD_COLUMNS} FROM builds WHERE is_active = TRUE ORDER BY id DESC LIMIT 1"
        );
        let Some(header_row) = sqlx::query(&sql).fetch_optional(self.pool()).await? else {
            return Ok(None);
        };
        let header = row_to_header(&header_row);
        let files = self.build_files(header.id).await?;
        let mod_profiles = self.mod_profiles(header.id).await?;
        Ok(Some(BuildRecord {
            header,
            files,
            mod_profiles,
        }))
    }

    /// Возвращает сборку по id с файлами.
    pub async fn get_build(&self, build_id: i64) -> Result<Option<BuildRecord>, StoreError> {
        let sql = format!("SELECT {BUILD_COLUMNS} FROM builds WHERE id = $1");
        let Some(header_row) = sqlx::query(&sql)
            .bind(build_id)
            .fetch_optional(self.pool())
            .await?
        else {
            return Ok(None);
        };
        let header = row_to_header(&header_row);
        let files = self.build_files(header.id).await?;
        let mod_profiles = self.mod_profiles(header.id).await?;
        Ok(Some(BuildRecord {
            header,
            files,
            mod_profiles,
        }))
    }

    /// Делает сборку активной (а остальные — неактивными).
    pub async fn set_active_build(&self, build_id: i64) -> Result<(), StoreError> {
        let mut tx = self.pool().begin().await?;
        sqlx::query("UPDATE builds SET is_active = FALSE WHERE is_active = TRUE")
            .execute(&mut *tx)
            .await?;
        let changed =
            sqlx::query("UPDATE builds SET is_active = TRUE, updated_at = now() WHERE id = $1")
                .bind(build_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    /// Обновляет метаданные сборки.
    pub async fn update_build(&self, build_id: i64, upd: UpdateBuild) -> Result<(), StoreError> {
        let changed = sqlx::query(
            "UPDATE builds SET name = $2, version = $3, loader_kind = $4, mc_version = $5, \
             loader_version = $6, updated_at = now() WHERE id = $1",
        )
        .bind(build_id)
        .bind(&upd.name)
        .bind(&upd.version)
        .bind(&upd.loader_kind)
        .bind(&upd.mc_version)
        .bind(&upd.loader_version)
        .execute(self.pool())
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Удаляет сборку и её файлы (метаданные; чистка байтов на диске — отдельно).
    pub async fn delete_build(&self, build_id: i64) -> Result<(), StoreError> {
        let changed = sqlx::query("DELETE FROM builds WHERE id = $1")
            .bind(build_id)
            .execute(self.pool())
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Один файл сборки по id.
    pub async fn build_file(&self, file_id: i64) -> Result<BuildFileRow, StoreError> {
        let sql = format!("SELECT {FILE_COLUMNS} FROM build_files WHERE id = $1");
        let row = sqlx::query(&sql)
            .bind(file_id)
            .fetch_optional(self.pool())
            .await?
            .ok_or(StoreError::NotFound)?;
        Ok(row_to_file(&row))
    }

    /// Файлы сборки.
    pub async fn build_files(&self, build_id: i64) -> Result<Vec<BuildFileRow>, StoreError> {
        let sql =
            format!("SELECT {FILE_COLUMNS} FROM build_files WHERE build_id = $1 ORDER BY path");
        let rows = sqlx::query(&sql)
            .bind(build_id)
            .fetch_all(self.pool())
            .await?;
        Ok(rows.iter().map(row_to_file).collect())
    }

    /// Добавляет/заменяет файл сборки (upsert по (build_id, path)).
    pub async fn upsert_build_file(
        &self,
        build_id: i64,
        file: BuildFileInput,
    ) -> Result<i64, StoreError> {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO build_files
                (build_id, path, sha1, size_bytes, side, kind, overwrite, optional,
                 enabled_by_default, disabled, mod_id, display_name, description,
                 storage_key, profile_keys)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (build_id, path) DO UPDATE SET
                sha1 = EXCLUDED.sha1, size_bytes = EXCLUDED.size_bytes, side = EXCLUDED.side,
                kind = EXCLUDED.kind, overwrite = EXCLUDED.overwrite, optional = EXCLUDED.optional,
                enabled_by_default = EXCLUDED.enabled_by_default, disabled = EXCLUDED.disabled,
                mod_id = EXCLUDED.mod_id,
                display_name = EXCLUDED.display_name, description = EXCLUDED.description,
                storage_key = EXCLUDED.storage_key, profile_keys = EXCLUDED.profile_keys
             RETURNING id",
        )
        .bind(build_id)
        .bind(&file.path)
        .bind(&file.sha1)
        .bind(file.size_bytes)
        .bind(&file.side)
        .bind(&file.kind)
        .bind(file.overwrite)
        .bind(file.optional)
        .bind(file.enabled_by_default)
        .bind(file.disabled)
        .bind(&file.mod_id)
        .bind(&file.display_name)
        .bind(&file.description)
        .bind(&file.storage_key)
        .bind(&file.profile_keys)
        .fetch_one(self.pool())
        .await?;
        // Сборка изменилась — обновим отметку.
        sqlx::query("UPDATE builds SET updated_at = now() WHERE id = $1")
            .bind(build_id)
            .execute(self.pool())
            .await?;
        Ok(id)
    }

    /// Обновляет только метаданные файла (sha1/контент/путь не трогаем).
    /// Возвращает обновлённую строку.
    pub async fn update_build_file_meta(
        &self,
        file_id: i64,
        meta: BuildFileMeta,
    ) -> Result<BuildFileRow, StoreError> {
        let sql = format!(
            "UPDATE build_files SET
                side = $2, kind = $3, overwrite = $4, optional = $5,
                enabled_by_default = $6, disabled = $7,
                mod_id = $8, display_name = $9, description = $10, profile_keys = $11
             WHERE id = $1
             RETURNING {FILE_COLUMNS}"
        );
        let row = sqlx::query(&sql)
            .bind(file_id)
            .bind(&meta.side)
            .bind(&meta.kind)
            .bind(meta.overwrite)
            .bind(meta.optional)
            .bind(meta.enabled_by_default)
            .bind(meta.disabled)
            .bind(&meta.mod_id)
            .bind(&meta.display_name)
            .bind(&meta.description)
            .bind(&meta.profile_keys)
            .fetch_optional(self.pool())
            .await?
            .ok_or(StoreError::NotFound)?;
        let file = row_to_file(&row);
        // Сборка изменилась — обновим отметку.
        sqlx::query("UPDATE builds SET updated_at = now() WHERE id = (SELECT build_id FROM build_files WHERE id = $1)")
            .bind(file_id)
            .execute(self.pool())
            .await?;
        Ok(file)
    }

    /// Обновляет содержимое файла (sha1/размер/storage_key). Метаданные и путь
    /// не трогаем. Возвращает обновлённую строку.
    pub async fn update_build_file_content(
        &self,
        file_id: i64,
        sha1: String,
        size_bytes: i64,
        storage_key: String,
    ) -> Result<BuildFileRow, StoreError> {
        let sql = format!(
            "UPDATE build_files SET sha1 = $2, size_bytes = $3, storage_key = $4
             WHERE id = $1
             RETURNING {FILE_COLUMNS}"
        );
        let row = sqlx::query(&sql)
            .bind(file_id)
            .bind(&sha1)
            .bind(size_bytes)
            .bind(&storage_key)
            .fetch_optional(self.pool())
            .await?
            .ok_or(StoreError::NotFound)?;
        let file = row_to_file(&row);
        sqlx::query("UPDATE builds SET updated_at = now() WHERE id = (SELECT build_id FROM build_files WHERE id = $1)")
            .bind(file_id)
            .execute(self.pool())
            .await?;
        Ok(file)
    }

    /// Удаляет файл сборки по id.
    pub async fn delete_build_file(&self, file_id: i64) -> Result<(), StoreError> {
        let changed = sqlx::query("DELETE FROM build_files WHERE id = $1")
            .bind(file_id)
            .execute(self.pool())
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn delete_build_files_by_mod_id(
        &self,
        build_id: i64,
        mod_id: &str,
    ) -> Result<u64, StoreError> {
        let result = sqlx::query("DELETE FROM build_files WHERE build_id = $1 AND mod_id = $2")
            .bind(build_id)
            .bind(mod_id)
            .execute(self.pool())
            .await?;
        Ok(result.rows_affected())
    }
}

/// Описание профиля опциональных модов сборки (пресет «Производительность»
/// и т.п.). Профили не создают отдельных подсборок: один и тот же файл может
/// состоять в нескольких профилях, а пустой список — «общий» для всех.
#[derive(Debug, Clone)]
pub struct ModProfileRow {
    pub id: i64,
    pub build_id: i64,
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
}

/// Вход для создания/обновления профиля модов сборки.
#[derive(Debug, Clone)]
pub struct ModProfileInput {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i32,
}

impl Store {
    /// Профили модов сборки, упорядоченные по sort_order.
    pub async fn mod_profiles(&self, build_id: i64) -> Result<Vec<ModProfileRow>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, build_id, key, name, description, sort_order
             FROM build_mod_profiles WHERE build_id = $1
             ORDER BY sort_order, id",
        )
        .bind(build_id)
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .iter()
            .map(|r| ModProfileRow {
                id: r.get("id"),
                build_id: r.get("build_id"),
                key: r.get("key"),
                name: r.get("name"),
                description: r.get("description"),
                sort_order: r.get("sort_order"),
            })
            .collect())
    }

    /// Добавляет или обновляет профиль модов по ключу (upsert по (build_id, key)).
    pub async fn upsert_mod_profile(
        &self,
        build_id: i64,
        input: ModProfileInput,
    ) -> Result<ModProfileRow, StoreError> {
        let row = sqlx::query(
            "INSERT INTO build_mod_profiles (build_id, key, name, description, sort_order)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (build_id, key) DO UPDATE SET
                name = EXCLUDED.name, description = EXCLUDED.description,
                sort_order = EXCLUDED.sort_order
             RETURNING id, build_id, key, name, description, sort_order",
        )
        .bind(build_id)
        .bind(&input.key)
        .bind(&input.name)
        .bind(&input.description)
        .bind(input.sort_order)
        .fetch_one(self.pool())
        .await?;
        let profile = ModProfileRow {
            id: row.get("id"),
            build_id: row.get("build_id"),
            key: row.get("key"),
            name: row.get("name"),
            description: row.get("description"),
            sort_order: row.get("sort_order"),
        };
        sqlx::query("UPDATE builds SET updated_at = now() WHERE id = $1")
            .bind(build_id)
            .execute(self.pool())
            .await?;
        Ok(profile)
    }

    /// Удаляет профиль по ключу и в той же транзакции вычищает ссылки на него
    /// из `build_files.profile_keys` — иначе сбой между запросами оставляет
    /// «висячие» ключи навсегда (ретрай получает NotFound до чистки).
    pub async fn delete_mod_profile(&self, build_id: i64, key: &str) -> Result<(), StoreError> {
        let mut tx = self.pool().begin().await?;
        let changed = sqlx::query("DELETE FROM build_mod_profiles WHERE build_id = $1 AND key = $2")
            .bind(build_id)
            .bind(key)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        sqlx::query(
            "UPDATE build_files SET profile_keys = array_remove(profile_keys, $2) WHERE build_id = $1",
        )
        .bind(build_id)
        .bind(key)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

impl BuildRecord {
    /// Строит клиентский манифест. `base_url` — префикс, под которым лаунчер
    /// качает содержимое файлов (напр. `https://host/files`); итоговый URL =
    /// `base_url/<storage_key>`.
    pub fn client_manifest(&self, base_url: &str) -> Manifest {
        let base = base_url.trim_end_matches('/');
        let files = self
            .files
            .iter()
            .filter(|f| !f.disabled && side_from_str(&f.side).on_client())
            .map(|f| f.to_entry(base))
            .collect();
        let mod_profiles = self
            .mod_profiles
            .iter()
            .map(|p| protocol::ModProfile {
                key: p.key.clone(),
                name: p.name.clone(),
                description: p.description.clone(),
            })
            .collect();
        Manifest {
            name: self.header.name.clone(),
            version: self.header.version.clone(),
            loader: LoaderInfo {
                minecraft: self.header.mc_version.clone(),
                kind: loader_kind_from_str(&self.header.loader_kind),
                version: self.header.loader_version.clone(),
            },
            files,
            external_mod_policy: None,
            mod_profiles,
        }
    }
}

impl BuildFileRow {
    fn to_entry(&self, base: &str) -> FileEntry {
        FileEntry {
            path: self.path.clone(),
            url: format!("{base}/{}", self.storage_key),
            sha1: self.sha1.clone(),
            size: self.size_bytes.max(0) as u64,
            side: side_from_str(&self.side),
            kind: kind_from_str(&self.kind),
            overwrite: self.overwrite,
            optional: self.optional,
            enabled_by_default: self.enabled_by_default,
            mod_id: self.mod_id.clone(),
            display_name: self.display_name.clone(),
            description: self.description.clone(),
            // Пока не хранится в БД — конфликты задаются вручную в JSON или
            // статическими правилами лаунчера (см. modpack::KNOWN_CONFLICTS).
            conflicts_with: Vec::new(),
            profiles: self.profile_keys.clone(),
        }
    }
}

fn row_to_header(row: &sqlx::postgres::PgRow) -> BuildHeader {
    BuildHeader {
        id: row.get("id"),
        name: row.get("name"),
        version: row.get("version"),
        loader_kind: row.get("loader_kind"),
        mc_version: row.get("mc_version"),
        loader_version: row.get("loader_version"),
        is_active: row.get("is_active"),
    }
}

fn row_to_file(row: &sqlx::postgres::PgRow) -> BuildFileRow {
    BuildFileRow {
        id: row.get("id"),
        path: row.get("path"),
        sha1: row.get("sha1"),
        size_bytes: row.get("size_bytes"),
        side: row.get("side"),
        kind: row.get("kind"),
        overwrite: row.get("overwrite"),
        optional: row.get("optional"),
        enabled_by_default: row.get("enabled_by_default"),
        disabled: row.get("disabled"),
        mod_id: row.get("mod_id"),
        display_name: row.get("display_name"),
        description: row.get("description"),
        storage_key: row.get("storage_key"),
        profile_keys: row
            .try_get::<Vec<String>, _>("profile_keys")
            .unwrap_or_default(),
    }
}

fn side_from_str(s: &str) -> Side {
    match s {
        "client" => Side::Client,
        "server" => Side::Server,
        _ => Side::Both,
    }
}

fn kind_from_str(s: &str) -> FileKind {
    match s {
        "config" => FileKind::Config,
        "resource" => FileKind::Resource,
        "other" => FileKind::Other,
        _ => FileKind::Mod,
    }
}

fn loader_kind_from_str(s: &str) -> LoaderKind {
    match s {
        "vanilla" => LoaderKind::Vanilla,
        "fabric" => LoaderKind::Fabric,
        "quilt" => LoaderKind::Quilt,
        "forge" => LoaderKind::Forge,
        _ => LoaderKind::NeoForge,
    }
}
