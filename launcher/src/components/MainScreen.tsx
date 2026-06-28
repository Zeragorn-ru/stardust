import { useEffect, useRef, useState } from "react";
import type { PlayerProfile, PlayerStats, Progress } from "../types";
import { getStats, playGame } from "../api";
import { formatBytes } from "../format";
import { useSkin } from "../skin";
import FaceAvatar from "./FaceAvatar";
import SkinViewer3D from "./SkinViewer3D";
import CustomizeModal from "./CustomizeModal";

const SERVER_HOST = "play.stardust-mc.xyz";
const SERVER_STATUS_INTERVAL = 60_000;

interface Props {
  profile: PlayerProfile;
  progress: Progress | null;
  running: boolean;
  busy: boolean;
  logs: string[];
  onProgressChange: (p: Progress | null) => void;
  onRunningChange: (r: boolean) => void;
  onOpenSettings: (section?: "general" | "account") => void;
  onLogout: () => void;
}

export default function MainScreen({
  profile,
  progress,
  running,
  busy,
  logs,
  onProgressChange,
  onRunningChange,
  onOpenSettings,
  onLogout,
}: Props) {
  const { skin } = useSkin();
  const [skinOpen, setSkinOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [serverPlayers, setServerPlayers] = useState<number | null>(null);
  const [serverMax, setServerMax] = useState<number | null>(null);

  // Загружаем статистику при монтировании.
  useEffect(() => {
    getStats().then(setStats).catch(() => undefined);
  }, []);

  // Обновляем статистику после завершения сессии.
  useEffect(() => {
    if (!running) {
      getStats().then(setStats).catch(() => undefined);
    }
  }, [running]);

  // Статус сервера — опрашиваем через бэкенд (Tauri invoke), fallback на fetch.
  useEffect(() => {
    async function checkServer() {
      try {
        const mod = await import("@tauri-apps/api/core");
        const result = await (mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<{ online: boolean; players: number | null; max: number | null; ping: number | null }>)(
          "ping_minecraft_server",
          { host: SERVER_HOST },
        );
        setServerOnline(result.online);
        setServerPlayers(result.players);
        setServerMax(result.max);
      } catch {
        setServerOnline(null);
        setServerPlayers(null);
      }
    }
    checkServer();
    const id = setInterval(checkServer, SERVER_STATUS_INTERVAL);
    return () => clearInterval(id);
  }, []);

  async function handlePlay() {
    onProgressChange({ phase: "checking", label: "Готовим игру…", fraction: null });
    // Оптимистично обновляем lastLaunchedAt сразу.
    setStats((s) =>
      s ? { ...s, lastLaunchedAt: new Date().toISOString() } : s,
    );
    try {
      await playGame();
      onRunningChange(true);
      onProgressChange({ phase: "running", label: "Игра запущена", fraction: null });
    } catch (err) {
      onProgressChange({
        phase: "error",
        label: err instanceof Error ? err.message : String(err),
        fraction: null,
      });
    }
  }

  function handleDismissError() {
    onProgressChange(null);
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
            type="button"
            className="btn btn--ghost hero__skin-btn"
            aria-label="Кастомизация"
            onClick={() => setSkinOpen(true)}
          >
            Кастомизация
          </button>
        </div>
        <div className="hero__launch-card stagger stagger-item">
          <div className="hero__card stagger-item">
            <h2>Всё готово к приключению</h2>
            <p className="muted">
              Нажми «Играть» — мы всё подготовим сами и запустим игру под твоим
              именем. Ничего настраивать не нужно.
            </p>
          </div>
          {stats != null && (
            <div className="hero__info-row stagger-item">
              <div className="hero__stats">
                <div className="hero__stats-title">Статистика</div>
                <div className="hero__stat">
                  <span className="hero__stat-value">{formatPlaytime(stats.playtimeSeconds)}</span>
                  <span className="hero__stat-label">в игре</span>
                </div>
                {stats.lastLaunchedAt != null && (
                  <div className="hero__stat">
                    <span className="hero__stat-value">{formatLastLaunch(stats.lastLaunchedAt)}</span>
                    <span className="hero__stat-label">последний запуск</span>
                  </div>
                )}
              </div>
              <div className="hero__stats">
                <div className="hero__stats-title">Сервер</div>
                {serverOnline === null ? (
                  <div className="hero__stat">
                    <span className="hero__stat-value hero__stat-value--muted">—</span>
                    <span className="hero__stat-label">недоступен</span>
                  </div>
                ) : serverOnline ? (
                  <>
                    <div className="hero__stat">
                      <span className="hero__stat-value hero__stat-value--online">
                        Онлайн <span className="hero__stat-value--ping">· {profile.name}</span>
                      </span>
                      <span className="hero__stat-label">статус</span>
                    </div>
                    <div className="hero__stat">
                      <span className="hero__stat-value">
                        {serverPlayers != null ? serverPlayers : "—"}
                        {serverMax != null ? <span className="hero__stat-max">/{serverMax}</span> : null}
                      </span>
                      <span className="hero__stat-label">игроков</span>
                    </div>
                  </>
                ) : (
                  <div className="hero__stat">
                    <span className="hero__stat-value hero__stat-value--offline">Офлайн</span>
                    <span className="hero__stat-label">статус</span>
                  </div>
                )}
              </div>
            </div>
          )}
          {progress?.phase === "error" ? (
            <div className="play-error stagger-item">
              <span className="play-error__msg">{progress.label}</span>
              <button
                type="button"
                className="btn btn--play btn--play-retry"
                onClick={handleDismissError}
              >
                Попробовать снова
              </button>
            </div>
          ) : (
            <button
              className="btn btn--play stagger-item"
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
          )}
          {busy && logs.length > 0 && (
            <div className="launch-log">
              {logs.map((line, i) => (
                <div key={i} className="launch-log__line">{line}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </section>

      {skinOpen && <CustomizeModal onClose={() => setSkinOpen(false)} />}
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

function formatPlaytime(seconds: number): string {
  if (seconds < 60) return `${seconds}с`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}м`;
  return `${h}ч ${m}м`;
}

function formatLastLaunch(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, "0");
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const yearPart = d.getFullYear() !== new Date().getFullYear() ? `.${d.getFullYear()}` : "";
  return `${day}.${mon}${yearPart} ${time}`;
}

