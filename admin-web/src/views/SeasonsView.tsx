// Экран «Сезоны»: завершение текущего сезона — снимок статистики всех игроков
// в архив сезона + сброс счётчиков к нулю для нового сезона.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { SeasonArchiveStatus, Season } from "../types";
import { formatDateTime } from "../format";
import { useConfirm, useToast } from "../ui/feedback";
import { IconSync } from "../ui/icons";
import { McText } from "../ui/McText";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/shadcn";

const POLL_INTERVAL_MS = 2000;
const POLL_ERROR_LIMIT = 5;

export function SeasonsView() {
  const toast = useToast();
  const confirm = useConfirm();

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(true);
  const [seasonsError, setSeasonsError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<SeasonArchiveStatus | null>(null);
  const archivePollRef = useRef<number | null>(null);
  const archivePollErrors = useRef(0);

  // ── Опрос архивации ──
  function stopArchivePoll() {
    if (archivePollRef.current != null) {
      window.clearInterval(archivePollRef.current);
      archivePollRef.current = null;
    }
  }

  useEffect(() => () => stopArchivePoll(), []);

  function startArchivePoll() {
    stopArchivePoll();
    archivePollErrors.current = 0;
    archivePollRef.current = window.setInterval(async () => {
      try {
        const s = await api.getSeasonArchiveStatus();
        archivePollErrors.current = 0;
        setArchiveStatus(s);
        if (s.state === "success" || s.state === "error" || s.state === "idle") {
          stopArchivePoll();
          setArchiving(false);
          if (s.state === "success") {
            toast.success(`Сезон «${s.seasonName ?? ""}» заархивирован. Счётчики игроков сброшены.`);
            void loadSeasons();
          } else if (s.state === "idle") {
            toast.error("Статус архивации потерян (сервер перезапущен?) — проверьте результат вручную");
          } else {
            toast.error(`Ошибка архивации: ${s.error ?? "неизвестная ошибка"}`);
          }
        }
      } catch {
        archivePollErrors.current += 1;
        if (archivePollErrors.current >= POLL_ERROR_LIMIT) {
          stopArchivePoll();
          setArchiving(false);
          toast.error("Не удалось получить статус архивации");
        }
      }
    }, POLL_INTERVAL_MS);
  }

  const loadSeasons = useCallback(async () => {
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

  useEffect(() => {
    void loadSeasons();
  }, [loadSeasons]);

  // Подхватываем идущую фоновую задачу при перезагрузке страницы.
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
      } catch { /* не критично */ }
    }
    void adoptRunning();
    return () => { cancelled = true; };
  }, []);

  async function archiveActiveSeason() {
    const ok = await confirm({
      title: "Завершить сезон и заархивировать статистику?",
      body: "Статистика ВСЕХ игроков (время в игре, смерти, добытые блоки, дистанция) будет сфотографирована в архив сезона и сброшена в ноль для следующего сезона. При следующем тике синхронизации SFTP живые счётчики пересчитаются от сохранённого baseline, а не от нуля.",
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

  const activeSeason = seasons.find((s) => s.status === "active") ?? null;
  const archivedSeasons = seasons.filter((s) => s.status === "archived");

  return (
    <div className="view seasons-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Игроки</span>
          <h1>Сезоны</h1>
          <p className="muted">Архив статистики игроков по сезонам и завершение текущего сезона.</p>
        </div>
      </header>

      <section className="panel panel-flat" aria-labelledby="seasons-section-title">
        <div className="section-head">
          <div>
            <span className="eyebrow">Статистика игроков</span>
            <h2 id="seasons-section-title">Сезоны</h2>
          </div>
          <Button
            variant="secondary"
            disabled={seasonsLoading}
            onClick={() => void loadSeasons()}
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
          <p className="muted"><span className="spinner" /> Загрузка…</p>
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
                      <strong><McText text={activeSeason.name} /></strong>
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
                      <strong><McText text={s.name} /></strong>
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
          При завершении сезона статистика всех игроков сохраняется в архив и
          сбрасывается в ноль. Действие необратимо.
        </p>
      </section>
    </div>
  );
}
