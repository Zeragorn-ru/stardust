import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { getAnimations, setAnimations as persist } from "./preferences";

interface MotionContextValue {
  /** Включены ли анимации. */
  animations: boolean;
  /** Переключить и сохранить выбор. */
  setAnimations: (on: boolean) => void;
}

const MotionContext = createContext<MotionContextValue>({
  animations: true,
  setAnimations: () => {},
});

/** Провайдер состояния анимаций; держит выбор в синхроне с localStorage и DOM. */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [animations, setState] = useState(getAnimations());

  function setAnimations(on: boolean) {
    persist(on); // пишет в localStorage + ставит data-motion
    setState(on);
  }

  return (
    <MotionContext.Provider value={{ animations, setAnimations }}>
      {children}
    </MotionContext.Provider>
  );
}

export function useMotion(): MotionContextValue {
  return useContext(MotionContext);
}
