import { useState } from "react";
import { useMotion } from "../motion";

interface Props {
  onDone: () => void;
}

/** Первичный экран: выбор режима анимаций при первом запуске. */
export default function OnboardingScreen({ onDone }: Props) {
  const { animations, setAnimations } = useMotion();
  // Локальный выбор до подтверждения, чтобы превью реагировало сразу.
  const [choice, setChoice] = useState(animations);

  function apply(on: boolean) {
    setChoice(on);
    setAnimations(on); // мгновенное превью эффекта
  }

  return (
    <div className="onboarding glass-in">
      <h1 className="onboarding__title">Добро пожаловать</h1>
      <p className="muted onboarding__lead">
        Настроим внешний вид. Это можно изменить в любой момент в настройках.
      </p>

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

      <button className="btn btn--primary onboarding__cta" onClick={onDone}>
        Продолжить
      </button>
    </div>
  );
}
