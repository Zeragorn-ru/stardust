import { useEffect, useRef, useState } from "react";

/**
 * Задерживает unmount компонента на `delay` мс после того, как `open` стал false.
 * Возвращает [visible, shouldRender]:
 *  - visible — false, когда запущена exit-анимация (можно добавить CSS-класс)
 *  - shouldRender — true, пока компонент ещё не размонтирован
 */
export function useDelayedUnmount(open: boolean, delay = 200) {
  const [shouldRender, setShouldRender] = useState(open);
  const [visible, setVisible] = useState(open);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (open) {
      setShouldRender(true);
      // Даём один кадр, чтобы React примонтировал DOM, и только потом ставим visible
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setVisible(true);
      });
    } else {
      setVisible(false);
      timerRef.current = setTimeout(() => {
        setShouldRender(false);
        timerRef.current = null;
      }, delay);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [open, delay]);

  return { visible, shouldRender };
}
