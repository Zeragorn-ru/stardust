// Модальный редактор содержимого текстовых файлов сборки.
//
// Содержимое читаем напрямую из контент-адресного хранилища по sha1, а
// сохраняем через PUT /content — сервер пересчитывает sha1 и обновляет строку.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildFile } from "./types";
import { baseName, formatSize } from "./format";
import { useConfirm, useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";

// Расширения, которые мы считаем текстовыми и предлагаем редактировать.
const TEXT_EXT = new Set([
  "txt",
  "json",
  "json5",
  "toml",
  "cfg",
  "conf",
  "properties",
  "yaml",
  "yml",
  "ini",
  "md",
  "log",
  "xml",
  "snbt",
  "mcmeta",
  "lang",
  "csv",
  "js",
  "ts",
  "sh",
]);

// Порог, выше которого редактировать в браузере неудобно (1 МБ).
const MAX_EDIT_BYTES = 1024 * 1024;

/// Можно ли предлагать редактирование файла как текста.
export function isEditable(file: BuildFile): boolean {
  if (file.sizeBytes > MAX_EDIT_BYTES) return false;
  const name = baseName(file.path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXT.has(name.slice(dot + 1));
}

export function FileEditor({
  file,
  onClose,
  onSaved,
}: {
  file: BuildFile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  useBodyScrollLock();
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ошибка последнего сохранения: тост гаснет сам и не предлагает действия,
  // поэтому неудачу показываем ещё и панелью с «Повторить» у кнопок.
  const [saveError, setSaveError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Ручной перезапуск загрузки после ошибки: увеличиваем ключ — эффект
  // перечитывает содержимое.
  const [reloadKey, setReloadKey] = useState(0);

  const dirty = text !== original;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSaveError(null);
    api
      .getFileContent(file.sha1)
      .then((content) => {
        if (!alive) return;
        setText(content);
        setOriginal(content);
      })
      .catch((err) => {
        if (!alive) return;
        setError(
          err instanceof ApiError ? err.message : "Не удалось загрузить файл",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [file.sha1, reloadKey]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateFileContent(file.id, text);
      toast.success("Файл сохранён");
      setOriginal(text);
      onSaved();
      onClose();
    } catch (err) {
      const message = err instanceof ApiError
        ? err.message
        : "Не удалось сохранить";
      toast.error(message);
      // Не только тост: панель с «Повторить» у кнопок — тост гаснет через 6 с
      // и не даёт действия, а редактор остаётся открытым с несохранённым текстом.
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  async function tryClose() {
    if (
      dirtyRef.current &&
      !(await confirm({
        title: "Есть несохранённые изменения",
        body: "Закрыть редактор без сохранения?",
        confirmText: "Закрыть без сохранения",
        danger: true,
      }))
    ) {
      return;
    }
    onClose();
  }

  // Escape закрывает редактор (с подтверждением, если есть изменения).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        void tryClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // tryClose стабилен по поведению (читает dirty через ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl/Cmd+S сохраняет из любой точки редактора — фокус может стоять на
  // кнопках, а не в тексте, поэтому слушаем ключи на самом диалоге.
  // Проверяем e.code (физическая клавиша): в русской раскладке e.key === "ы".
  function onDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
      e.preventDefault();
      if (!saving && !loading && !error && dirty) void save();
    }
  }

  // Tab вставляет отступ, а не уводит фокус.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = text.slice(0, start) + "  " + text.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  return (
    <div className="modal-backdrop file-editor-backdrop" onClick={tryClose}>
      <div
        className="modal modal-editor file-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-editor-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Редактор файла</span>
            <strong id="file-editor-title" title={file.path}>{baseName(file.path)}</strong>
            <span className="muted mono" title={file.path}>{file.path}</span>
          </div>
          <div className="editor-head-meta">
            <span className={`editor-state${dirty ? " editor-state--dirty" : ""}`}>
              <span className="editor-state-dot" aria-hidden="true" />
              {dirty ? "Изменено" : "Сохранено"}
            </span>
            <span className="muted">{formatSize(file.sizeBytes)}</span>
            <button className="editor-close" type="button" onClick={tryClose}>
              Закрыть
            </button>
          </div>
        </div>

        {loading ? (
          <div className="editor-status muted">
            <span className="spinner" />
            Загрузка…
          </div>
        ) : error ? (
          <div
            className="error"
            role="alert"
            style={{ display: "flex", alignItems: "center", gap: "10px" }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Повторить
            </button>
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="editor-area mono"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
        )}

        {saveError && !loading && !error && (
          <div
            className="error"
            role="alert"
            style={{
              margin: "12px 0 0",
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>{saveError}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => void save()}
              disabled={saving}
            >
              Повторить
            </button>
          </div>
        )}
        <div className="modal-actions editor-actions">
          <span className="editor-hint muted">
            {dirty ? "Изменено · Ctrl/Cmd+S — сохранить" : "Нет изменений"}
          </span>
          <div className="spacer" />
          <button type="button" onClick={tryClose}>Закрыть</button>
          <button
            className="primary"
            type="button"
            onClick={save}
            disabled={saving || loading || !!error || !dirty}
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
