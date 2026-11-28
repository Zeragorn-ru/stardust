// SectionCard — карточка-секция дашборда с заголовком.
// Ошибка загрузки секции показывается внутри карточки и не валит
// остальные секции дашборда.

import type { ReactNode } from "react";

export interface SectionCardProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Слот справа от заголовка (кнопки, бейджи). */
  actions?: ReactNode;
  /** Сообщение об ошибке загрузки секции. */
  error?: ReactNode;
  /** Данные ещё грузятся. */
  loading?: boolean;
  children?: ReactNode;
}

export function SectionCard({ title, subtitle, actions, error, loading, children }: SectionCardProps) {
  return (
    <section className="kit-card">
      <div className="kit-card-head">
        <div>
          <h2 className="kit-card-title">{title}</h2>
          {subtitle && <div className="kit-card-subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="kit-card-actions">{actions}</div>}
      </div>
      {error && <div className="kit-card-error">{error}</div>}
      {loading && !error && (
        <div className="kit-card-loading">
          <span className="spinner" />
          Загрузка…
        </div>
      )}
      {!loading && children}
    </section>
  );
}
