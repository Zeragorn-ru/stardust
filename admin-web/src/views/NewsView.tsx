import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { NewsPost } from "../types";
import { useConfirm, useToast } from "../ui/feedback";

export function NewsView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<NewsPost | "new" | null>(null);
  const load = useCallback(async () => {
    try { setPosts(await api.listNews()); } catch (error) { toast.error(error instanceof ApiError ? error.message : "Не удалось загрузить новости"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  async function remove(post: NewsPost) {
    if (!await confirm({ title: `Удалить «${post.title}»?`, body: "Новость исчезнет из лаунчера.", confirmText: "Удалить", danger: true })) return;
    try { await api.deleteNews(post.id); toast.success("Новость удалена"); await load(); } catch (error) { toast.error(error instanceof ApiError ? error.message : "Ошибка удаления"); }
  }
  return <div className="view news-view">
    <header className="view-head page-head"><div><span className="eyebrow">Launcher feed</span><h1>Новости</h1><p className="muted">Текстовые объявления для игроков. Markdown: заголовки, списки, <code>**жирный**</code>, <code>*курсив*</code>, <code>`код`</code> и HTTPS-ссылки.</p></div><button className="primary" onClick={() => setEditing("new")}>Создать новость</button></header>
    {loading ? <p className="muted"><span className="spinner" /> Загрузка…</p> : posts.length === 0 ? <section className="panel panel-flat"><p className="muted">Новостей пока нет. Первая запись появится на кнопке лаунчера.</p></section> : <section className="news-admin-list">{posts.map((post) => <article className="panel panel-flat news-admin-card" key={post.id}><div><div className="news-admin-card__meta">{post.pinned && <span>Закреплено</span>}<span>{post.authorName}</span><span>{formatDate(post.updatedAt)}</span></div><h2>{post.title}</h2><p className="muted news-admin-card__excerpt">{post.markdown}</p></div><div className="cosmetic-actions"><button className="secondary" onClick={() => setEditing(post)}>Редактировать</button><button className="danger" onClick={() => void remove(post)}>Удалить</button></div></article>)}</section>}
    {editing && <NewsEditor initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
  </div>;
}

function NewsEditor({ initial, onClose, onSaved }: { initial?: NewsPost; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [markdown, setMarkdown] = useState(initial?.markdown ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try { if (initial) await api.updateNews(initial.id, { title, markdown, pinned }); else await api.createNews({ title, markdown, pinned }); toast.success(initial ? "Новость обновлена" : "Новость опубликована"); await onSaved(); } catch (error) { toast.error(error instanceof ApiError ? error.message : "Ошибка сохранения"); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="modal news-editor" onClick={(event) => event.stopPropagation()} onSubmit={submit}><h3>{initial ? "Редактировать новость" : "Новая новость"}</h3><div className="field"><label>Заголовок</label><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} autoFocus required /></div><div className="field"><label>Текст (Markdown)</label><textarea value={markdown} maxLength={12000} rows={14} onChange={(event) => setMarkdown(event.target.value)} required /></div><label className="news-editor__pin"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Закрепить: показывать эту новость на кнопке лаунчера</label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button></div></form></div>;
}

function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU"); }
