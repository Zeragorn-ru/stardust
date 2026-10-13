// Общий слой периодической загрузки данных: опрос с паузой на скрытой
// вкладке, защита от наложения запросов и различение первого сбоя
// (данных нет) от фонового (данные есть, но устарели).
//
// Паттерн портирован из LogsView: скрытая вкладка не опрашивается,
// при возврате данные подтягиваются сразу, чтобы не показывать
// устаревшее; поздний ответ не перетирает свежий (inFlight).

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";

export interface AsyncDataState<T> {
  /** Загруженные данные (null, пока первая загрузка не завершена). */
  data: T | null;
  /** Первая загрузка: ещё ни одного завершённого запроса. */
  loading: boolean;
  /** Любой запрос в полёте: первый, ручной или фоновый. */
  refreshing: boolean;
  /**
   * Последний сбой. При непустых данных трактуется как «данные устарели»
   * (StaleBanner), при пустых — как ошибка загрузки (ErrorPanel).
   */
  error: string | null;
  /** Ручной/повторный запуск первой загрузки. */
  reload: () => void;
}

export interface UseAsyncDataOptions {
  /** Период опроса в мс; без параметра (или 0) — без опроса. */
  pollMs?: number;
}

function errorText(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : "Нет соединения с сервером";
}

/**
 * Загрузка данных с опросом.
 *
 * `fetcher` должен быть стабильным (useCallback) — хук подписывается
 * на его смену и перевыгружает данные. Защита от наложения: пока идёт
 * запрос, новый не стартует; интервал останавливается на document.hidden,
 * а при возврате на вкладку выполняется немедленный догруз.
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  { pollMs }: UseAsyncDataOptions = {},
): AsyncDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    // Защита от наложения запросов: интервал, возврат на вкладку и ручное
    // «Обновить» могут сработать подряд — второй запрос не стартует, пока
    // идёт первый, иначе поздний ответ перетёр бы свежий.
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const result = await fetcher();
      setData(result);
      // Ошибку сбрасываем только после успеха: иначе при неудачном фоне
      // список успевает мигнуть пустым состоянием между повторами.
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetcher]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!pollMs) return;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      if (timer === undefined) timer = window.setInterval(() => void load(), pollMs);
    };
    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        // Возврат на вкладку: данные могли протухнуть на паузе — тянем сразу.
        void load();
        start();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, pollMs]);

  const reload = useCallback(() => { void load(); }, [load]);

  return { data, loading, refreshing, error, reload };
}
