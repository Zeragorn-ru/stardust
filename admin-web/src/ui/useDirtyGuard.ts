// Единый dirty-guard для редакторов с несохранёнными изменениями.
//
// Паттерн — tryClose из CreateBuildForm: Escape и клик по подложке не
// закрывают форму молча, а спрашивают подтверждение, если есть правки.
// В iOS standalone-PWA window.confirm вообще не отображается, поэтому
// используется styled-диалог useConfirm (ui/feedback).

import { useCallback, useRef } from "react";
import { useConfirm } from "./feedback";

export interface UseDirtyGuardOptions {
  /** Есть ли несохранённые изменения (проверяется на момент закрытия). */
  isDirty: boolean | (() => boolean);
  /** Идёт ли сохранение: во время запроса форму закрывать нельзя. */
  isBusy?: boolean | (() => boolean);
  /** Собственно закрытие — вызывается только после подтверждения. */
  onClose: () => void;
  /** Тексты диалога подтверждения. */
  title?: string;
  body?: string;
  confirmText?: string;
}

/**
 * Возвращает `tryClose()`, безопасный к передаче в onClick подложки и
 * в Escape-обработчик useDialogFocus. Значения isDirty/isBusy читаются
 * на момент вызова (поддерживаются и функции), чтобы не протухнуть в
 * замыкании обработчика.
 */
export function useDirtyGuard({
  isDirty,
  isBusy = false,
  onClose,
  title = "Есть несохранённые изменения",
  body = "Закрыть без сохранения?",
  confirmText = "Закрыть",
}: UseDirtyGuardOptions): () => Promise<void> {
  const confirm = useConfirm();

  // Ref-мостик к актуальным значениям: колбэки и хуки держат старые
  // замыкания, а проверка должна видеть текущее состояние формы.
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const busyRef = useRef(isBusy);
  busyRef.current = isBusy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  return useCallback(async () => {
    const dirty = typeof dirtyRef.current === "function"
      ? dirtyRef.current()
      : dirtyRef.current;
    const busy = typeof busyRef.current === "function"
      ? busyRef.current()
      : busyRef.current;
    if (busy) return;
    if (dirty) {
      const ok = await confirm({
        title,
        body,
        confirmText,
        danger: true,
      });
      if (!ok) return;
    }
    closeRef.current();
    // Тексты диалога тоже через ref — чтобы tryClose оставался стабильным.
  }, [confirm, title, body, confirmText]);
}
