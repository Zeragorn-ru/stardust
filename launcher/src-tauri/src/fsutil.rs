// Атомарная запись небольших служебных файлов лаунчера.
//
// Прямая `fs::write` обнуляет файл перед записью: обрыв питания, паника или
// kill посреди вызова оставляют нулевой или обрезанный файл. Для реестра
// управляемых файлов, выбора модов и выбранного профиля это означало бы
// потерю данных игрока (и, в случае `managed-files.json`, повторное
// скачивание всего модпака). Пишем во временный файл рядом и переименовываем:
// rename в пределах одного каталога атомарен.

use std::path::Path;

/// Записывает `bytes` в `path` через временный файл и rename.
///
/// Возвращает ту же ошибку, что и `fs::write`, но при ошибке исходный файл
/// остаётся нетронутым. Каталог-родитель должен существовать.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // Разные процессы не должны писать один и тот же `.tmp`: имя включает pid,
    // иначе два экземпляра лаунчера (single-instance покрывает не все случаи,
    // например portable-копии) перетрут друг другу временный файл.
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Не оставляем мусор при неудачном rename (например, если целевой
            // каталог исчез между create и rename).
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_contents() {
        let dir = std::env::temp_dir().join(format!("stardust-fsutil-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("state.json");
        std::fs::write(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        // Временного файла не осталось.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "остался временный файл: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_keeps_old_file_on_error() {
        let dir = std::env::temp_dir().join(format!("stardust-fsutil-err-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("state.json");
        std::fs::write(&path, b"old").unwrap();
        // Запись в несуществующий подкаталог обязана упасть, не трогая оригинал.
        let missing = dir.join("nope").join("state.json");
        assert!(write_atomic(&missing, b"new").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
