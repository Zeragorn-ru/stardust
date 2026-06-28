import { useEffect, useState } from "react";
import type { PlayerProfile, Progress } from "../types";
import { gameRunning, onLauncherProgress, playGame } from "../api";
import { formatBytes } from "../format";
import { useSkin } from "../skin";
import FaceAvatar from "./FaceAvatar";
import SkinViewer3D from "./SkinViewer3D";
import SkinModal from "./SkinModal";

interface Props {
  profile: PlayerProfile;
  onOpenSettings: (section?: "general" | "account") => void;
  onLogout: () => void;
}

export default function MainScreen({
  profile,
  onOpenSettings,
  onLogout,
}: Props) {
  const { skin } = useSkin();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [skinOpen, setSkinOpen] = useState(false);
  const busy =
    running ||
    (progress != null &&
      ["checking", "downloading", "extracting", "launching"].includes(
        progress.phase,
      ));

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onLauncherProgress(setProgress).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // При монтировании проверяем, не запущена ли игра уже (напр. после возврата из настроек).
  useEffect(() => {
    gameRunning().then((alive) => {
      if (alive) {
        setRunning(true);
        setProgress({
          phase: "running",
          label: "Игра запущена",
          fraction: null,
        });
      }
    });
  }, []);

  // Пока игра жива, держим кнопку неактивной и опрашиваем статус процесса.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      if (!(await gameRunning())) {
        setRunning(false);
        setProgress(null);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [running]);

  async function handlePlay() {
    setProgress({
      phase: "checking",
      label: "Готовим игру…",
      fraction: null,
    });
    try {
      await playGame();
      // Игра запущена: держим кнопку заблокированной, пока процесс жив.
      setRunning(true);
      setProgress({ phase: "running", label: "Игра запущена", fraction: null });
    } catch (err) {
      setProgress({
        phase: "error",
        label: err instanceof Error ? err.message : String(err),
        fraction: null,
      });
    }
  }

  return (
    <div className="main">
      <header className="main__header">
        <button
          type="button"
          className="account account--link"
          onClick={() => onOpenSettings("account")}
          title="Настройки аккаунта"
        >
          <div className="account__avatar account__avatar--skin">
            <FaceAvatar dataUrl={skin.dataUrl} size={44} />
          </div>
          <div className="account__info">
            <div className="account__name">{profile.name}</div>
            <div className="account__id muted">{shortId(profile.id)}</div>
          </div>
        </button>
        <div className="main__actions">
          <button className="btn btn--ghost" onClick={() => onOpenSettings()}>
            Настройки
          </button>
          <button className="btn btn--ghost" onClick={onLogout}>
            Выйти
          </button>
        </div>
      </header>

      <section className="main__hero stagger">
        <div className="hero__skin stagger-item">
          <SkinViewer3D
            dataUrl={skin.dataUrl}
            model={skin.model}
            capeUrl={skin.capeUrl}
            width={240}
            height={340}
          />
          <button
            className="btn btn--ghost hero__skin-btn"
            onClick={() => setSkinOpen(true)}
          >
            Сменить скин
          </button>
        </div>
        <div className="hero__launch-card stagger-item">
          <div className="hero__card">
            <h2>Всё готово к приключению</h2>
            <p className="muted">
              Нажми «Играть» — мы всё подготовим сами и запустим игру под твоим
              именем. Ничего настраивать не нужно.
            </p>
          </div>
          <button
            className="btn btn--play"
            onClick={handlePlay}
            disabled={busy}
          >
            <span className="play-button__top">
              <span>
                {running ? "Игра запущена" : busy ? "Подготовка…" : "Играть"}
              </span>
              {progress && (
                <span className="play-button__percent">
                  {progress.fraction != null
                    ? `${Math.round(progress.fraction * 100)}%`
                    : progress.phase === "running"
                      ? "готово"
                      : "…"}
                </span>
              )}
            </span>
            {progress && (
              <span className="play-button__details">
                <span>{progress.label}</span>
                {hasDownloadMeta(progress) && (
                  <span>
                    {formatBytes(progress.downloadedBytes ?? 0)} /{" "}
                    {formatBytes(progress.totalBytes ?? 0)} ·{" "}
                    {formatBytes(progress.speedBytesPerSec ?? 0)}/с
                    {progress.etaSeconds != null
                      ? ` · осталось ${formatEta(progress.etaSeconds)}`
                      : ""}
                  </span>
                )}
              </span>
            )}
            {progress && (
              <span className="play-button__track" aria-hidden="true">
                <span
                  className={
                    "play-button__bar" +
                    (progress.fraction == null
                      ? " play-button__bar--indeterminate"
                      : "")
                  }
                  style={
                    progress.fraction != null
                      ? { width: `${progress.fraction * 100}%` }
                      : undefined
                  }
                />
              </span>
            )}
          </button>
        </div>
      </section>

      {skinOpen && <SkinModal onClose={() => setSkinOpen(false)} />}
    </div>
  );
}

function hasDownloadMeta(progress: Progress): boolean {
  return progress.downloadedBytes != null || progress.totalBytes != null;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}с`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return `${minutes}м ${rest}с`;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
