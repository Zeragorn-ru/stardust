import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import type { Guide } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { useDialogFocus } from "../ui/useDialogFocus";
import { formatDateTime } from "../format";

const emptyGuide = { slug: "", title: "", excerpt: "", category: "Общее", markdown: "", published: false };
type GuideInput = Omit<Guide, "id" | "authorName" | "createdAt" | "updatedAt">;

export function GuidesView({ mobile = false }: { mobile?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Guide | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setGuides(await api.listGuides());
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось загрузить гайды");
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  async function remove(guide: Guide) {
    if (!await confirm({ title: `Удалить «${guide.title}»?`, body: "Гайд исчезнет с публичного сайта.", confirmText: "Удалить", danger: true })) return;
    try { await api.deleteGuide(guide.id); toast.success("Гайд удалён"); await load(); }
    catch (error) { toast.error(error instanceof ApiError ? error.message : "Ошибка удаления"); }
  }

  return <div className={`view guides-view${mobile ? " guides-view--mobile" : ""}`}>
    <header className="view-head page-head">
      <div><span className="eyebrow">Public knowledge base</span><h1>Гайды</h1><p className="muted">Инструкции для игроков, которые появляются на сайте после публикации.</p></div>
      <button className="primary" type="button" onClick={() => setEditing("new")}>Создать гайд</button>
    </header>
    {!mobile && <p className="muted">Markdown: заголовки, списки, <code>**жирный**</code>, <code>*курсив*</code>, <code>`код`</code> и HTTPS-ссылки.</p>}
    {loading ? <p className="muted"><span className="spinner" /> Загрузка…</p> : guides.length === 0 ? <section className="panel panel-flat news-empty"><strong>Гайдов пока нет</strong><p className="muted">Создайте первую инструкцию и опубликуйте её для игроков.</p><button className="secondary" type="button" onClick={() => setEditing("new")}>Создать первый гайд</button></section> : <section className="news-admin-list">
      {guides.map((guide) => <article className="panel panel-flat news-admin-card" key={guide.id}>
        <div className="news-admin-card__body"><div className="news-admin-card__meta"><span className={guide.published ? "news-admin-card__pinned" : "muted"}>{guide.published ? "Опубликован" : "Черновик"}</span><span>{guide.category}</span><span>{formatDate(guide.updatedAt)}</span></div><h2>{guide.title}</h2><p className="muted news-admin-card__excerpt">{guide.excerpt || guide.markdown}</p><small className="muted">/guides/{guide.slug}</small></div>
        <div className="news-admin-card__actions"><button className="secondary" type="button" onClick={() => setEditing(guide)}>Изменить</button><button className="danger" type="button" onClick={() => void remove(guide)}>Удалить</button></div>
      </article>)}
    </section>}
    {editing && <GuideEditor initial={editing === "new" ? undefined : editing} mobile={mobile} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
  </div>;
}

function GuideEditor({ initial, mobile, onClose, onSaved }: { initial?: Guide; mobile: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState<GuideInput>(initial ? { slug: initial.slug, title: initial.title, excerpt: initial.excerpt, category: initial.category, markdown: initial.markdown, published: initial.published } : emptyGuide);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  useDialogFocus(dialogRef, onClose);
  function set<K extends keyof GuideInput>(key: K, value: GuideInput[K]) { setForm((current) => ({ ...current, [key]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { if (initial) await api.updateGuide(initial.id, form); else await api.createGuide(form); toast.success(initial ? "Гайд обновлён" : "Гайд сохранён"); await onSaved(); }
    catch (error) { toast.error(error instanceof ApiError ? error.message : "Ошибка сохранения"); }
    finally { setBusy(false); }
  }
  return <div className={`modal-backdrop news-editor-backdrop${mobile ? " news-editor-backdrop--mobile" : ""}`} onClick={onClose}><form ref={dialogRef} className="modal news-editor" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
    <header className="news-editor__head"><div><span className="eyebrow">Public knowledge base</span><h3>{initial ? "Редактировать гайд" : "Новый гайд"}</h3></div>{mobile && <button className="news-editor__close" type="button" onClick={onClose}>Закрыть</button>}</header>
    <div className="field"><label htmlFor="guide-slug">Slug <span>{form.slug.length}/80</span></label><input id="guide-slug" value={form.slug} maxLength={80} placeholder="how-to-start" onChange={(event) => set("slug", event.target.value)} required /></div>
    <div className="field"><label htmlFor="guide-title">Заголовок <span>{form.title.length}/120</span></label><input id="guide-title" value={form.title} maxLength={120} onChange={(event) => set("title", event.target.value)} autoFocus required /></div>
    <div className="field"><label htmlFor="guide-category">Категория</label><input id="guide-category" value={form.category} maxLength={60} onChange={(event) => set("category", event.target.value)} /></div>
    <div className="field"><label htmlFor="guide-excerpt">Короткое описание <span>{form.excerpt.length}/240</span></label><textarea id="guide-excerpt" value={form.excerpt} maxLength={240} rows={3} onChange={(event) => set("excerpt", event.target.value)} /></div>
    <div className="field news-editor__body-field"><label htmlFor="guide-body">Текст <span>{form.markdown.length}/40000</span></label><textarea id="guide-body" value={form.markdown} maxLength={40000} rows={14} onChange={(event) => set("markdown", event.target.value)} required /><small className="muted">Markdown без HTML: заголовки, списки, ссылки, жирный и курсивный текст.</small></div>
    <label className="news-editor__pin"><input type="checkbox" checked={form.published} onChange={(event) => set("published", event.target.checked)} /><span><strong>Опубликовать на сайте</strong><small>Снимите галочку, чтобы сохранить черновик.</small></span></label>
    <div className="modal-actions news-editor__actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохраняем…" : initial ? "Сохранить" : "Создать гайд"}</button></div>
  </form></div>;
}

function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : formatDateTime(value, { day: "2-digit", month: "short" }); }
