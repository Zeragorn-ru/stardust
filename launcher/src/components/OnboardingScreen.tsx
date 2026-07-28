import { useState } from "react";
import type { DataDirectoryInfo } from "../types";
import { chooseDataDirectory, relocateDataDirectory } from "../api";
import { useMotion } from "../motion";

interface Props {
  dataDirectory: DataDirectoryInfo;
  onDone: () => void;
}

/** Первичный экран: место хранения данных и выбор режима анимаций. */
export default function OnboardingScreen({ dataDirectory, onDone }: Props) {
  const { animations, setAnimations } = useMotion();
  const [choice, setChoice] = useState(animations);
  const [dataPath, setDataPath] = useState(dataDirectory.path);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(on: boolean) {
    setChoice(on);
    setAnimations(on); // мгновенное превью эффекта
  }

  async function chooseFolder() {
    const path = await chooseDataDirectory();
    if (path) setDataPath(path);
  }

  async function finish() {
    setSelecting(true);
    setError(null);
    try {
      await relocateDataDirectory(dataPath);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSelecting(false);
    }
  }

  return (
    <div className="onboarding glass-in">
      <h1 className="onboarding__title">Добро пожаловать</h1>
      <p className="muted onboarding__lead">
        Выберите, где хранить игру, Java, настройки и кеш. Позже папку можно
        безопасно перенести в настройках.
      </p>

      <div className="onboarding__data-dir">
        <span className="choice__title">Папка данных</span>
        <span className="muted choice__desc">
          Для своей папки выберите пустой каталог. Это удобно, например, для другого диска.
        </span>
        <div className="onboarding__path-row">
          <code title={dataPath}>{dataPath}</code>
          <button type="button" className="btn btn--ghost" onClick={() => void chooseFolder()} disabled={selecting}>
            Выбрать папку
          </button>
        </div>
        <button
          type="button"
          className="onboarding__default-path"
          onClick={() => setDataPath(dataDirectory.defaultPath)}
          disabled={selecting || dataPath === dataDirectory.defaultPath}
        >
          Использовать рекомендуемую: {dataDirectory.defaultPath}
        </button>
      </div>

      <div className="choice-grid">
        <button
          className={"choice" + (choice ? " choice--active" : "")}
          onClick={() => apply(true)}
        >
          <div className="choice__visual choice__visual--anim">
            <span className="orb orb--a" />
            <span className="orb orb--b" />
          </div>
          <div className="choice__title">Красиво</div>
          <div className="choice__desc muted">
            Плавные анимации и живой фон
          </div>
        </button>

        <button
          className={"choice" + (!choice ? " choice--active" : "")}
          onClick={() => apply(false)}
        >
          <div className="choice__visual choice__visual--calm">
            <span className="bar" />
            <span className="bar" />
            <span className="bar" />
          </div>
          <div className="choice__title">Экономно</div>
          <div className="choice__desc muted">
            Без анимаций, меньше нагрузка
          </div>
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      <button className="btn btn--primary onboarding__cta" onClick={() => void finish()} disabled={selecting}>
        {selecting ? "Подготавливаем папку…" : "Продолжить"}
      </button>
    </div>
  );
}
