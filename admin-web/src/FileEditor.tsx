// Модальный редактор содержимого текстовых файлов сборки.
//
// Содержимое читаем напрямую из контент-адресного хранилища по sha1, а
// сохраняем через PUT /content — сервер пересчитывает sha1 и обновляет строку.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildFile } from "./types";
import { baseName, formatSize } from "./format";
import { useToast } from "./ui/feedback";

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
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const dirty = text !== original;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
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
  }, [file.sha1]);

  async function save() {
    setSaving(true);
    try {
      await api.updateFileContent(file.id, text);
      toast.success("Файл сохранён");
      setOriginal(text);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить",
      );
    } finally {
      setSaving(false);
    }
  }

  function tryClose() {
    if (dirty && !window.confirm("Есть несохранённые изменения. Закрыть?")) {
      return;
    }
    onClose();
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
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (!saving && dirty) save();
    }
  }

  return (
    <div className="modal-backdrop" onClick={tryClose}>
      <div
        className="modal modal-editor"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="editor-head">
          <div className="editor-title">
            <strong>{baseName(file.path)}</strong>
            <span className="muted mono">{file.path}</span>
          </div>
          <span className="muted">{formatSize(file.sizeBytes)}</span>
        </div>

        {loading ? (
          <div className="editor-status muted">Загрузка…</div>
        ) : error ? (
          <div className="error">{error}</div>
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

        <div className="modal-actions">
          <span className="editor-hint muted">
            {dirty ? "Изменено • Ctrl+S — сохранить" : "Нет изменений"}
          </span>
          <div className="spacer" />
          <button onClick={tryClose}>Закрыть</button>
          <button
            className="primary"
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
