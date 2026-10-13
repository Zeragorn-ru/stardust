// Экран «Новости» (план 3.6).
//
// Список — индекс раздела: карточки через общий NewsAdminList. На десктопе
// редактор живёт в маршрутах /news/new и /news/:id (BuildsPage-паттерн),
// с широким лейаутом, живым Markdown-превью и dirty-guard на навигацию;
// на мобильном редактор остаётся модалкой, но full-screen с превью.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { NewsPost } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { useDialogFocus } from "../ui/useDialogFocus";
import { useDirtyGuard } from "../ui/useDirtyGuard";
import { useRouteDirtyGuard } from "../ui/useRouteGuard";
import { EmptyPanel, ErrorPanel, LoadPanel } from "../ui/EmptyState";
import { NewsAdminList } from "../ui/NewsAdminList";
import { Markdown } from "../ui/Markdown";
import { IconArrowLeft } from "../ui/icons";

export function NewsView({ mobile = false }: { mobile?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NewsPost | "new" | null>(null);
  const navigate = useNavigate();
  // На десктопе редактором управляет маршрут; на мобильном — модалка.
  const routeEditor = !mobile;
  const params = useParams<{ id?: string }>();

  // Чего требует маршрут: "new" | число | null (индекс). Пока список грузится,
  // числовой id показываем как загрузку, а не как «не найдено».
  const routeTarget: "new" | number | null = routeEditor
    ? params.id === "new"
      ? "new"
      : params.id && /^\d+$/.test(params.id)
        ? Number(params.id)
        : null
    : null;
  // "pending" — id валиден, но список ещё не загрузился (не знаем, есть ли пост).
  const routePost: NewsPost | "pending" | null =
    routeTarget === null || routeTarget === "new"
      ? null
      : posts.find((p) => p.id === routeTarget) ?? (loading ? "pending" : null);

  const load = useCallback(async () => {
    try {
      setPosts(await api.listNews());
      setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Не удалось загрузить новости");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function remove(post: NewsPost) {
    if (!await confirm({
      title: `Удалить «${post.title}»?`,
      body: "Новость исчезнет из лаунчера.",
      confirmText: "Удалить",
      danger: true,
    })) return;

    try {
      await api.deleteNews(post.id);
      toast.success("Новость удалена");
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Ошибка удаления");
    }
  }

  function openEditor(target: NewsPost | "new") {
    if (routeEditor) {
      navigate(target === "new" ? "/news/new" : `/news/${target.id}`);
    } else {
      setEditing(target);
    }
  }

  function exitEditor() {
    if (routeEditor) navigate("/news");
    else setEditing(null);
  }

  // Маршрут-редактор занимает экран целиком (как BuildDetail в BuildsPage):
  // индексный список на подмаршруте не рендерится.
  if (routeEditor && routeTarget !== null) {
    return (
      <div className="view news-view">
        {routeTarget === "new" && <NewsEditor mode="route" onExit={exitEditor} />}
        {routePost instanceof Object && (
          <NewsEditor initial={routePost} mode="route" onExit={exitEditor} />
        )}
        {routePost === "pending" && <LoadPanel aria-label="Загрузка новости" />}
        {routePost === null && routeTarget !== "new" && (
          <EmptyPanel
            title="Новость не найдена"
            action={
              <button className="secondary" type="button" onClick={() => navigate("/news")}>
                К списку новостей
              </button>
            }
          >
            Возможно, она была удалена.
          </EmptyPanel>
        )}
      </div>
    );
  }

  return (
    <div className={`view news-view${mobile ? " news-view--mobile" : ""}`}>
      <header className="view-head page-head news-view__head">
        <div>
          <span className="eyebrow">Лента лаунчера</span>
          <h1>Новости</h1>
          <p className="muted">Объявления для игроков в лаунчере.</p>
        </div>
        <button className="primary news-view__create" type="button" onClick={() => openEditor("new")}>
          Создать новость
        </button>
      </header>

      {!mobile && (
        <p className="muted news-view__hint">
          Markdown: заголовки, списки, <code>**жирный**</code>, <code>*курсив*</code>, <code>`код`</code> и HTTPS-ссылки.
        </p>
      )}

      {loading ? (
        <LoadPanel aria-label="Загрузка новостей" />
      ) : error && posts.length === 0 ? (
        <ErrorPanel title="Не удалось загрузить новости" onRetry={() => void load()}>
          {error}. Проверьте соединение с сервером и попробуйте снова.
        </ErrorPanel>
      ) : posts.length === 0 ? (
        <EmptyPanel
          title="Пока нет публикаций"
          action={
            <button className="secondary" type="button" onClick={() => openEditor("new")}>
              Создать первую новость
            </button>
          }
        >
          Создайте первое объявление. Оно появится в ленте лаунчера.
        </EmptyPanel>
      ) : (
        <NewsAdminList
          cards={posts.map((post) => ({
            id: post.id,
            title: post.title,
            excerpt: post.markdown,
            updatedAt: post.updatedAt,
            meta: [
              post.pinned ? <span key="pinned" className="news-admin-card__pinned">Закреплено</span> : null,
              <span key="author">{post.authorName}</span>,
            ].filter(Boolean),
            onOpen: () => openEditor(post),
          }))}
          onRemove={(id) => void remove(posts.find((p) => p.id === id)!)}
        />
      )}

      {/* Мобильный: full-screen модалка с превью. */}
      {mobile && editing && (
        <NewsEditor
          initial={editing === "new" ? undefined : editing}
          mode="modal"
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function NewsEditor({ initial, mode, onClose, onSaved, onExit }: {
  initial?: NewsPost;
  /** "route" — десктопный страничный редактор, "modal" — мобильная модалка. */
  mode: "route" | "modal";
  /** modal: закрытие (с dirty-guard) и колбэк после сохранения. */
  onClose?: () => void;
  onSaved?: () => Promise<void>;
  /** route: куда вернуться после сохранения/выхода. */
  onExit?: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [markdown, setMarkdown] = useState(initial?.markdown ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);

  // Dirty-guard: до 12 000 символов текста не должны исчезнуть от случайного
  // Escape, клика по подложке или ухода по сайдбару (план 3.6/4.4).
  const dirty =
    title !== (initial?.title ?? "") ||
    markdown !== (initial?.markdown ?? "") ||
    pinned !== (initial?.pinned ?? false);

  // Оба guard-хука вызываются безусловно (правила хуков). В modal-режиме
  // (мобильный шелл без роутера) маршрутный guard отключён через enabled.
  const routeGuard = useRouteDirtyGuard({
    enabled: mode === "route",
    isDirty: dirty,
    isBusy: busy,
    body: "Черновик новости (до 12 000 символов) будет потерян.",
  });
  void routeGuard;

  const tryClose = useDirtyGuard({
    isDirty: dirty,
    isBusy: busy,
    onClose: () => (mode === "modal" ? onClose?.() : onExit?.()),
    body: "Черновик новости (до 12 000 символов) будет потерян.",
  });
  useDialogFocus(dialogRef, () => void tryClose());

  // Ctrl/Cmd+S сохраняет, не закрывая редактор (план 3.6).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!busy) dialogRef.current?.requestSubmit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (initial) {
        await api.updateNews(initial.id, { title, markdown, pinned });
      } else {
        await api.createNews({ title, markdown, pinned });
      }
      toast.success(initial ? "Новость обновлена" : "Новость опубликована");
      if (mode === "modal") await onSaved?.();
      else onExit!();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Ошибка сохранения");
    } finally {
      setBusy(false);
    }
  }

  // Роут-режим: широкая страница с живым превью справа.
  if (mode === "route") {
    return (
      <section className="route-editor">
        <header className="route-editor__head">
          <button
            type="button"
            className="secondary route-editor__back"
            onClick={() => void tryClose()}
            disabled={busy}
          >
            <IconArrowLeft size={15} /> К списку
          </button>
          <h2>{initial ? "Редактировать новость" : "Новая новость"}</h2>
          <span className="muted route-editor__hint">Ctrl/Cmd+S — сохранить</span>
        </header>
        <form ref={dialogRef} className="route-editor__form" id="news-route-form" onSubmit={submit}>
          <div className="route-editor__fields">
            <div className="field">
              <label htmlFor="news-title">Заголовок <span>{title.length}/120</span></label>
              <input id="news-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} autoFocus required />
            </div>
            <div className="field route-editor__body-field">
              <label htmlFor="news-body">Текст <span>{markdown.length}/12000</span></label>
              <textarea id="news-body" value={markdown} maxLength={12000} rows={20} onChange={(event) => setMarkdown(event.target.value)} required />
              <small className="muted">Поддерживается Markdown: заголовки, списки, жирный текст, курсив и HTTPS-ссылки.</small>
            </div>
            <label className="news-editor__pin">
              <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
              <span><strong>Закрепить новость</strong><small>Она будет показана на главном экране лаунчера.</small></span>
            </label>
            <div className="route-editor__actions">
              <button type="button" className="secondary" onClick={() => void tryClose()} disabled={busy}>Отмена</button>
              <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : initial ? "Сохранить" : "Опубликовать"}</button>
            </div>
          </div>
          <aside className="route-editor__preview">
            <div className="route-editor__preview-head">
              <strong>Предпросмотр</strong>
              <span className="muted">{title || "Без заголовка"}</span>
            </div>
            <Markdown text={markdown} />
          </aside>
        </form>
      </section>
    );
  }

  // Мобильный: full-screen модалка с тумблером превью.
  return (
    <div className="modal-backdrop news-editor-backdrop news-editor-backdrop--mobile" onClick={() => void tryClose()}>
       <form ref={dialogRef} className="modal news-editor" role="dialog" aria-modal="true" aria-labelledby="news-editor-title" tabIndex={-1} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <header className="news-editor__head">
          <div>
            <span className="eyebrow">Лента лаунчера</span>
           <h3 id="news-editor-title">{initial ? "Редактировать новость" : "Новая новость"}</h3>
          </div>
          <button className="news-editor__close" type="button" aria-label="Закрыть" onClick={() => void tryClose()}>Закрыть</button>
        </header>
        <div className="field">
          <label htmlFor="news-title">Заголовок <span>{title.length}/120</span></label>
          <input id="news-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} autoFocus required />
        </div>
        <div className="field news-editor__body-field">
          <label htmlFor="news-body">Текст <span>{markdown.length}/12000</span></label>
          <textarea id="news-body" value={markdown} maxLength={12000} rows={14} onChange={(event) => setMarkdown(event.target.value)} required />
          <div className="news-editor__preview-toggle">
            <button type="button" className="secondary" aria-pressed={showPreview} onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? "Редактировать текст" : "Предпросмотр"}
            </button>
          </div>
          {showPreview && (
            <div className="news-editor__mobile-preview">
              <Markdown text={markdown} />
            </div>
          )}
          <small className="muted">Поддерживается Markdown: заголовки, списки, жирный текст, курсив и HTTPS-ссылки.</small>
        </div>
        <label className="news-editor__pin">
          <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
          <span><strong>Закрепить новость</strong><small>Она будет показана на главном экране лаунчера.</small></span>
        </label>
        <div className="modal-actions news-editor__actions">
          <button type="button" className="secondary" onClick={() => void tryClose()} disabled={busy}>Отмена</button>
          <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : initial ? "Сохранить" : "Опубликовать"}</button>
        </div>
      </form>
    </div>
  );
}
