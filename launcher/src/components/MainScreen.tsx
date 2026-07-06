import { useEffect, useState } from "react";
import type { BanInfo, PlayerProfile, PlayerStats, Progress, Settings } from "../types";
import { accountInfo, getSettings, getStats, onStatsUpdated, playGame } from "../api";
import { formatBytes } from "../format";
import { useSkin } from "../skin";
import FaceAvatar from "./FaceAvatar";
import SkinViewer3D from "./SkinViewer3D";
import CustomizeModal from "./CustomizeModal";
import MinecraftNickname from "./MinecraftNickname";

const SERVER_HOST = "play.stardust-mc.xyz";
const SERVER_STATUS_INTERVAL = 60_000;
const ACCOUNT_STATUS_INTERVAL = 60_000;

/** Цвет индикатора пинга: зелёный <80мс, жёлтый <200мс, красный иначе. */
function pingColor(ping: number | null): string {
  if (ping == null) return "var(--muted)";
  if (ping < 80) return "#5cb8a8";
  if (ping < 200) return "#d4a843";
  return "#e06060";
}

interface Props {
  profile: PlayerProfile;
  progress: Progress | null;
  running: boolean;
  busy: boolean;
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
  onProgressChange,
  onRunningChange,
  onOpenSettings,
  onLogout,
}: Props) {
  const { skin } = useSkin();
  const [skinOpen, setSkinOpen] = useState(false);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [serverPlayers, setServerPlayers] = useState<number | null>(null);
  const [serverMax, setServerMax] = useState<number | null>(null);
  const [serverPing, setServerPing] = useState<number | null>(null);
  const [serverSample, setServerSample] = useState<{name: string, id: string}[]>([]);
  const [windowFocused, setWindowFocused] = useState(true);
  const [ban, setBan] = useState<BanInfo | null>(profile.ban ?? null);

  // Загружаем статистику и настройки при монтировании.
  useEffect(() => {
    getStats().then(setStats).catch(() => undefined);
    getSettings().then(setSettings).catch(() => undefined);
    accountInfo().then((info) => setBan(info.ban ?? info.profile.ban ?? null)).catch(() => undefined);
  }, []);

  useEffect(() => {
    setBan(profile.ban ?? null);
  }, [profile.ban]);

  useEffect(() => {
    async function refreshAccountStatus() {
      try {
        const info = await accountInfo();
        setBan(info.ban ?? info.profile.ban ?? null);
      } catch {
        // Не мешаем запуску лаунчера, если статус временно недоступен.
      }
    }
    const id = setInterval(refreshAccountStatus, ACCOUNT_STATUS_INTERVAL);
    return () => clearInterval(id);
  }, []);

  // Обновляем статистику после завершения сессии.
  useEffect(() => {
    if (!running) {
      getStats().then(setStats).catch(() => undefined);
    }
  }, [running]);

  // Слушаем фокус окна Tauri — скрываем модель при сворачивании.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    async function setup() {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const unlisten = await win.onFocusChanged(({ payload: focused }) => {
          setWindowFocused(focused);
        });
        unlistenFn = unlisten;
      } catch {
        // Не Tauri — пропускаем.
      }
    }
    void setup();
    return () => unlistenFn?.();
  }, []);

  // Слушаем фоновое обновление статистики с бэкенда (каждые 15 мин).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onStatsUpdated((s) => setStats(s)).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // Статус сервера — опрашиваем через бэкенд (Tauri invoke), fallback на fetch.
  useEffect(() => {
    async function checkServer() {
      try {
        const mod = await import("@tauri-apps/api/core");
        const result = await (mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<{ online: boolean; players: number | null; max: number | null; ping: number | null; sample: {name: string, id: string}[] }>)(
          "ping_minecraft_server",
          { host: SERVER_HOST },
        );
        setServerOnline(result.online);
        setServerPlayers(result.players);
        setServerMax(result.max);
        setServerPing(result.ping ?? null);
        setServerSample(result.sample || []);
      } catch {
        setServerOnline(null);
        setServerPlayers(null);
        setServerSample([]);
      }
    }
    checkServer();
    const id = setInterval(checkServer, SERVER_STATUS_INTERVAL);
    return () => clearInterval(id);
  }, []);

  async function handlePlay() {
    if (ban) {
      onProgressChange({ phase: "error", label: banPlayMessage(ban), fraction: null });
      return;
    }
    onProgressChange({ phase: "checking", label: "Готовим игру…", fraction: null });
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
            <FaceAvatar dataUrl={skin.dataUrl} size={42} />
          </div>
          <div className="account__info">
            <div className="account__name nick-display">
              <MinecraftNickname
                name={profile.name}
                badge={profile.activeBadge}
                gradient={profile.activeGradient}
              />
            </div>
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
          {settings?.show3dModel !== false ? (
            <SkinViewer3D
              dataUrl={skin.dataUrl}
              model={skin.model}
              capeUrl={skin.capeUrl}
              width={240}
              height={340}
              visible={windowFocused && !running}
            />
          ) : (
            <FaceAvatar dataUrl={skin.dataUrl} size={240} />
          )}
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
          {ban && (
            <div className="ban-banner stagger-item" role="status">
              <div className="ban-banner__eyebrow">Доступ к серверу ограничен</div>
              <strong>{banUntilLabel(ban)}</strong>
              <p>{ban.reason?.trim() ? ban.reason : "Причина не указана."}</p>
            </div>
          )}
          <div className="hero__info-row stagger-item">
              <div className="hero__stats">
                <div className="hero__stats-title">Статистика</div>
                {stats != null ? (
                  <>
                    <div className="hero__stat">
                      <span className="hero__stat-value">{formatPlaytime(stats.playtimeSeconds)}</span>
                      <span className="hero__stat-label">в игре</span>
                    </div>
                    {stats.lastJoinedAt != null && (
                      <div className="hero__stat">
                        <span className="hero__stat-value">{formatLastJoin(stats.lastJoinedAt)}</span>
                        <span className="hero__stat-label">последний заход</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="hero__stat">
                    <span className="hero__stat-value skeleton-text" />
                    <span className="hero__stat-label skeleton-text" />
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
                        Онлайн {serverPing != null && (
                          <span style={{ color: pingColor(serverPing) }}>
                            · {serverPing}мс
                          </span>
                        )}
                      </span>
                      <span className="hero__stat-label">статус</span>
                    </div>
                    <div className="hero__stat">
                      <span className="hero__stat-value">
                        {serverPlayers != null ? serverPlayers : "—"}
                        {serverMax != null ? <span className="hero__stat-max">/{serverMax}</span> : null}
                      </span>
                      <span className="hero__stat-label">игроков</span>
                      {serverSample.length > 0 && (
                        <div className="hero__stat-facepile" title={serverSample.map(s => s.name).join(", ")}>
                          {serverSample.slice(0, 5).map((player, i) => (
                            <img 
                              key={player.id} 
                              src={`https://crafatar.com/avatars/${player.id}?size=24&overlay=true`} 
                              alt={player.name}
                              className="facepile-img"
                              style={{ zIndex: 10 - i }}
                            />
                          ))}
                          {serverSample.length > 5 && (
                            <div className="facepile-more" style={{ zIndex: 0 }}>
                              +{serverSample.length - 5}
                            </div>
                          )}
                        </div>
                      )}
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
              disabled={busy || !!ban}
            >
              <span className="play-button__top">
                <span>
                  {ban ? "Сервер недоступен" : running ? "Игра запущена" : busy ? "Подготовка…" : "Играть"}
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
        </div>
      </section>

      {skinOpen && <CustomizeModal playerName={profile.name} onClose={() => setSkinOpen(false)} />}
    </div>
  );
}

function hasDownloadMeta(progress: Progress): boolean {
  return progress.downloadedBytes != null || progress.totalBytes != null;
}

function banUntilLabel(ban: BanInfo): string {
  if (!ban.bannedUntil) return "Бан навсегда";
  const date = new Date(ban.bannedUntil);
  if (Number.isNaN(date.getTime())) return `Бан до ${ban.bannedUntil}`;
  return `Бан до ${date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function banPlayMessage(ban: BanInfo): string {
  const reason = ban.reason?.trim();
  return reason ? `${banUntilLabel(ban)}: ${reason}` : banUntilLabel(ban);
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

function formatLastJoin(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, "0");
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const yearPart = d.getFullYear() !== new Date().getFullYear() ? `.${d.getFullYear()}` : "";
  return `${day}.${mon}${yearPart} ${time}`;
}
