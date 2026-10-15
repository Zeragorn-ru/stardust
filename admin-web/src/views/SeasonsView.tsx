// Экран «Сезоны»: два раздела. Первый — сезоны с архивацией статистики
// (снимок счётчиков всех игроков в сезонные таблицы + сброс к нулю),
// второй — пульт релизов лаунчера: каналы апдейтера (какой тег раздаётся),
// CI-сборки тегов, ещё не ставших релизами, и сами релизы с переводом
// pre-release в стабильный и перестановкой latest каналов.
// Все операции — фоновые задачи на сервере: подтверждение -> POST ->
// опрос статуса с живой фазой (как деплой мода в BuildDetail).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type {
  BuildRun,
  LauncherChannel,
  LauncherRelease,
  PromoteStatus,
  Season,
  SeasonArchiveStatus,
  SetLatestStatus,
  Settings,
} from "../types";
import { formatDateTime } from "../format";
import { useConfirm, useToast } from "../ui/feedback";
import { IconAlert, IconCheck, IconSync } from "../ui/icons";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/shadcn";

// Интервал и лимит ошибок опроса задач — как у деплоя мода (BuildDetail).
const POLL_INTERVAL_MS = 2000;
const POLL_ERROR_LIMIT = 5;
// CI-опрашиваем реже: срез GitHub Actions, лимиты API не гоняем.
const CI_POLL_INTERVAL_MS = 10000;

// Свежий релиз: секунд после публикации, когда строка подсвечена.
const FRESH_RELEASE_SECS = 5 * 60;

// «1 версия / 2 версии / 5 версий».
function pluralVersions(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "версия"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "версии"
        : "версий";
  return `${count} ${word}`;
}

// «1 прогон / 2 прогона / 5 прогонов».
function pluralRuns(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "прогон"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "прогона"
        : "прогонов";
  return `${count} ${word}`;
}

