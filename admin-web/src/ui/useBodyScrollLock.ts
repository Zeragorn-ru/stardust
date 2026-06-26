// Блокирует прокрутку страницы под открытой модалкой/диалогом.
//
// Считает количество одновременно открытых оверлеев (модалок может быть
// несколько — напр. редактор файла поверх диалога подтверждения), чтобы
// снять блокировку только когда закрылся последний.

import { useEffect } from "react";

let lockCount = 0;
let savedOverflow = "";

export function useBodyScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    lockCount++;
    return () => {
      lockCount--;
      if (lockCount === 0) {
        document.body.style.overflow = savedOverflow;
      }
    };
  }, [active]);
}
