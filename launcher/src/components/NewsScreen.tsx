import { useEffect, useState, type ReactNode } from "react";
import { getNews, openExternal } from "../api";
import type { NewsPost } from "../types";

export default function NewsScreen({ onClose }: { onClose: () => void }) {
  const [posts, setPosts] = useState<NewsPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getNews().then(setPosts).catch(() => setError("Не удалось загрузить новости. Проверьте подключение и попробуйте позже."));
  }, []);

  return <main className="news-screen stagger">
    <header className="settings__header">
      <div><span className="news-screen__eyebrow">StarDust</span><h1>Новости</h1><p className="muted">Обновления сервера, события и важные объявления.</p></div>
      <button type="button" className="btn btn--ghost" onClick={onClose}>Назад</button>
    </header>
    <div className="news-screen__feed">
      {posts === null && !error && <div className="settings__loading"><div className="spinner" /><span className="muted">Загружаем новости…</span></div>}
      {error && <p className="muted">{error}</p>}
      {posts?.length === 0 && <p className="muted">Новостей пока нет.</p>}
      {posts?.map((post) => <article className="news-post stagger-item" key={post.id}>
        <div className="news-post__meta">{post.pinned && <span className="news-post__pin">Закреплено</span>}<span>{post.authorName}</span><span>{formatDate(post.updatedAt)}</span></div>
        <h2>{post.title}</h2><Markdown text={post.markdown} />
      </article>)}
    </div>
  </main>;
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = (`h${level + 2}`) as "h3" | "h4" | "h5";
      blocks.push(<Tag key={index}>{formatInline(heading[2])}</Tag>);
      index += 1;
      continue;
    }
    const ordered = /^\d+\.\s+/.test(line);
    const list: string[] = [];
    while (index < lines.length && (ordered ? /^\d+\.\s+/.test(lines[index].trim()) : /^[-*]\s+/.test(lines[index].trim()))) {
      list.push(lines[index].trim().replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ""));
      index += 1;
    }
    if (list.length > 0) {
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={index}>{list.map((item, itemIndex) => <li key={itemIndex}>{formatInline(item)}</li>)}</Tag>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,3})\s+/.test(lines[index]) && !/^[-*]\s+/.test(lines[index].trim()) && !/^\d+\.\s+/.test(lines[index].trim())) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={index}>{paragraph.map((item, itemIndex) => <span key={itemIndex}>{formatInline(item)}{itemIndex < paragraph.length - 1 && <br />}</span>)}</p>);
  }
  return <div className="news-post__content">{blocks}</div>;
}

function formatInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    return link
      ? <a key={index} href={link[2]} onClick={(event) => { event.preventDefault(); void openExternal(link[2]); }}>{link[1]}</a>
      : part;
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
