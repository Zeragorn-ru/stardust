import {
  createContext,
  useContext,
  useEffect,
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

  async function reload() {
    const s = await getSkin();
    setSkinState(s);
  }

  useEffect(() => {
    // Мгновенно показываем кеш с диска, затем обновляем с сервера.
    loadSkinCache().then((cached) => {
      if (cached) setSkinState(cached);
      // Всегда обновляем с сервера (кеш мог устареть).
      reload();
    });
  }, []);

  async function save(dataUrl: string, model: SkinModel) {
    await persistSkin(dataUrl, model);
    // Ручная загрузка PNG отменяет плащ и синхронизацию лицензии на сервере.
    setSkinState({ dataUrl, model, capeUrl: null, source: null });
  }

  return (
    <SkinContext.Provider value={{ skin, reload, save }}>
      {children}
    </SkinContext.Provider>
  );
}

export function useSkin(): SkinContextValue {
  return useContext(SkinContext);
}
