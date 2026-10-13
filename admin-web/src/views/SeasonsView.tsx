// Экран «Сезоны»: два раздела. Первый — сезоны с архивацией статистики
// (снимок счётчиков всех игроков в сезонные таблицы + сброс к нулю),
// второй — релизы лаунчера с переводом pre-release в стабильный канал.
// Обе операции — фоновые задачи на сервере: подтверждение -> POST ->
// опрос статуса с живой фазой (как деплой мода в BuildDetail).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { LauncherRelease, PromoteStatus, Season, SeasonArchiveStatus, Settings } from "../types";
import { formatDateTime } from "../format";
import { useConfirm, useToast } from "../ui/feedback";
import { IconSync } from "../ui/icons";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/shadcn";

// Интервал и лимит ошибок опроса — как у деплоя мода (BuildDetail).
const POLL_INTERVAL_MS = 2000;
const POLL_ERROR_LIMIT = 5;

export function SeasonsView({ mobile = false }: { mobile?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(true);
  const [seasonsError, setSeasonsError] = useState<string | null>(null);

  const [releases, setReleases] = useState<LauncherRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(true);
  const [releasesError, setReleasesError] = useState<string | null>(null);

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

  useEffect(() => {
    return () => {
      stopArchivePoll();
      stopPromotePoll();
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

  const loadReleases = useCallback(async () => {
    setReleasesLoading(true);
    try {
      setReleases(await api.getReleases());
      setReleasesError(null);
    } catch (err) {
      setReleasesError(err instanceof ApiError ? err.message : "Не удалось загрузить релизы");
    } finally {
      setReleasesLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch {
      // Подсказка про токен не критична — молча пропускаем.
    }
  }, []);

  useEffect(() => {
    void loadSeasons();
    void loadReleases();
    void loadSettings();
  }, [loadSeasons, loadReleases, loadSettings]);

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
        if (s.state === "success" || s.state === "error") {
          stopArchivePoll();
          setArchiving(false);
          if (s.state === "success") {
            toast.success(`Сезон «${s.seasonName ?? ""}» заархивирован. Счётчики игроков сброшены.`);
            await loadSeasons();
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
        if (s.state === "success" || s.state === "error") {
          stopPromotePoll();
          setPromotingTag(null);
          if (s.state === "success") {
            toast.success(`Релиз ${s.tag ?? ""} переведён в стабильный канал`);
            await loadReleases();
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

  const activeSeason = seasons.find((s) => s.status === "active") ?? null;
  const archivedSeasons = seasons.filter((s) => s.status === "archived");
  const githubTokenMissing = settings != null && !settings.githubTokenSet;

  return (
    <div className={`view seasons-view${mobile ? " seasons-view--mobile" : ""}`}>
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

      {/* ── Раздел 2: Релизы лаунчера ── */}
      <section className="panel panel-flat" aria-labelledby="releases-section-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Канал launcher-stable</span>
            <h2 id="releases-section-title">Релизы лаунчера</h2>
          </div>
          <Button
            variant="secondary"
            disabled={releasesLoading}
            onClick={() => {
              void loadReleases();
            }}
          >
            <IconSync size={14} className={releasesLoading ? "spin" : ""} />
            {releasesLoading ? "Обновление…" : "Обновить"}
          </Button>
        </div>

        {githubTokenMissing && (
          <p className="muted seasons-hint">
            GitHub-токен не настроен: задайте его в разделе «Настройки», чтобы переводить релизы
            в стабильный канал без лимитов GitHub API.
          </p>
        )}

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
          <p className="muted">Релизов лаунчера пока нет.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Тег</TableHead>
                <TableHead>Название</TableHead>
                <TableHead>Опубликован</TableHead>
                <TableHead>Канал</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.map((r) => (
                <TableRow key={r.tag}>
                  <TableCell>
                    <div className="cell-main">
                      <strong>{r.tag}</strong>
                    </div>
                  </TableCell>
                  <TableCell data-label="Название">
                    <span className="muted">{r.name ?? "—"}</span>
                  </TableCell>
                  <TableCell data-label="Опубликован">
                    <span className="muted">{formatDateTime(r.publishedAt ?? "")}</span>
                  </TableCell>
                  <TableCell data-label="Канал">
                    {r.prerelease ? <Badge variant="secondary">pre-release</Badge> : <Badge variant="success">стабильный</Badge>}
                  </TableCell>
                  <TableCell data-label="Действие">
                    {r.prerelease ? (
                      <Button
                        disabled={promotingTag != null}
                        onClick={() => void promoteRelease(r.tag)}
                      >
                        {promotingTag === r.tag ? "Перевод…" : "В стабильный релиз"}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="muted seasons-hint">
          Все новые версии лаунчера выходят как pre-release. Перевод в стабильный делает релиз
          полноценным и обновляет latest.json канала launcher-stable — обновление получат все
          клиенты стабильной версии.
        </p>
      </section>
    </div>
  );
}
