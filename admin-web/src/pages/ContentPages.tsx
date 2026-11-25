// Новости и гайды: общий редактор контента с dirty-guard и предпросмотром.
// Маршруты /news, /news/:id|new, /guides, /guides/:id|new.

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { Guide, NewsPost } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Form,
  IconButton,
  Input,
  PageHeader,
  PageState,
  Panel,
  Switch,
  Textarea,
} from "../ui/components";
import { useToast } from "../ui/feedback";
import { useRouteDirtyGuard } from "../ui/useRouteGuard";
import { Markdown } from "../ui/Markdown";
import { formatDateTime } from "../format";
import { IconArrowLeft, IconPlus, IconTrash } from "../ui/icons";

// ───────────────────────── Новости ─────────────────────────

export function NewsPage() {
  const { id } = useParams();

  if (id === "new") return <NewsEditor />;
  if (id != null && /^\d+$/.test(id)) return <NewsEditor postId={Number(id)} />;
  return <NewsList />;
}

function NewsList() {
  const navigate = useNavigate();
  const toast = useToast();
  const fetcher = useCallback(() => api.listNews(), []);
  const { data, loading, error, reload } = useAsyncData(fetcher);

  async function remove(post: NewsPost) {
    if (!window.confirm(`Удалить новость «${post.title}»?`)) return;
    try {
      await api.deleteNews(post.id);
      toast.success("Новость удалена");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Новости"
        actions={
          <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => navigate("/news/new")}>
            Написать
          </Button>
        }
      />
      <PageState loading={loading} error={error} onRetry={reload}>
        <Panel flush>
          {(data ?? []).length === 0 ? (
            <EmptyState
              title="Новостей нет"
              body="Первая публикация появится в лаунчере сразу после сохранения."
              action={
                <Button variant="primary" onClick={() => navigate("/news/new")}>
                  Написать
                </Button>
              }
            />
          ) : (
            <div className="event-list">
              {(data ?? []).map((post) => (
                <div key={post.id} className="event-row" style={{ height: "auto", minHeight: "var(--row-h)", padding: "var(--s3) var(--s2)" }}>
                  <div className="grow ellipsis">
                    <div className="row">
                      <button type="button" className="linklike ellipsis" onClick={() => navigate(`/news/${post.id}`)}>
                        {post.title}
                      </button>
                      {post.pinned && <Chip tone="accent">закреплено</Chip>}
                    </div>
                    <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                      {post.authorName} · {formatDateTime(post.createdAt)}
                    </span>
                  </div>
                  <IconButton label="Удалить" size="sm" onClick={() => void remove(post)}>
                    <IconTrash size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </PageState>
    </div>
  );
}

function NewsEditor({ postId }: { postId?: number }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [pinned, setPinned] = useState(false);
  const [loading, setLoading] = useState(postId != null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (postId == null) return;
    let cancelled = false;
    api.listNews().then((posts) => {
      if (cancelled) return;
      const post = posts.find((p) => p.id === postId);
      if (post) {
        setTitle(post.title);
        setMarkdown(post.markdown);
        setPinned(post.pinned);
      } else {
        toast.error("Новость не найдена");
        navigate("/news", { replace: true });
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  useRouteDirtyGuard({ isDirty: dirty, isBusy: busy });

  function touch<T>(setter: (v: T) => void) {
    return (v: T) => {
      setDirty(true);
      setter(v);
    };
  }

  async function save() {
    setBusy(true);
    try {
      if (postId != null) await api.updateNews(postId, { title: title.trim(), markdown, pinned });
      else await api.createNews({ title: title.trim(), markdown, pinned });
      toast.success("Новость сохранена");
      setDirty(false);
      navigate("/news");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page-state"><span className="spinner spinner-lg" />Загрузка…</div>;

  return (
    <div className="page-stack">
      <PageHeader
        title={postId != null ? "Редактирование новости" : "Новая новость"}
        actions={
          <>
            <Button icon={<IconArrowLeft size={15} />} onClick={() => navigate("/news")}>
              К списку
            </Button>
            <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={save}>
              Сохранить
            </Button>
          </>
        }
      />
      <Form>
        <Field label="Заголовок" wide>
          <Input value={title} onChange={(e) => touch(setTitle)(e.target.value)} />
        </Field>
        <Field label="Текст (Markdown)" wide>
          <Textarea value={markdown} onChange={(e) => touch(setMarkdown)(e.target.value)} rows={18} />
        </Field>
        <div className="field-wide row">
          <Switch checked={pinned} onChange={(v) => touch(setPinned)(v)} label="Закрепить сверху" />
        </div>
      </Form>
      {markdown.trim() && (
        <Panel title="Предпросмотр">
          <div className="markdown-preview">
            <Markdown text={markdown} />
          </div>
        </Panel>
      )}
    </div>
  );
}

// ───────────────────────── Гайды ─────────────────────────

export function GuidesPage() {
  const { id } = useParams();

  if (id === "new") return <GuideEditor />;
  if (id != null && /^\d+$/.test(id)) return <GuideEditor guideId={Number(id)} />;
  return <GuidesList />;
}

function GuidesList() {
  const navigate = useNavigate();
  const toast = useToast();
  const fetcher = useCallback(() => api.listGuides(), []);
  const { data, loading, error, reload } = useAsyncData(fetcher);

  async function remove(guide: Guide) {
    if (!window.confirm(`Удалить гайд «${guide.title}»?`)) return;
    try {
      await api.deleteGuide(guide.id);
      toast.success("Гайд удалён");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Гайды"
        actions={
          <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => navigate("/guides/new")}>
            Написать
          </Button>
        }
      />
      <PageState loading={loading} error={error} onRetry={reload}>
        <Panel flush>
          {(data ?? []).length === 0 ? (
            <EmptyState
              title="Гайдов нет"
              body="База знаний для игроков пока пуста."
              action={
                <Button variant="primary" onClick={() => navigate("/guides/new")}>
                  Написать
                </Button>
              }
            />
          ) : (
            <div className="event-list">
              {(data ?? []).map((guide) => (
                <div key={guide.id} className="event-row" style={{ height: "auto", minHeight: "var(--row-h)", padding: "var(--s3) var(--s2)" }}>
                  <div className="grow ellipsis">
                    <div className="row">
                      <button type="button" className="linklike ellipsis" onClick={() => navigate(`/guides/${guide.id}`)}>
                        {guide.title}
                      </button>
                      <Chip>{guide.category}</Chip>
                      {guide.published ? <Chip tone="ok">опубликован</Chip> : <Chip tone="warn">черновик</Chip>}
                    </div>
                    <span className="faint ellipsis" style={{ fontSize: "var(--fs-xs)" }}>
                      {guide.excerpt}
                    </span>
                  </div>
                  <IconButton label="Удалить" size="sm" onClick={() => void remove(guide)}>
                    <IconTrash size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </PageState>
    </div>
  );
}

function GuideEditor({ guideId }: { guideId?: number }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [published, setPublished] = useState(false);
  const [loading, setLoading] = useState(guideId != null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (guideId == null) return;
    let cancelled = false;
    api.listGuides().then((guides) => {
      if (cancelled) return;
      const guide = guides.find((g) => g.id === guideId);
      if (guide) {
        setTitle(guide.title);
        setSlug(guide.slug);
        setCategory(guide.category);
        setExcerpt(guide.excerpt);
        setMarkdown(guide.markdown);
        setPublished(guide.published);
      } else {
        toast.error("Гайд не найден");
        navigate("/guides", { replace: true });
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideId]);

  useRouteDirtyGuard({ isDirty: dirty, isBusy: busy });

  function touch<T>(setter: (v: T) => void) {
    return (v: T) => {
      setDirty(true);
      setter(v);
    };
  }

  async function save() {
    setBusy(true);
    const input = {
      title: title.trim(),
      slug: slug.trim(),
      category: category.trim(),
      excerpt: excerpt.trim(),
      markdown,
      published,
    };
    try {
      if (guideId != null) await api.updateGuide(guideId, input);
      else await api.createGuide(input);
      toast.success("Гайд сохранён");
      setDirty(false);
      navigate("/guides");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page-state"><span className="spinner spinner-lg" />Загрузка…</div>;

  return (
    <div className="page-stack">
      <PageHeader
        title={guideId != null ? "Редактирование гайда" : "Новый гайд"}
        actions={
          <>
            <Button icon={<IconArrowLeft size={15} />} onClick={() => navigate("/guides")}>
              К списку
            </Button>
            <Button variant="primary" busy={busy} disabled={!title.trim() || !slug.trim()} onClick={save}>
              Сохранить
            </Button>
          </>
        }
      />
      <Form>
        <Field label="Заголовок">
          <Input value={title} onChange={(e) => touch(setTitle)(e.target.value)} />
        </Field>
        <Field label="Слаг (URL)" hint="Латиница и дефисы, например getting-started">
          <Input value={slug} onChange={(e) => touch(setSlug)(e.target.value)} className="mono" />
        </Field>
        <Field label="Категория">
          <Input value={category} onChange={(e) => touch(setCategory)(e.target.value)} />
        </Field>
        <Field label="Краткое описание">
          <Input value={excerpt} onChange={(e) => touch(setExcerpt)(e.target.value)} />
        </Field>
        <Field label="Текст (Markdown)" wide>
          <Textarea value={markdown} onChange={(e) => touch(setMarkdown)(e.target.value)} rows={18} />
        </Field>
        <div className="field-wide row">
          <Switch checked={published} onChange={(v) => touch(setPublished)(v)} label="Опубликован" />
        </div>
      </Form>
      {markdown.trim() && (
        <Panel title="Предпросмотр">
          <div className="markdown-preview">
            <Markdown text={markdown} />
          </div>
        </Panel>
      )}
    </div>
  );
}