export function SeasonsView() {
  const toast = useToast();
  const confirm = useConfirm();

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(true);
  const [seasonsError, setSeasonsError] = useState<string | null>(null);

  const [releases, setReleases] = useState<LauncherRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(true);
  const [releasesError, setReleasesError] = useState<string | null>(null);

  const [channels, setChannels] = useState<LauncherChannel[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  const [buildRuns, setBuildRuns] = useState<BuildRun[]>([]);
  const [buildRunsError, setBuildRunsError] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);

  // ── Архивация сезона ──
  const [archiving, setArchiving] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<SeasonArchiveStatus | null>(null);
  const archivePollRef = useRef<number | null>(null);
  const archivePollErrors = useRef(0);

  // ── Перевод релиза в стабильный ──
  const [promotingTag, setPromotingTag] = useState<string | null>(null);
  const [promoteStatus, setPromoteStatus] = useState<PromoteStatus | null>(null);
  const promotePollRef = useRef<number | null>(null);
  const promotePollErrors = useRef(0);

  // ── Перестановка latest канала ──
  const [retargeting, setRetargeting] = useState<{ channel: string; tag: string } | null>(null);
  const [setLatestStatus, setSetLatestStatus] = useState<SetLatestStatus | null>(null);
  const setLatestPollRef = useRef<number | null>(null);
  const setLatestPollErrors = useRef(0);

  // CI-опрос живёт только пока есть прогоны в очереди/в работе.
  const ciPollRef = useRef<number | null>(null);

  function stopArchivePoll() {
    if (archivePollRef.current != null) {
      window.clearInterval(archivePollRef.current);
      archivePollRef.current = null;
    }
  }

  function stopPromotePoll() {
    if (promotePollRef.current != null) {
      window.clearInterval(promotePollRef.current);
      promotePollRef.current = null;
    }
  }

  function stopSetLatestPoll() {
    if (setLatestPollRef.current != null) {
      window.clearInterval(setLatestPollRef.current);
      setLatestPollRef.current = null;
    }
  }

  function stopCiPoll() {
    if (ciPollRef.current != null) {
      window.clearInterval(ciPollRef.current);
      ciPollRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      stopArchivePoll();
      stopPromotePoll();
      stopSetLatestPoll();
      stopCiPoll();
    };
  }, []);

  const loadSeasons = useCallback(async () => {
    // Флаг ставим и на повторных вызовах, чтобы «Обновить» давал видимый
    // отклик (спиннер), а не «тихий» фоновый запрос.
    setSeasonsLoading(true);
    try {
      setSeasons(await api.getSeasons());
      setSeasonsError(null);
    } catch (err) {
      setSeasonsError(err instanceof ApiError ? err.message : "Не удалось загрузить сезоны");
    } finally {
      setSeasonsLoading(false);
    }
  }, []);

  const loadReleases = useCallback(async (showLoading = true) => {
    // Скелет «Загрузка…» — только для ручного «Обновить»: фоновые
    // перечитывания (завершение CI-сборки) не должны мигать списком.
    if (showLoading) {
      setReleasesLoading(true);
    }
    try {
      setReleases(await api.getReleases());
      setReleasesError(null);
    } catch (err) {
      setReleasesError(err instanceof ApiError ? err.message : "Не удалось загрузить релизы");
    } finally {
      if (showLoading) {
        setReleasesLoading(false);
      }
    }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      setChannels(await api.getLauncherChannels());
      setChannelsError(null);
    } catch (err) {
      setChannelsError(err instanceof ApiError ? err.message : "Не удалось загрузить каналы");
    }
  }, []);

  const loadBuildRuns = useCallback(async () => {
    try {
      const runs = await api.getBuildRuns();
      setBuildRuns(runs);
      setBuildRunsError(null);
      // Опрос CI: живёт только пока что-то собирается или ждёт очереди.
      stopCiPoll();
      if (runs.some((r) => r.state === "queued" || r.state === "running")) {
        let ciPollErrors = 0;
        let inFlight = false;
        ciPollRef.current = window.setInterval(async () => {
          // Не даём тикам перекрываться: поздний ответ старого запроса
          // не должен перетирать свежие данные.
          if (inFlight) return;
          inFlight = true;
          try {
            const next = await api.getBuildRuns();
            ciPollErrors = 0;
            setBuildRuns(next);
            setBuildRunsError(null);
            if (!next.some((r) => r.state === "queued" || r.state === "running")) {
              stopCiPoll();
              // Сборка закончилась — перечитываем релизы и каналы: тег
              // мог стать релизом, а launcher-beta — обновиться.
              await loadReleases(false);
              await loadChannels();
            }
          } catch {
            // Сетевые сбои и лимиты GitHub не должны молотить вечно:
            // как у остальных опросов, гасим после 5 неудач подряд.
            ciPollErrors += 1;
            if (ciPollErrors >= POLL_ERROR_LIMIT) {
              stopCiPoll();
            }
          } finally {
            inFlight = false;
          }
        }, CI_POLL_INTERVAL_MS);
      }
    } catch (err) {
      setBuildRunsError(err instanceof ApiError ? err.message : "Не удалось загрузить сборки");
    }
  }, [loadReleases, loadChannels]);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch {
      // Подсказка про токен не критична — молча пропускаем.
    }
  }, []);

  // Один «Обновить» перечитывает все срезы раздела релизов.
  const loadAllReleases = useCallback(async () => {
    await Promise.all([loadReleases(), loadChannels(), loadBuildRuns()]);
  }, [loadReleases, loadChannels, loadBuildRuns]);

  useEffect(() => {
    void loadSeasons();
    void loadAllReleases();
    void loadSettings();
  }, [loadSeasons, loadAllReleases, loadSettings]);

  // При заходе на экран подхватываем идущие фоновые задачи: если архивация
  // или перевод релиза уже выполняются (админ перезагрузил страницу),
  // продолжаем их наблюдать, а не стартуем повторно.
  useEffect(() => {
    let cancelled = false;
    async function adoptRunning() {
      try {
        const s = await api.getSeasonArchiveStatus();
        if (!cancelled && s.state === "running") {
          setArchiving(true);
          setArchiveStatus(s);
          startArchivePoll();
        }
      } catch {
        /* не критично */
      }
      try {
        const p = await api.getPromoteStatus();
        if (!cancelled && p.state === "running") {
          setPromotingTag(p.tag);
          setPromoteStatus(p);
          startPromotePoll();
        }
      } catch {
        /* не критично */
      }
      try {
        const l = await api.getSetLatestStatus();
        if (!cancelled && l.state === "running") {
          setRetargeting({ channel: l.channel ?? "", tag: l.tag ?? "" });
          setSetLatestStatus(l);
          startSetLatestPoll();
        }
      } catch {
        /* не критично */
      }
    }
    void adoptRunning();
    return () => {
      cancelled = true;
    };
  }, []);

  function startArchivePoll() {
    stopArchivePoll();
    archivePollErrors.current = 0;
    archivePollRef.current = window.setInterval(async () => {
      try {
        const s = await api.getSeasonArchiveStatus();
        archivePollErrors.current = 0;
        setArchiveStatus(s);
        // idle = статус сброшен рестартом сервера; задача результата больше
        // не пришлёт — гасим опрос, чтобы кнопка не залипала навсегда.
        if (s.state === "success" || s.state === "error" || s.state === "idle") {
          stopArchivePoll();
          setArchiving(false);
          if (s.state === "success") {
            toast.success(`Сезон «${s.seasonName ?? ""}» заархивирован. Счётчики игроков сброшены.`);
            await loadSeasons();
          } else if (s.state === "idle") {
            toast.error("Статус архивации потерян (сервер перезапущен?) — проверьте результат вручную");
          } else {
            toast.error(`Ошибка архивации: ${s.error ?? "неизвестная ошибка"}`);
          }
        }
      } catch {
        // Одиночный сетевой сбой не должен убивать опрос: даём 5 попыток.
        archivePollErrors.current += 1;
        if (archivePollErrors.current >= POLL_ERROR_LIMIT) {
          stopArchivePoll();
          setArchiving(false);
          toast.error("Не удалось получить статус архивации");
        }
      }
    }, POLL_INTERVAL_MS);
  }

  async function archiveActiveSeason() {
    const ok = await confirm({
      title: "Завершить сезон и заархивировать статистику?",
      body: "Статистика ВСЕХ игроков (время в игре, смерти, добытые блоки, дистанция) будет сфотографирована в архив сезона и сброшена в ноль для следующего сезона. Это действие нельзя отменить.",
      confirmText: "Завершить сезон",
      danger: true,
    });
    if (!ok) return;

    setArchiving(true);
    setArchiveStatus(null);
    try {
      await api.archiveSeason();
      startArchivePoll();
    } catch (err) {
      setArchiving(false);
      toast.error(err instanceof ApiError ? err.message : "Не удалось запустить архивацию");
    }
  }

  function startPromotePoll() {
    stopPromotePoll();
    promotePollErrors.current = 0;
    promotePollRef.current = window.setInterval(async () => {
      try {
        const s = await api.getPromoteStatus();
        promotePollErrors.current = 0;
        setPromoteStatus(s);
        // idle = статус сброшен рестартом сервера (см. archive poll).
        if (s.state === "success" || s.state === "error" || s.state === "idle") {
          stopPromotePoll();
          setPromotingTag(null);
          if (s.state === "success") {
            toast.success(`Релиз ${s.tag ?? ""} переведён в стабильный канал`);
            await Promise.all([loadReleases(false), loadChannels(), loadBuildRuns()]);
          } else if (s.state === "idle") {
            toast.error("Статус перевода в стабильный потерян (сервер перезапущен?) — проверьте релизы вручную");
          } else {
            toast.error(`Ошибка перевода в стабильный: ${s.error ?? "неизвестная ошибка"}`);
          }
        }
      } catch {
        // Одиночный сетевой сбой не должен убивать опрос: даём 5 попыток.
        promotePollErrors.current += 1;
        if (promotePollErrors.current >= POLL_ERROR_LIMIT) {
          stopPromotePoll();
          setPromotingTag(null);
          toast.error("Не удалось получить статус перевода релиза");
        }
      }
    }, POLL_INTERVAL_MS);
  }

  async function promoteRelease(tag: string) {
    const ok = await confirm({
      title: `Перевести ${tag} в стабильный релиз?`,
      body: "Релиз станет полноценным, и все клиенты стабильного канала получат обновление через launcher-stable.",
      confirmText: "В стабильный",
    });
    if (!ok) return;

    setPromotingTag(tag);
    setPromoteStatus(null);
    try {
      await api.promoteRelease(tag);
      startPromotePoll();
    } catch (err) {
      setPromotingTag(null);
      toast.error(err instanceof ApiError ? err.message : "Не удалось запустить перевод в стабильный");
    }
  }

  function startSetLatestPoll() {
    stopSetLatestPoll();
    setLatestPollErrors.current = 0;
    setLatestPollRef.current = window.setInterval(async () => {
      try {
        const s = await api.getSetLatestStatus();
        setLatestPollErrors.current = 0;
        setSetLatestStatus(s);
        // idle = статус сброшен рестартом сервера (см. archive poll).
        if (s.state === "success" || s.state === "error" || s.state === "idle") {
          stopSetLatestPoll();
          if (s.state === "success") {
            setRetargeting(null);
            toast.success(`Канал launcher-${s.channel ?? ""} теперь раздаёт ${s.tag ?? ""}`);
            await loadChannels();
          } else if (s.state === "idle") {
            setRetargeting(null);
            toast.error("Статус перестановки latest потерян (сервер перезапущен?) — проверьте канал вручную");
          } else {
            // Ошибка остаётся в плите канала (retargeting держим), toast —
            // кратким дублирующим сигналом.
            toast.error(`Ошибка перестановки latest: ${s.error ?? "неизвестная ошибка"}`);
          }
        }
      } catch {
        // Одиночный сетевой сбой не должен убивать опрос: даём 5 попыток.
        setLatestPollErrors.current += 1;
        if (setLatestPollErrors.current >= POLL_ERROR_LIMIT) {
          stopSetLatestPoll();
          setRetargeting(null);
          toast.error("Не удалось получить статус перестановки latest");
        }
      }
    }, POLL_INTERVAL_MS);
  }

  // Клик по пилюле канала в строке релиза: направить канал на этот тег.
  async function retargetChannel(channel: string, tag: string, currentTag: string | null) {
    // Откат: список релизов отсортирован от новых к старым, так что тег
    // ниже текущего в списке — более старый. Отличаем от продвижения вперёд.
    const currentIndex = releases.findIndex((r) => r.tag === currentTag);
    const targetIndex = releases.findIndex((r) => r.tag === tag);
    const isRollback =
      currentTag != null &&
      targetIndex >= 0 &&
      (currentIndex < 0 || targetIndex > currentIndex);
    const ok = await confirm({
      title: `Направить канал launcher-${channel} на ${tag}?`,
      body: isRollback
        ? `Выбранный релиз старее текущего (${currentTag}): клиенты, ещё не обновившиеся, откатятся на ${tag}; уже обновившиеся останутся на своей версии.`
        : `Все клиенты ${channel}-канала получат ${tag} при следующем запуске.`,
      confirmText: "Направить канал",
      danger: isRollback,
    });
    if (!ok) return;

    setRetargeting({ channel, tag });
    setSetLatestStatus(null);
    try {
      await api.setLatest(tag, channel);
      startSetLatestPoll();
    } catch (err) {
      setRetargeting(null);
      toast.error(err instanceof ApiError ? err.message : "Не удалось запустить перестановку latest");
    }
  }

  const activeSeason = seasons.find((s) => s.status === "active") ?? null;
  const archivedSeasons = seasons.filter((s) => s.status === "archived");
  const githubTokenMissing = settings != null && !settings.githubTokenSet;

  // Занятость канала: идёт перевод в стабильный или перестановка latest —
  // все канальные действия блокируются (как promotingTag у promote).
  const channelBusy = promotingTag != null || retargeting != null;

  const betaChannel = channels.find((c) => c.channel === "beta") ?? null;
  const stableChannel = channels.find((c) => c.channel === "stable") ?? null;

  // Зона «Сборка CI»: прогоны в работе и упавшие. Тег становится pre-release
  // ещё до окончания matrix (шаг ⑦ workflow), поэтому «нет релиза» —
  // неверный признак сборки; ориентируемся на состояние самого прогона.
  // Успешные завершённые прогоны скрываем: они уже в списке релизов.
  const pendingRuns = buildRuns.filter(
    (r) => r.state === "queued" || r.state === "running" || r.state === "failure" || r.state === "cancelled",
  );

  const freshTag = (() => {
    const newest = releases[0];
    if (!newest?.publishedAt) return null;
    const published = Date.parse(newest.publishedAt);
    if (!Number.isFinite(published)) return null;
    return Date.now() - published < FRESH_RELEASE_SECS * 1000 ? newest.tag : null;
  })();

  function renderChannelTile(channel: LauncherChannel | null, kind: "beta" | "stable") {
    const displayName = `launcher-${kind}`;
    const task = setLatestStatus && retargeting?.channel === kind ? setLatestStatus : null;
    return (
      <div className={`chan-tile chan-tile--${kind}`}>
        <span className="chan-name">{displayName}</span>
        {channel == null ? (
          <span className="chan-tag chan-tag--placeholder">…</span>
        ) : channel.tag == null ? (
          <span className="chan-tag chan-tag--unset">Канал ещё не настроен</span>
        ) : (
          <span className="chan-tag">{channel.tag}</span>
        )}
        {channel?.updatedAt && <span className="chan-meta">обновлён {formatDateTime(channel.updatedAt, { day: "2-digit", month: "2-digit" })}</span>}
        {task && task.state === "running" && (
          <span className="chan-task">
            <IconSync size={14} className="spin" />
            {task.phase || "Подготовка…"}
          </span>
        )}
        {task && task.state === "error" && (
          <span className="chan-task chan-task--error">
            <IconAlert size={14} />
            {task.error ?? "Ошибка перестановки latest"}
          </span>
        )}
      </div>
    );
  }

  function renderCiLeg(platform: string, state: string) {
    const label = platform === "windows" ? "Win" : platform === "linux" ? "Linux" : "macOS";
    const cls =
      state === "success"
        ? "ci-leg ci-leg--ok"
        : state === "running"
          ? "ci-leg ci-leg--run"
          : state === "failure" || state === "cancelled"
            ? "ci-leg ci-leg--fail"
            : "ci-leg ci-leg--wait";
    return (
      <span key={platform} className={cls}>
        {state === "success" && <IconCheck size={12} />}
        {state === "running" && <IconSync size={12} className="spin" />}
        {(state === "failure" || state === "cancelled") && <IconAlert size={12} />}
        {label}
      </span>
    );
  }

  function renderBuildRun(run: BuildRun) {
    const badge =
      run.state === "failure" || run.state === "cancelled" ? (
        <Badge variant="destructive">
          <IconAlert size={12} /> упала
        </Badge>
      ) : run.state === "running" ? (
        <Badge variant="secondary">
          <IconSync size={12} className="spin" /> собирается
        </Badge>
      ) : (
        <Badge variant="outline">в очереди</Badge>
      );
    const started = run.startedAt ? formatDateTime(run.startedAt, { day: "2-digit", month: "2-digit" }) : null;
    return (
      <div key={run.runId} className={`ci-row${run.state === "failure" || run.state === "cancelled" ? " ci-row--fail" : ""}`}>
        <strong className="ci-tag">{run.tag}</strong>
        {badge}
        {run.legs.length > 0 && <span className="ci-legs">{run.legs.map((leg) => renderCiLeg(leg.platform, leg.state))}</span>}
        <a className="ci-link" href={`https://github.com/Zeragorn-ru/stardust/actions/runs/${run.runId}`} target="_blank" rel="noopener noreferrer">
          прогон №{run.runId}
        </a>
        {started && <span className="ci-elapsed">{started}</span>}
      </div>
    );
  }

  function renderLatestPill(release: LauncherRelease, kind: "beta" | "stable") {
    const channel = kind === "beta" ? betaChannel : stableChannel;
    const isCurrent = channel?.tag === release.tag;
    // Stable-пилюля у pre-release заблокирована: сначала перевод в стабильный.
    const locked = kind === "stable" && release.prerelease;
    const busy = channelBusy && !isCurrent;
    const cls =
      "latest-btn" +
      (isCurrent ? " is-current" : "") +
      (busy || locked ? " is-locked" : "");
    const title = locked
      ? "Сначала переведите релиз в стабильный"
      : isCurrent
        ? `Канал launcher-${kind} раздаёт этот релиз`
        : `Направить канал launcher-${kind} на ${release.tag}`;
    return (
      <button
        key={kind}
        type="button"
        className={cls}
        data-channel={kind}
        aria-pressed={isCurrent}
        disabled={isCurrent || locked || busy}
        title={title}
        onClick={() => {
          if (!isCurrent && !locked && !busy) {
            void retargetChannel(kind, release.tag, channel?.tag ?? null);
          }
        }}
      >
        {kind}
        {isCurrent && <IconCheck size={12} />}
        {busy && <IconSync size={12} className="spin" />}
      </button>
    );
  }

  return (
    <div className="view seasons-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Мониторинг</span>
          <h1>Сезоны</h1>
          <p className="muted">Архив статистики игроков по сезонам и выкат релизов лаунчера в стабильный канал.</p>
        </div>
      </header>

      {/* ── Раздел 1: Сезоны ── */}
      <section className="panel panel-flat" aria-labelledby="seasons-section-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Статистика игроков</span>
            <h2 id="seasons-section-title">Сезоны</h2>
          </div>
          <Button
            variant="secondary"
            disabled={seasonsLoading}
            onClick={() => {
              void loadSeasons();
            }}
          >
            <IconSync size={14} className={seasonsLoading ? "spin" : ""} />
            {seasonsLoading ? "Обновление…" : "Обновить"}
          </Button>
        </div>

        {archiveStatus && (
          <div className={`panel sync-progress sync-progress--${archiveStatus.state === "success" ? "success" : archiveStatus.state === "error" ? "error" : "running"}`}>
            <div className="sync-progress__head">
              <strong>
                {archiveStatus.state === "running"
                  ? `Архивация${archiveStatus.seasonName ? ` «${archiveStatus.seasonName}»` : ""}`
                  : archiveStatus.state === "success"
                    ? "Сезон заархивирован"
                    : "Ошибка архивации"}
              </strong>
            </div>
            <div className="sync-progress__meta">
              <span>{archiveStatus.phase || "Подготовка…"}</span>
            </div>
            {archiveStatus.error && <div className="q-err">{archiveStatus.error}</div>}
          </div>
        )}

        {seasonsError ? (
          <div className="external-mod-empty">
            <strong>{seasonsError}</strong>
            <Button variant="secondary" onClick={() => void loadSeasons()}>Повторить</Button>
          </div>
        ) : seasonsLoading ? (
          <p className="muted">
            <span className="spinner" /> Загрузка…
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Сезон</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Начало</TableHead>
                <TableHead>Окончание</TableHead>
                <TableHead>Игроков</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeSeason && (
                <TableRow key={activeSeason.id}>
                  <TableCell>
                    <div className="cell-main">
                      <strong>{activeSeason.name}</strong>
                    </div>
                  </TableCell>
                  <TableCell data-label="Статус">
                    <Badge variant="success">активный</Badge>
                  </TableCell>
                  <TableCell data-label="Начало">
                    <span className="muted">{formatDateTime(activeSeason.startedAt ?? "")}</span>
                  </TableCell>
                  <TableCell data-label="Окончание">
                    <span className="muted">—</span>
                  </TableCell>
                  <TableCell data-label="Игроков">
                    <span className="muted">—</span>
                  </TableCell>
                  <TableCell data-label="Действие">
                    <Button
                      variant="destructive"
                      disabled={archiving}
                      onClick={() => void archiveActiveSeason()}
                    >
                      {archiving ? "Архивация…" : "Завершить сезон и заархивировать статистику"}
                    </Button>
                  </TableCell>
                </TableRow>
              )}
              {archivedSeasons.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="cell-main">
                      <strong>{s.name}</strong>
                    </div>
                  </TableCell>
                  <TableCell data-label="Статус">
                    <Badge variant="outline">в архиве</Badge>
                  </TableCell>
                  <TableCell data-label="Начало">
                    <span className="muted">{formatDateTime(s.startedAt ?? "")}</span>
                  </TableCell>
                  <TableCell data-label="Окончание">
                    <span className="muted">{formatDateTime(s.endedAt ?? "")}</span>
                  </TableCell>
                  <TableCell data-label="Игроков">
                    <span className="muted">{s.accountsCount ?? "—"}</span>
                  </TableCell>
                  <TableCell data-label="Действие"></TableCell>
                </TableRow>
              ))}
              {!activeSeason && archivedSeasons.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <p className="muted" style={{ margin: 0 }}>Сезонов пока нет — они появятся после первого запуска сервера.</p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        <p className="muted seasons-hint">
          При завершении сезона статистика всех игроков (время в игре, смерти, блоки, дистанция)
          сохраняется в архив и сбрасывается в ноль. Действие необратимо.
        </p>
      </section>

      {/* ── Раздел 2: Релизы лаунчера (пульт каналов) ── */}
      <section className="panel panel-flat" aria-labelledby="releases-section-title">
        <div className="section-head">
          <div>
            <h2 id="releases-section-title">Релизы лаунчера</h2>
          </div>
          <Button
            variant="secondary"
            disabled={releasesLoading}
            onClick={() => {
              void loadAllReleases();
            }}
          >
            <IconSync size={14} className={releasesLoading ? "spin" : ""} />
            {releasesLoading ? "Обновление…" : "Обновить"}
          </Button>
        </div>

        {githubTokenMissing && (
          <p className="rel-token-warn">
            <IconAlert size={14} />
            GitHub-токен не настроен: задайте его в разделе «Настройки», чтобы управлять
            каналами и сборками без лимитов GitHub API.
          </p>
        )}

        {/* Каналы апдейтера: что раздаётся прямо сейчас. Без токена показываем
            только полосу выше — error-блок продублировал бы её текст. */}
        {githubTokenMissing ? null : channelsError ? (
          <div className="external-mod-empty">
            <strong>{channelsError}</strong>
            <Button variant="secondary" onClick={() => void loadChannels()}>Повторить</Button>
          </div>
        ) : (
          <div className="chan-board">
            {renderChannelTile(betaChannel, "beta")}
            {renderChannelTile(stableChannel, "stable")}
          </div>
        )}

        {/* Сборка CI: прогоны в работе и упавшие. */}
        <div className="rel-zone-head">
          <span>Сборка CI</span>
          <span className="rel-zone-count">{pendingRuns.length > 0 ? pluralRuns(pendingRuns.length) : ""}</span>
          <a className="ci-actions-link" href="https://github.com/Zeragorn-ru/stardust/actions/workflows/launcher-release.yml" target="_blank" rel="noopener noreferrer">
            Actions
          </a>
        </div>
        {buildRunsError ? (
          <div className="rel-empty rel-empty--error">
            <strong>Статус CI недоступен</strong>
            <Button variant="secondary" onClick={() => void loadBuildRuns()}>Повторить</Button>
          </div>
        ) : pendingRuns.length === 0 ? (
          <p className="rel-empty">Сейчас ничего не собирается</p>
        ) : (
          pendingRuns.map(renderBuildRun)
        )}

        {/* Релизы: вышедшие теги с переводом в стабильный и пилюлями каналов. */}
        <div className="rel-zone-head">
          <span>Релизы</span>
          <span className="rel-zone-count">{releases.length > 0 ? pluralVersions(releases.length) : ""}</span>
        </div>

        {promoteStatus && (
          <div className={`panel sync-progress sync-progress--${promoteStatus.state === "success" ? "success" : promoteStatus.state === "error" ? "error" : "running"}`}>
            <div className="sync-progress__head">
              <strong>
                {promoteStatus.state === "running"
                  ? `Перевод ${promoteStatus.tag ?? ""} в стабильный`
                  : promoteStatus.state === "success"
                    ? "Релиз переведён в стабильный"
                    : "Ошибка перевода"}
              </strong>
            </div>
            <div className="sync-progress__meta">
              <span>{promoteStatus.phase || "Подготовка…"}</span>
            </div>
            {promoteStatus.error && <div className="q-err">{promoteStatus.error}</div>}
          </div>
        )}

        {releasesError ? (
          <div className="external-mod-empty">
            <strong>{releasesError}</strong>
            <Button variant="secondary" onClick={() => void loadReleases()}>Повторить</Button>
          </div>
        ) : releasesLoading ? (
          <p className="muted">
            <span className="spinner" /> Загрузка…
          </p>
        ) : releases.length === 0 ? (
          <p className="rel-empty">Релизов пока нет — первый тег vX.Y.Z опубликует pre-release автоматически</p>
        ) : (
          <div className="rel-list">
            {releases.map((r) => (
              <div key={r.tag} className={`rel-row${freshTag === r.tag ? " rel-row--fresh" : ""}`}>
                <div className="rel-main">
                  <strong className="rel-tag">{r.tag}</strong>
                  {r.prerelease ? <Badge variant="secondary">pre-release</Badge> : <Badge variant="success">стабильный</Badge>}
                </div>
                <span className="rel-date">{formatDateTime(r.publishedAt ?? "", { day: "2-digit", month: "2-digit" })}</span>
                <div className="rel-actions">
                  {r.prerelease && (
                    <Button
                      disabled={channelBusy}
                      onClick={() => void promoteRelease(r.tag)}
                    >
                      {promotingTag === r.tag ? "Переводим…" : "В стабильный релиз"}
                    </Button>
                  )}
                  {renderLatestPill(r, "beta")}
                  {renderLatestPill(r, "stable")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
