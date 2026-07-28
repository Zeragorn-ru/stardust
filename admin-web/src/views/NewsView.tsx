import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import type { NewsPost } from "../types";
import { useConfirm, useToast } from "../ui/feedback";

export function NewsView({ mobile = false }: { mobile?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<NewsPost | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setPosts(await api.listNews());
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось загрузить новости");
    } finally {
      setLoading(false);
    }
  }, [toast]);

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

  return (
    <div className={`view news-view${mobile ? " news-view--mobile" : ""}`}>
      <header className="view-head page-head news-view__head">
        <div>
          <span className="eyebrow">Launcher feed</span>
          <h1>Новости</h1>
          <p className="muted">Объявления для игроков в лаунчере.</p>
        </div>
        <button className="primary news-view__create" type="button" onClick={() => setEditing("new")}>
          Создать новость
        </button>
      </header>

      {!mobile && (
        <p className="muted news-view__hint">
          Markdown: заголовки, списки, <code>**жирный**</code>, <code>*курсив*</code>, <code>`код`</code> и HTTPS-ссылки.
        </p>
      )}

      {loading ? (
        <p className="muted"><span className="spinner" /> Загрузка…</p>
      ) : posts.length === 0 ? (
        <section className="panel panel-flat news-empty">
          <strong>Пока нет публикаций</strong>
          <p className="muted">Создайте первое объявление. Оно появится в ленте лаунчера.</p>
          <button className="secondary" type="button" onClick={() => setEditing("new")}>Создать первую новость</button>
        </section>
      ) : (
        <section className="news-admin-list">
          {posts.map((post) => (
            <article className="panel panel-flat news-admin-card" key={post.id}>
              <div className="news-admin-card__body">
                <div className="news-admin-card__meta">
                  {post.pinned && <span className="news-admin-card__pinned">Закреплено</span>}
                  <span>{post.authorName}</span>
                  <span>{formatDate(post.updatedAt)}</span>
                </div>
                <h2>{post.title}</h2>
                <p className="muted news-admin-card__excerpt">{post.markdown}</p>
              </div>
              <div className="news-admin-card__actions">
                <button className="secondary" type="button" onClick={() => setEditing(post)}>Изменить</button>
                <button className="danger" type="button" onClick={() => void remove(post)}>Удалить</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {editing && (
        <NewsEditor
          initial={editing === "new" ? undefined : editing}
          mobile={mobile}
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

function NewsEditor({ initial, mobile, onClose, onSaved }: {
  initial?: NewsPost;
  mobile: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [markdown, setMarkdown] = useState(initial?.markdown ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [busy, setBusy] = useState(false);

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
      await onSaved();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Ошибка сохранения");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`modal-backdrop news-editor-backdrop${mobile ? " news-editor-backdrop--mobile" : ""}`} onClick={onClose}>
      <form className="modal news-editor" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <header className="news-editor__head">
          <div>
            <span className="eyebrow">Launcher feed</span>
            <h3>{initial ? "Редактировать новость" : "Новая новость"}</h3>
          </div>
          {mobile && <button className="news-editor__close" type="button" aria-label="Закрыть" onClick={onClose}>Закрыть</button>}
        </header>
        <div className="field">
          <label htmlFor="news-title">Заголовок <span>{title.length}/120</span></label>
          <input id="news-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} autoFocus required />
        </div>
        <div className="field news-editor__body-field">
          <label htmlFor="news-body">Текст <span>{markdown.length}/12000</span></label>
          <textarea id="news-body" value={markdown} maxLength={12000} rows={14} onChange={(event) => setMarkdown(event.target.value)} required />
          <small className="muted">Поддерживается Markdown: заголовки, списки, жирный текст, курсив и HTTPS-ссылки.</small>
        </div>
        <label className="news-editor__pin">
          <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
          <span><strong>Закрепить новость</strong><small>Она будет показана на главном экране лаунчера.</small></span>
        </label>
        <div className="modal-actions news-editor__actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : initial ? "Сохранить" : "Опубликовать"}</button>
        </div>
      </form>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
