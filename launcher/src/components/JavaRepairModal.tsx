import { useEffect, useRef, useState } from "react";
import type { Progress } from "../types";
import { installFixedJava, onJavaProgress } from "../api";

interface Props {
  /** Managed-вендор текущего рантайма — чтобы не пересаживать на чужую сборку. */
  vendor: string | null;
  onClose: () => void;
  /** Установка завершена: родитель перечитывает список установок. */
  onInstalled: () => void;
}

type Status = "installing" | "done" | "error";

/**
 * Блокирующее окно замены уязвимой Java на исправленную сборку.
 *
 * Открывается сразу по кнопке «Исправить» и само начинает загрузку: ждать
 * подтверждения внутри окна незачем, игрок уже нажал. Пока идёт скачивание,
 * Escape и клик по подложке игнорируются — операция удаляет и переписывает
 * каталог runtime, и «закрыть на середине» означало бы бросить интерфейс без
 * индикатора, не отменив саму работу.
 */
export default function JavaRepairModal({ vendor, onClose, onInstalled }: Props) {
  const [status, setStatus] = useState<Status>("installing");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  // Попытка растёт при повторе: каждая — новый запуск установки.
  const [attempt, setAttempt] = useState(0);
  // Колбэк и вендор держим в ref: родитель передаёт их инлайном, и в
  // зависимостях эффекта они перезапускали бы скачивание на каждом ре-рендере.
  const propsRef = useRef({ vendor, onInstalled });
  propsRef.current = { vendor, onInstalled };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      unlisten = await onJavaProgress((p) => {
        if (!cancelled) setProgress(p);
      });
      try {
        await installFixedJava(propsRef.current.vendor);
        if (cancelled) return;
        setStatus("done");
        propsRef.current.onInstalled();
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      } finally {
        unlisten?.();
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [attempt]);

  function retry() {
    setStatus("installing");
    setError(null);
    setProgress(null);
    setAttempt((n) => n + 1);
  }

  // Escape закрывает окно только когда загрузка уже закончилась (успехом или
  // ошибкой): прерывать саму установку нечем, отмены в бэкенде нет.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (status !== "installing") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status, onClose]);

  const installing = status === "installing";
  // `fraction` — общий прогресс подготовки игры, у Java этап первый и он
  // упирается в свой вес. Доля загрузки — `stageFraction`.
  const fraction = progress?.stageFraction ?? progress?.fraction ?? null;
  const percent =
    fraction != null && Number.isFinite(fraction)
      ? Math.round(Math.min(Math.max(fraction, 0), 1) * 100)
      : null;

  return (
    <div
      className="modal-overlay"
      onClick={
        installing
          ? undefined
          : (e) => {
              if (e.target === e.currentTarget) onClose();
            }
      }
    >
      <div
        className="modal java-repair"
        role="dialog"
        aria-modal="true"
        aria-labelledby="java-repair-title"
      >
        <div className="modal__header">
          <h2 id="java-repair-title">
            {status === "done"
              ? "Java обновлена"
              : status === "error"
                ? "Не удалось обновить Java"
                : "Обновляем Java"}
          </h2>
        </div>

        <div className="java-repair__body">
          {status === "installing" && (
            <>
              <p className="muted java-repair__text">
                Скачиваем сборку, где CVE-2026-114938 уже закрыта. Не закрывайте
                лаунчер — после загрузки старая Java будет заменена.
              </p>
              <div className="update-card__bar-track">
                <div
                  className={
                    "update-card__bar-fill" +
                    (percent == null ? " update-card__bar-fill--indeterminate" : "")
                  }
                  style={percent != null ? { width: `${percent}%` } : undefined}
                />
              </div>
              <div className="update-card__meta">
                {percent != null && (
                  <span className="update-card__meta-item update-card__meta-pct">
                    {percent}%
                  </span>
                )}
                {progress?.label && (
                  <span className="update-card__meta-item">{progress.label}</span>
                )}
              </div>
            </>
          )}

          {status === "done" && (
            <p className="java-repair__text">
              Установлена исправленная сборка. Лаунчер теперь будет запускать
              игру на ней — предупреждение уйдёт, как только обновится список.
            </p>
          )}

          {status === "error" && (
            <p className="java-repair__text java-repair__text--error" role="alert">
              {error ?? "Неизвестная ошибка"}
            </p>
          )}
        </div>

        <div className="modal__footer">
          {status === "error" ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Закрыть
              </button>
              <button type="button" className="btn btn--primary" onClick={retry}>
                Повторить
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={onClose}
              disabled={installing}
            >
              {installing ? "Скачивание…" : "Готово"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
