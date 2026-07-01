import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Skin, SkinModel } from "./types";
import { getSkin, loadSkinCache, setSkin as persistSkin } from "./api";

interface SkinContextValue {
  skin: Skin;
  /** Перечитать скин из бэкенда. */
  reload: () => Promise<void>;
  /** Сохранить новый скин (data-URL PNG + модель) и обновить состояние. */
  save: (dataUrl: string, model: SkinModel) => Promise<void>;
}

const DEFAULT_SKIN: Skin = {
  dataUrl: null,
  model: "classic",
  capeUrl: null,
  source: null,
};

const SkinContext = createContext<SkinContextValue>({
  skin: DEFAULT_SKIN,
  reload: async () => {},
  save: async () => {},
});

/** Провайдер скина игрока: общий для аватарки, 3D-модели и модалки смены. */
export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState<Skin>(DEFAULT_SKIN);

  const reload = useCallback(async () => {
    const s = await getSkin();
    setSkinState(s);
  }, []);

  useEffect(() => {
    // Мгновенно показываем кеш с диска, затем обновляем с сервера.
    loadSkinCache().then((cached) => {
      if (cached) setSkinState(cached);
      // Всегда обновляем с сервера (кеш мог устареть).
      reload();
    });
  }, []);

  const save = useCallback(async (dataUrl: string, model: SkinModel) => {
    await persistSkin(dataUrl, model);
    setSkinState({ dataUrl, model, capeUrl: null, source: null });
  }, []);

  const value = useMemo(() => ({ skin, reload, save }), [skin, reload, save]);

  return (
    <SkinContext.Provider value={value}>
      {children}
    </SkinContext.Provider>
  );
}

export function useSkin(): SkinContextValue {
  return useContext(SkinContext);
}
