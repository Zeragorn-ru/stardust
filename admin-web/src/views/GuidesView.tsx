// Экран «Гайды» (план 3.6).
//
// Список — индекс раздела через общий NewsAdminList (мобильные стили
// новостей применяются автоматически). На десктопе редактор — маршруты
// /guides/new и /guides/:id с живым Markdown-превью и dirty-guard
// на навигацию; на мобильном — full-screen модалка с превью.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Guide } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { useDialogFocus } from "../ui/useDialogFocus";
import { useDirtyGuard } from "../ui/useDirtyGuard";
import { useRouteDirtyGuard } from "../ui/useRouteGuard";
import { EmptyPanel, ErrorPanel, LoadPanel } from "../ui/EmptyState";
import { NewsAdminList } from "../ui/NewsAdminList";
import { Markdown } from "../ui/Markdown";
import { IconArrowLeft } from "../ui/icons";

const emptyGuide = { slug: "", title: "", excerpt: "", category: "Общее", markdown: "", published: false };
type GuideInput = Omit<Guide, "id" | "authorName" | "createdAt" | "updatedAt">;

export function GuidesView({ mobile = false }: { mobile?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Guide | "new" | null>(null);
  const navigate = useNavigate();
  // На десктопе редактором управляет маршрут; на мобильном — модалка.
  const routeEditor = !mobile;
  const params = useParams<{ id?: string }>();

  const routeTarget: "new" | number | null = routeEditor
    ? params.id === "new"
      ? "new"
      : params.id && /^\d+$/.test(params.id)
        ? Number(params.id)
        : null
    : null;
  const routeGuide: Guide | "pending" | null =
    routeTarget === null || routeTarget === "new"
      ? null
      : guides.find((g) => g.id === routeTarget) ?? (loading ? "pending" : null);

  const load = useCallback(async () => {
    try {
      setGuides(await api.listGuides());
      setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Не удалось загрузить гайды");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function remove(guide: Guide) {
    if (!await confirm({ title: `Удалить «${guide.title}»?`, body: "Гайд исчезнет с публичного сайта.", confirmText: "Удалить", danger: true })) return;
    try { await api.deleteGuide(guide.id); toast.success("Гайд удалён"); await load(); }
    catch (error) { toast.error(error instanceof ApiError ? error.message : "Ошибка удаления"); }
  }

  function openEditor(target: Guide | "new") {
    if (routeEditor) {
      navigate(target === "new" ? "/guides/new" : `/guides/${target.id}`);
    } else {
      setEditing(target);
    }
  }

  function exitEditor() {
    if (routeEditor) navigate("/guides");
    else setEditing(null);
  }

  // Маршрут-редактор занимает экран целиком (как BuildDetail в BuildsPage):
  // индексный список на подмаршруте не рендерится.
  if (routeEditor && routeTarget !== null) {
    return <div className="view guides-view">
      {routeTarget === "new" && <GuideEditor mode="route" onExit={exitEditor} />}
      {routeGuide instanceof Object && <GuideEditor initial={routeGuide} mode="route" onExit={exitEditor} />}
      {routeGuide === "pending" && <LoadPanel aria-label="Загрузка гайда" />}
      {routeGuide === null && routeTarget !== "new" && (
        <EmptyPanel
          title="Гайд не найден"
          action={
            <button className="secondary" type="button" onClick={() => navigate("/guides")}>К списку гайдов</button>
          }
        >
          Возможно, он был удалён.
        </EmptyPanel>
      )}
    </div>;
  }

  // Мобильные стили — переиспользование классов новостей (news-view__head /
  // news-view__create): список уже идёт через общий NewsAdminList, а те же
  // классы на шапке дают гайдам sticky-голову и 44px-кнопку без новых правил.
  return <div className={`view guides-view${mobile ? " news-view--mobile" : ""}`}>
    <header className="view-head page-head news-view__head">
      <div><span className="eyebrow">База знаний</span><h1>Гайды</h1><p className="muted">Инструкции для игроков, которые появляются на сайте после публикации.</p></div>
      <button className="primary news-view__create" type="button" onClick={() => openEditor("new")}>Создать гайд</button>
    </header>
    {!mobile && <p className="muted">Markdown: заголовки, списки, <code>**жирный**</code>, <code>*курсив*</code>, <code>`код`</code> и HTTPS-ссылки.</p>}

    {loading ? (
      <LoadPanel aria-label="Загрузка гайдов" />
    ) : error && guides.length === 0 ? (
      <ErrorPanel title="Не удалось загрузить гайды" onRetry={() => void load()}>
        {error}. Проверьте соединение с сервером и попробуйте снова.
      </ErrorPanel>
    ) : guides.length === 0 ? (
      <EmptyPanel
        title="Гайдов пока нет"
        action={
          <button className="secondary" type="button" onClick={() => openEditor("new")}>Создать первый гайд</button>
        }
      >
        Создайте первую инструкцию и опубликуйте её для игроков.
      </EmptyPanel>
    ) : (
      <NewsAdminList
        cards={guides.map((guide) => ({
          id: guide.id,
          title: guide.title,
          excerpt: guide.excerpt || guide.markdown,
          updatedAt: guide.updatedAt,
          footnote: `/guides/${guide.slug}`,
          meta: [
            <span key="status" className={guide.published ? "news-admin-card__pinned" : undefined}>
              {guide.published ? "Опубликован" : "Черновик"}
            </span>,
            <span key="category">{guide.category}</span>,
          ],
          onOpen: () => openEditor(guide),
        }))}
        onRemove={(id) => void remove(guides.find((g) => g.id === id)!)}
      />
    )}

    {/* Мобильный: full-screen модалка с превью. */}
    {mobile && editing && (
      <GuideEditor
        initial={editing === "new" ? undefined : editing}
        mode="modal"
        onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await load(); }}
      />
    )}
  </div>;
}

function GuideEditor({ initial, mode, onClose, onSaved, onExit }: {
  initial?: Guide;
  mode: "route" | "modal";
  onClose?: () => void;
  onSaved?: () => Promise<void>;
  onExit?: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<GuideInput>(initial ? { slug: initial.slug, title: initial.title, excerpt: initial.excerpt, category: initial.category, markdown: initial.markdown, published: initial.published } : emptyGuide);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);

  // Dirty-guard: до 40 000 символов текста не должны исчезнуть от случайного
  // Escape, клика по подложке или ухода по сайдбару (план 3.6/4.4).
  const dirty = initial
    ? form.slug !== initial.slug || form.title !== initial.title || form.excerpt !== initial.excerpt || form.category !== initial.category || form.markdown !== initial.markdown || form.published !== initial.published
    : Boolean(form.slug.trim() || form.title.trim() || form.excerpt.trim() || form.markdown.trim());

  // Оба guard-хука вызываются безусловно (правила хуков); в modal-режиме
  // (мобильный шелл без роутера) маршрутный guard отключён через enabled.
  const routeGuard = useRouteDirtyGuard({
    enabled: mode === "route",
    isDirty: dirty,
    isBusy: busy,
    body: "Черновик гайда (до 40 000 символов) будет потерян.",
  });
  void routeGuard;

  const tryClose = useDirtyGuard({
    isDirty: dirty,
    isBusy: busy,
    onClose: () => (mode === "modal" ? onClose?.() : onExit?.()),
    body: "Черновик гайда (до 40 000 символов) будет потерян.",
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

  function set<K extends keyof GuideInput>(key: K, value: GuideInput[K]) { setForm((current) => ({ ...current, [key]: value })); }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      if (initial) await api.updateGuide(initial.id, form);
      else await api.createGuide(form);
      toast.success(initial ? "Гайд обновлён" : "Гайд сохранён");
      if (mode === "modal") await onSaved?.();
      else onExit?.();
    }
    catch (error) { toast.error(error instanceof ApiError ? error.message : "Ошибка сохранения"); }
    finally { setBusy(false); }
  }

  // Роут-режим: широкая страница с живым превью справа.
  if (mode === "route") {
    return (
      <section className="route-editor">
        <header className="route-editor__head">
          <button type="button" className="secondary route-editor__back" onClick={() => void tryClose()} disabled={busy}>
            <IconArrowLeft size={15} /> К списку
          </button>
          <h2>{initial ? "Редактировать гайд" : "Новый гайд"}</h2>
          <span className="muted route-editor__hint">Ctrl/Cmd+S — сохранить</span>
        </header>
        <form ref={dialogRef} className="route-editor__form" onSubmit={submit}>
          <div className="route-editor__fields">
            <div className="field"><label htmlFor="guide-slug">Slug <span>{form.slug.length}/80</span></label><input id="guide-slug" value={form.slug} maxLength={80} placeholder="how-to-start" onChange={(event) => set("slug", event.target.value)} required /></div>
            <div className="field"><label htmlFor="guide-title">Заголовок <span>{form.title.length}/120</span></label><input id="guide-title" value={form.title} maxLength={120} onChange={(event) => set("title", event.target.value)} autoFocus required /></div>
            <div className="field"><label htmlFor="guide-category">Категория</label><input id="guide-category" value={form.category} maxLength={60} onChange={(event) => set("category", event.target.value)} /></div>
            <div className="field"><label htmlFor="guide-excerpt">Короткое описание <span>{form.excerpt.length}/240</span></label><textarea id="guide-excerpt" value={form.excerpt} maxLength={240} rows={3} onChange={(event) => set("excerpt", event.target.value)} /></div>
            <div className="field route-editor__body-field"><label htmlFor="guide-body">Текст <span>{form.markdown.length}/40000</span></label><textarea id="guide-body" value={form.markdown} maxLength={40000} rows={16} onChange={(event) => set("markdown", event.target.value)} required /><small className="muted">Markdown без HTML: заголовки, списки, ссылки, жирный и курсивный текст.</small></div>
            <label className="news-editor__pin"><input type="checkbox" checked={form.published} onChange={(event) => set("published", event.target.checked)} /><span><strong>Опубликовать на сайте</strong><small>Снимите галочку, чтобы сохранить черновик.</small></span></label>
            <div className="route-editor__actions">
              <button type="button" className="secondary" onClick={() => void tryClose()} disabled={busy}>Отмена</button>
              <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : initial ? "Сохранить" : "Создать гайд"}</button>
            </div>
          </div>
          <aside className="route-editor__preview">
            <div className="route-editor__preview-head">
              <strong>Предпросмотр</strong>
              <span className="muted">{form.title || "Без заголовка"}</span>
            </div>
            <Markdown text={form.markdown} />
          </aside>
        </form>
      </section>
    );
  }

  // Мобильный: full-screen модалка с тумблером превью.
  return <div className="modal-backdrop news-editor-backdrop news-editor-backdrop--mobile" onClick={() => void tryClose()}><form ref={dialogRef} className="modal news-editor" role="dialog" aria-modal="true" aria-labelledby="guide-editor-title" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
    <header className="news-editor__head"><div><span className="eyebrow">База знаний</span><h3 id="guide-editor-title">{initial ? "Редактировать гайд" : "Новый гайд"}</h3></div><button className="news-editor__close" type="button" onClick={() => void tryClose()}>Закрыть</button></header>
    <div className="field"><label htmlFor="guide-slug">Slug <span>{form.slug.length}/80</span></label><input id="guide-slug" value={form.slug} maxLength={80} placeholder="how-to-start" onChange={(event) => set("slug", event.target.value)} required /></div>
    <div className="field"><label htmlFor="guide-title">Заголовок <span>{form.title.length}/120</span></label><input id="guide-title" value={form.title} maxLength={120} onChange={(event) => set("title", event.target.value)} autoFocus required /></div>
    <div className="field"><label htmlFor="guide-category">Категория</label><input id="guide-category" value={form.category} maxLength={60} onChange={(event) => set("category", event.target.value)} /></div>
    <div className="field"><label htmlFor="guide-excerpt">Короткое описание <span>{form.excerpt.length}/240</span></label><textarea id="guide-excerpt" value={form.excerpt} maxLength={240} rows={3} onChange={(event) => set("excerpt", event.target.value)} /></div>
    <div className="field news-editor__body-field"><label htmlFor="guide-body">Текст <span>{form.markdown.length}/40000</span></label><textarea id="guide-body" value={form.markdown} maxLength={40000} rows={14} onChange={(event) => set("markdown", event.target.value)} required />
      <div className="news-editor__preview-toggle">
        <button type="button" className="secondary" aria-pressed={showPreview} onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? "Редактировать текст" : "Предпросмотр"}
        </button>
      </div>
      {showPreview && <div className="news-editor__mobile-preview"><Markdown text={form.markdown} /></div>}
      <small className="muted">Markdown без HTML: заголовки, списки, ссылки, жирный и курсивный текст.</small></div>
    <label className="news-editor__pin"><input type="checkbox" checked={form.published} onChange={(event) => set("published", event.target.checked)} /><span><strong>Опубликовать на сайте</strong><small>Снимите галочку, чтобы сохранить черновик.</small></span></label>
    <div className="modal-actions news-editor__actions"><button type="button" className="secondary" onClick={() => void tryClose()} disabled={busy}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохраняем…" : initial ? "Сохранить" : "Создать гайд"}</button></div>
  </form></div>;
}
