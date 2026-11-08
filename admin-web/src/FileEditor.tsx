// Модальный редактор содержимого текстовых файлов сборки.
//
// Содержимое читаем напрямую из контент-адресного хранилища по sha1, а
// сохраняем через PUT /content — сервер пересчитывает sha1 и обновляет строку.
//
// Optimistic-lock: base_sha1 считаем из реально загруженного текста
// (crypto.subtle), а не из метаданных строки сборки — они устаревают, пока
// редактор открыт. 409 не перезагружает редактор молча: показываем панель
// конфликта, черновик пользователя сохраняется в обоих сценариях решения.

import "./FileEditor.css";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildFile } from "./types";
import { baseName, formatSize } from "./format";
import { useConfirm, useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { useDialogFocus } from "./ui/useDialogFocus";

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

// Расширения, содержимое которых валидируем как JSON перед сохранением.
const JSON_EXT = new Set(["json", "mcmeta"]);

// Порог, выше которого редактировать в браузере неудобно (1 МБ).
const MAX_EDIT_BYTES = 1024 * 1024;

/// SHA-1 текста в hex — тот же алгоритм и представление байтов (UTF-8), что у
/// серверного sha1_hex. Даёт честный base_sha1 для optimistic-lock.
async function computeSha1(content: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/// Похож ли текст на бинарные данные: нуль-байт или больше пяти подряд
/// управляющих символов U+0000–U+001F (кроме таба, LF и CR).
function looksBinary(content: string): boolean {
  if (content.includes("\0")) return true;
  let run = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c <= 0x1f && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      run++;
      if (run > 5) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/// Расширение имени файла (строчными буквами), '' если точки нет.
function fileExt(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot + 1);
}

/// Можно ли предлагать редактирование файла как текста.
export function isEditable(file: BuildFile): boolean {
  if (file.sizeBytes > MAX_EDIT_BYTES) return false;
  return TEXT_EXT.has(fileExt(baseName(file.path)));
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
  const dialogRef = useRef<HTMLDivElement>(null);
  // Ручной перезапуск загрузки после ошибки: увеличиваем ключ — эффект
  // перечитывает содержимое.
  const [reloadKey, setReloadKey] = useState(0);

  // SHA-1 загруженного содержимого — это base_sha1 для PUT. Метаданные
  // строки сборки (file.sha1) на момент рендера устаревшие, им не доверяем.
  const [baseSha1, setBaseSha1] = useState<string | null>(null);

  // Файл похож на бинарный: редактирование отключено, save недоступен.
  const [binaryError, setBinaryError] = useState(false);

  // Конфликт версий (409): актуальная серверная копия, загруженная после
  // отказа сервера. Пока она не подтянута — null, панель не показываем.
  const [conflict, setConflict] = useState<{ content: string; sha1: string } | null>(
    null,
  );

  // Синтаксическая ошибка JSON, найденная при попытке сохранения (п.6).
  const [jsonError, setJsonError] = useState<{
    message: string;
    line: number;
    col: number;
  } | null>(null);

  const fileName = baseName(file.path);
  const needsJsonValidation = JSON_EXT.has(fileExt(fileName));

  const dirty = text !== original;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSaveError(null);
    setConflict(null);
    setJsonError(null);
    setBinaryError(false);
    setBaseSha1(null);
    api
      .getFileContent(file.sha1)
      .then(async (content) => {
        if (!alive) return;
        setText(content);
        setOriginal(content);
        setBinaryError(looksBinary(content));
        const sha = await computeSha1(content);
        if (!alive) return;
        setBaseSha1(sha);
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

  // Пока есть несохранённые правки, закрытие/навигация страницы требует
  // подтверждения браузером. Снимается автоматически, когда dirty гаснет
  // (сохранение) или когда модалка размонтируется (закрытие).
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Актуальная серверная копия содержимого. file.sha1 — метаданные строки
  // сборки, они устарели после 409, поэтому сначала вытаскиваем настоящий
  // sha1 свежей строки пустым PATCH (не меняет метаданные, только возвращает
  // строку), затем читаем контент из хранилища по нему.
  async function fetchCurrentServerCopy(): Promise<{
    content: string;
    sha1: string;
  }> {
    const fresh = await api.updateFile(file.id, {});
    const content = await api.getFileContent(fresh.sha1);
    return { content, sha1: fresh.sha1 };
  }

  // Парсим текст как JSON; при синтаксической ошибке извлекаем позицию из
  // сообщения движка («line N column M» либо «position N» — считаем строку
  // сами) и возвращаем описание для панели.
  function validateJson(content: string): {
    message: string;
    line: number;
    col: number;
  } | null {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      let line = 1;
      let col = 1;
      const lc = message.match(/line (\d+) column (\d+)/i);
      if (lc) {
        line = parseInt(lc[1], 10);
        col = parseInt(lc[2], 10);
      } else {
        const pos = message.match(/position (\d+)/i);
        if (pos) {
          const before = content.slice(
            0,
            Math.min(parseInt(pos[1], 10), content.length),
          );
          const rows = before.split("\n");
          line = rows.length;
          col = rows[rows.length - 1].length + 1;
        }
      }
      return { message, line, col };
    }
  }

  // PUT содержимого с base_sha1. 409 не перезагружает редактор: черновик
  // остаётся в textarea, фоном подтягиваем серверную копию и показываем
  // панель конфликта (п.1).
  async function putContent(content: string, base: string | undefined) {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateFileContent(file.id, content, base);
      toast.success("Файл сохранён");
      setOriginal(content);
      setBaseSha1(await computeSha1(content));
      setConflict(null);
      setJsonError(null);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Сервер отверг base_sha1: файл менялся, пока мы редактировали.
        toast.error(err.message);
        fetchCurrentServerCopy()
          .then(setConflict)
          .catch(() =>
            toast.error("Не удалось загрузить серверную версию для сравнения"),
          );
      } else {
        // Не только тост: панель с «Повторить» у кнопок — тост гаснет через
        // 6 с и не даёт действия, а редактор остаётся с несохранённым текстом.
        const message =
          err instanceof ApiError ? err.message : "Не удалось сохранить";
        toast.error(message);
        setSaveError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  // Сохранение: сначала валидация JSON (п.6) — битый конфиг не уходит на
  // сервер, пока явно не нажмут «Сохранить всё равно» (forceJson).
  async function save(forceJson = false, base?: string) {
    if (needsJsonValidation && !forceJson) {
      const problem = validateJson(text);
      if (problem) {
        setJsonError(problem);
        return;
      }
    }
    await putContent(text, base ?? baseSha1 ?? undefined);
  }

  // «Обновить базу и сохранить»: серверная копия уходит в фоновый state
  // (original + base_sha1), черновик в textarea остаётся нетронутым, затем
  // повторяем PUT текстом пользователя поверх новой базы.
  async function resolveKeepLocal() {
    if (!conflict) return;
    setOriginal(conflict.content);
    setBaseSha1(conflict.sha1);
    setConflict(null);
    setSaveError(null);
    await save(false, conflict.sha1);
  }

  // «Взять серверную версию»: заменяем текст серверной копией. Черновик при
  // этом теряется, поэтому при dirty спрашиваем подтверждение.
  async function resolveTakeServer() {
    if (!conflict) return;
    if (
      dirtyRef.current &&
      !(await confirm({
        title: "Есть несохранённые изменения",
        body: "Заменить ваш текст серверной версией? Несохранённые правки будут потеряны.",
        confirmText: "Взять серверную версию",
        danger: true,
      }))
    ) {
      return;
    }
    setText(conflict.content);
    setOriginal(conflict.content);
    setBaseSha1(conflict.sha1);
    setConflict(null);
    setSaveError(null);
    setJsonError(null);
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

  // Фокус-ловушка диалога (план 9): Tab-цикл внутри редактора, Escape —
  // закрытие с dirty-проверкой, возврат фокуса на элемент до открытия.
  // Стабильная обёртка: хук читает колбэк через ref и не перевязывает эффект.
  const tryCloseRef = useRef(tryClose);
  tryCloseRef.current = tryClose;
  const onEscape = useRef(() => void tryCloseRef.current());

  // --- Курсор позиция: строка и колонка (1-based) ---
  const [posLine, setPosLine] = useState(0);
  const [posCol, setPosCol] = useState(0);

  // Обновляем позицию курсора (1-based line + col).
  function updateCursor(el?: HTMLTextAreaElement) {
    const target = el || taRef.current;
    if (!target) return;
    const v = text.slice(0, target.selectionStart);
    const lines = v.split("\n");
    setPosLine(lines.length);
    setPosCol(lines[lines.length - 1].length + 1);
  }

  useEffect(() => {
    requestAnimationFrame(() => updateCursor());
  }, [text]);

  // Подсчёт total строк для отображения.
  const totalLines = text.split("\n").length;

  // Правка текста снимает предупреждение о JSON: панель снова появится
  // только после новой попытки сохранения.
  function editText(value: string) {
    setText(value);
    setJsonError(null);
  }

  // --- Quick-line input: Ctrl+G прыжок на строку ---
  const [showQuickLine, setShowQuickLine] = useState(false);
  const [quickLineVal, setQuickLineVal] = useState("");

  function toggleQuickLine() {
    setShowQuickLine((v) => !v);
    if (!showQuickLine) setQuickLineVal(String(posLine));
  }

  function jumpToLine() {
    const n = parseInt(quickLineVal, 10);
    if (isNaN(n) || n < 1 || n > totalLines) return;
    setShowQuickLine(false);
    // Вычисляем смещение начала строки n (0-based index).
    const rows = text.split("\n");
    let offset = 0;
    for (let i = 0; i < n - 1 && i < rows.length; i++) {
      offset += rows[i].length + 1;
    }
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = offset;
      // Прокручиваем к нужной строке.
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight);
      ta.scrollTop = Math.max(0, (n - 1) * lineHeight - ta.clientHeight / 3);
      updateCursor();
    });
  }

  // Quick-jump на строку по Ctrl+G (Cmd+G).
  function onDialogKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyG") {
      e.preventDefault();
      toggleQuickLine();
    }
  }

  useDialogFocus(dialogRef, onEscape.current);

  // Ctrl/Cmd+S сохраняет из любой точки редактора — фокус может стоять на
  // кнопках, а не в тексте, поэтому слушаем ключи на самом диалоге.
  // Проверяем e.code (физическая клавиша): в русской раскладке e.key === "ы".
  function onDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
      e.preventDefault();
      if (
        !saving && !loading && !error && !binaryError && !conflict && dirty
      ) {
        void save();
      }
    }
  }

  // Tab вставляет отступ, а не уводит фокус. stopPropagation не даёт
  // фокус-ловушке диалога перехватить Tab и увести фокус из текста.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      editText(text.slice(0, start) + "  " + text.slice(end));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  return (
    <div className="modal-backdrop file-editor-backdrop" onClick={tryClose}>
      <div
        ref={dialogRef}
        className="modal modal-editor file-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-editor-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        onKeyUp={onDialogKeyUp}
      >
        <div className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Редактор файла</span>
            <strong id="file-editor-title" title={file.path}>{fileName}</strong>
            <span className="muted mono" title={file.path}>{file.path}</span>
          </div>
          <div className="editor-head-meta">
            <span className={`editor-state${dirty ? " editor-state--dirty" : ""}`}>
              <span className="editor-state-dot" aria-hidden="true" />
              {dirty ? "Изменено" : "Сохранено"}
            </span>
            <span className="muted">{formatSize(file.sizeBytes)}</span>
            {loading || binaryError ? null : (
              <>
                <span className="mono muted editor-pos" title={`Всего ${totalLines} строк`}>
                  {posLine}:{posCol} · {totalLines}
                </span>
                <span
                  className="link-btn editor-jump-btn"
                  onClick={toggleQuickLine}
                  title="Перейти к строке (Ctrl+G)"
                  style={{ cursor: "pointer" }}
                >
                  ·{" "}
                  {showQuickLine ? (
                    <span className="quick-line-wrap">
                      <input
                        id="quick-line-input"
                        type="number"
                        min={1}
                        max={totalLines}
                        value={quickLineVal}
                        onChange={(e) => setQuickLineVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") jumpToLine();
                          if (e.key === "Escape") setShowQuickLine(false);
                        }}
                        autoFocus
                      />
                      /{totalLines}
                    </span>
                  ) : (
                    <span>{posLine}</span>
                  )}
                </span>
              </>
            )}
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
        ) : binaryError ? (
          <div className="editor-binary" role="alert">
            <p>Файл похож на бинарный, редактирование отключено.</p>
            <button type="button" className="primary" onClick={onClose}>
              Закрыть
            </button>
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
              disabled={loading}
            >
              Повторить
            </button>
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="editor-area mono"
            aria-label={`Содержимое файла ${fileName}`}
            value={text}
            spellCheck={false}
            onChange={(e) => editText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => updateCursor()}
            onSelect={() => updateCursor()}
            onKeyUp={() => updateCursor()}
            autoFocus
          />
        )}

        {/* Панели результатов попыток — между textarea и кнопками (п.1, 6, 7) */}
        {conflict && !loading && !error && (
          <div className="editor-conflict" role="alert">
            <p className="editor-conflict-text">
              Файл изменился на сервере, пока вы редактировали.
            </p>
            <div className="editor-conflict-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void resolveKeepLocal()}
                disabled={saving}
              >
                {saving ? "Сохранение…" : "Обновить базу и сохранить"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void resolveTakeServer()}
                disabled={saving}
              >
                Взять серверную версию
              </button>
            </div>
          </div>
        )}
        {needsJsonValidation && jsonError && !conflict && !loading && !error && (
          <div className="editor-json-warning" role="alert">
            <p className="editor-json-text">
              <strong>JSON некорректен</strong>
              <span className="editor-json-detail mono">
                {jsonError.message} (строка {jsonError.line}, колонка{" "}
                {jsonError.col})
              </span>
            </p>
            <button
              type="button"
              className="danger"
              onClick={() => void save(true)}
              disabled={saving}
            >
              Сохранить всё равно
            </button>
          </div>
        )}
        {saveError && !conflict && !loading && !error && (
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
            onClick={() => void save()}
            disabled={
              Boolean(
                saving || loading || error || binaryError || conflict || !dirty,
              )
            }
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
