import { useState } from "react";
import { IDLE_ANIMATIONS } from "../animations";
import { useSkin } from "../skin";
import SkinViewer3D from "./SkinViewer3D";

/** Ручная проверка клипов в отдельном окне. */
export default function DebugAnimations() {
  const { skin } = useSkin();
  const [playback, setPlayback] = useState({ name: null as string | null, sequence: 0, paused: false, speed: 1 });

  return (
    <main style={{ padding: "32px", maxWidth: 680, margin: "auto" }}>
      <h1>Отладка анимаций</h1>
      <p className="muted">Выберите анимацию, чтобы воспроизвести её на текущем скине. Модель можно вращать мышью.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 28, alignItems: "center" }}>
        <SkinViewer3D dataUrl={skin.dataUrl} model={skin.model} capeUrl={skin.capeUrl} width={240} height={340} interactive debugPlayback={playback} />
        <div style={{ display: "grid", gap: 14, minWidth: 200 }}>
          <strong>Анимации</strong>
          {IDLE_ANIMATIONS.map((anim) => (
            <button key={anim.name} type="button" className="btn btn--ghost" onClick={() => setPlayback((p) => ({ ...p, name: anim.name, sequence: p.sequence + 1, paused: false }))}>
              ▶ {anim.name}
            </button>
          ))}
          <button type="button" className="btn btn--ghost" disabled={!playback.name} onClick={() => setPlayback((p) => ({ ...p, paused: !p.paused }))}>
            {playback.paused ? "Продолжить" : "Пауза"}
          </button>
          <button type="button" className="btn btn--ghost" disabled={!playback.name} onClick={() => setPlayback((p) => ({ ...p, name: null, sequence: p.sequence + 1, paused: false }))}>Остановить</button>
          <label>Скорость: {playback.speed.toFixed(1)}×<br />
            <input type="range" min="0.1" max="3" step="0.1" value={playback.speed} onChange={(e) => setPlayback((p) => ({ ...p, speed: Number(e.target.value) }))} />
          </label>
          <span className="muted">Выбрано: {playback.name ?? "нет"}</span>
        </div>
      </div>
    </main>
  );
}
