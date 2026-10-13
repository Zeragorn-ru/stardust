// Общий список карточек для экранов «Новости» и «Гайды» (план 3.6).
//
// Одна разметка для обоих разделов: экраны отличаются только
// метаданными карточки и набором действий, а мобильные стили новостей
// (sticky-голова, 44px-кнопки) применяются к обоим через общий класс
// news-view--mobile на корне экрана.
//
// Карточка редактируется переходом: `onOpen(id)` на десктопе ведёт на
// `/news/:id` или `/guides/:id`, на мобильном открывает модалку.

import type { ReactNode } from "react";
import { formatDateTime } from "../format";

export interface NewsAdminCard {
  id: number;
  /** Главная строка: заголовок поста/гайда. */
  title: string;
  /** Текст для выжимки: markdown поста или excerpt гайда. */
  excerpt: string;
  /** Верхняя строка меты: автор/категория и т.п. */
  meta: ReactNode[];
  /** Дата последнего обновления — правый конец строки меты. */
  updatedAt: string;
  /** Дополнительная строка под выжимкой (напр. /guides/slug). */
  footnote?: string;
  /** Открывает редактор (маршрут на десктопе, модалку на мобильном). */
  onOpen: () => void;
}

export function NewsAdminList({
  cards,
  onRemove,
  removeLabel = "Удалить",
}: {
  cards: NewsAdminCard[];
  /** Удаление с подтверждением — логика остаётся в экране-владельце. */
  onRemove: (id: number) => void;
  removeLabel?: string;
}) {
  return (
    <section className="news-admin-list">
      {cards.map((card) => (
        <article className="panel panel-flat news-admin-card" key={card.id}>
          <div className="news-admin-card__body">
            <div className="news-admin-card__meta">
              {card.meta.map((node, i) => (
                <span key={i}>{node}</span>
              ))}
              <span>{formatDateTime(card.updatedAt, { day: "2-digit", month: "short" })}</span>
            </div>
            <h2>
              <button
                type="button"
                className="news-admin-card__title"
                onClick={card.onOpen}
              >
                {card.title}
              </button>
            </h2>
            <p className="muted news-admin-card__excerpt">{card.excerpt}</p>
            {card.footnote && <small className="muted">{card.footnote}</small>}
          </div>
          <div className="news-admin-card__actions">
            <button className="secondary" type="button" onClick={card.onOpen}>
              Изменить
            </button>
            <button
              className="danger"
              type="button"
              onClick={() => onRemove(card.id)}
            >
              {removeLabel}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
