// Управление бейджами и градиентами для кастомизации ника.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api, ApiError } from "../api";
import type { Badge, Gradient } from "../types";
import { useToast, useConfirm } from "../ui/feedback";
import { useBodyScrollLock } from "../ui/useBodyScrollLock";
import { IconPlus, IconTrash, IconPencil } from "../ui/icons";

export function CustomizationView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [gradients, setGradients] = useState<Gradient[]>([]);
  const [loading, setLoading] = useState(true);
  const [badgeModal, setBadgeModal] = useState<{ mode: "create" } | { mode: "edit"; badge: Badge } | null>(null);
  const [gradientModal, setGradientModal] = useState<{ mode: "create" } | { mode: "edit"; gradient: Gradient } | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, g] = await Promise.all([api.listBadges(), api.listGradients()]);
      setBadges(b);
      setGradients(g);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // ─── Badges CRUD ───

  async function handleSaveBadge(emoji: string, label: string, color: string) {
    try {
      if (badgeModal && "badge" in badgeModal) {
        await api.updateBadge(badgeModal.badge.id, emoji, label, color);
        toast.success("Бейдж обновлён");
      } else {
        await api.createBadge(emoji, label, color);
        toast.success("Бейдж создан");
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
      throw err;
    }
  }

  async function handleDeleteBadge(b: Badge) {
    const ok = await confirm({
      title: `Удалить бейдж «${b.emoji} ${b.label}»?`,
      body: "Будет удалён у всех игроков.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteBadge(b.id);
      toast.success("Бейдж удалён");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    }
  }

  // ─── Gradients CRUD ───

  async function handleSaveGradient(label: string, colorStart: string, colorEnd: string) {
    try {
      if (gradientModal && "gradient" in gradientModal) {
        await api.updateGradient(gradientModal.gradient.id, label, colorStart, colorEnd);
        toast.success("Градиент обновлён");
      } else {
        await api.createGradient(label, colorStart, colorEnd);
        toast.success("Градиент создан");
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
      throw err;
    }
  }

  async function handleDeleteGradient(g: Gradient) {
    const ok = await confirm({
      title: `Удалить градиент «${g.label}»?`,
      body: "Будет удалён у всех игроков.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteGradient(g.id);
      toast.success("Градиент удалён");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    }
  }

  return (
    <div className="view customization-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Cosmetics studio</span>
          <h1>Кастомизация ника</h1>
          <p className="muted">Бейджи и градиенты, которые увидят игроки в TAB и лаунчере.</p>
        </div>
      </header>

      <section className="cosmetics-preview panel panel-flat">
        <div>
          <span className="eyebrow">Preview</span>
          <h2>Как это выглядит</h2>
        </div>
        <div className="nickname-preview-row">
          <span className="badge-sample" style={{ "--badge-color": badges[0]?.color ?? "#7dd3fc" } as CSSProperties}>
            <span className="badge-sample-emoji">{badges[0]?.emoji ?? "✦"}</span>
            <span>{badges[0]?.label ?? "VIP"}</span>
          </span>
          <strong
            className="gradient-name-preview"
            style={{
              "--grad-start": gradients[0]?.colorStart ?? "#7dd3fc",
              "--grad-end": gradients[0]?.colorEnd ?? "#a78bfa",
            } as CSSProperties}
          >
            StardustPlayer
          </strong>
        </div>
      </section>

      <div className="cosmetics-grid">
        <section className="panel panel-flat cosmetics-section">
          <div className="section-head">
            <div>
              <span className="eyebrow">Badges</span>
              <h2>Бейджи</h2>
            </div>
            <button className="primary" onClick={() => setBadgeModal({ mode: "create" })}>
              <IconPlus size={15} /> Создать
            </button>
          </div>
          {loading ? (
            <p className="muted"><span className="spinner" /> Загрузка…</p>
          ) : badges.length === 0 ? (
            <p className="muted">Бейджей пока нет.</p>
          ) : (
            <div className="cosmetic-card-grid">
              {badges.map((b) => (
                <article className="cosmetic-card" key={b.id}>
                  <div className="badge-sample" style={{ "--badge-color": b.color } as CSSProperties}>
                    <span className="badge-sample-emoji">{b.emoji}</span>
                    <span>{b.label}</span>
                  </div>
                  <div className="cosmetic-meta">
                    <span className="color-swatch" style={{ background: b.color }} />
                    <span className="mono muted">{b.color}</span>
                  </div>
                  <div className="cosmetic-actions">
                    <button className="secondary icon-btn" onClick={() => setBadgeModal({ mode: "edit", badge: b })}>
                      <IconPencil size={14} /> Редактировать
                    </button>
                    <button className="danger icon-btn" onClick={() => handleDeleteBadge(b)}>
                      <IconTrash size={14} /> Удалить
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel panel-flat cosmetics-section">
          <div className="section-head">
            <div>
              <span className="eyebrow">Gradients</span>
              <h2>Градиенты</h2>
            </div>
            <button className="primary" onClick={() => setGradientModal({ mode: "create" })}>
              <IconPlus size={15} /> Создать
            </button>
          </div>
          {loading ? (
            <p className="muted"><span className="spinner" /> Загрузка…</p>
          ) : gradients.length === 0 ? (
            <p className="muted">Градиентов пока нет.</p>
          ) : (
            <div className="cosmetic-card-grid">
              {gradients.map((g) => (
                <article className="cosmetic-card" key={g.id}>
                  <strong
                    className="gradient-name-preview gradient-name-preview--card"
                    style={{
                      "--grad-start": g.colorStart,
                      "--grad-end": g.colorEnd,
                    } as CSSProperties}
                  >
                    {g.label}
                  </strong>
                  <div className="gradient-strip" style={{ background: `linear-gradient(90deg, ${g.colorStart}, ${g.colorEnd})` }} />
                  <div className="cosmetic-meta cosmetic-meta--split">
                    <span className="mono muted">{g.colorStart}</span>
                    <span className="mono muted">{g.colorEnd}</span>
                  </div>
                  <div className="cosmetic-actions">
                    <button className="secondary icon-btn" onClick={() => setGradientModal({ mode: "edit", gradient: g })}>
                      <IconPencil size={14} /> Редактировать
                    </button>
                    <button className="danger icon-btn" onClick={() => handleDeleteGradient(g)}>
                      <IconTrash size={14} /> Удалить
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {badgeModal && (
        <BadgeModal
          initial={badgeModal.mode === "edit" ? badgeModal.badge : undefined}
          onSave={handleSaveBadge}
          onClose={() => setBadgeModal(null)}
        />
      )}

      {gradientModal && (
        <GradientModal
          initial={gradientModal.mode === "edit" ? gradientModal.gradient : undefined}
          onSave={handleSaveGradient}
          onClose={() => setGradientModal(null)}
        />
      )}
    </div>
  );
}

function BadgeModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: Badge;
  onSave: (emoji: string, label: string, color: string) => Promise<void>;
  onClose: () => void;
}) {
  useBodyScrollLock();
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [color, setColor] = useState(initial?.color ?? "#ffffff");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!emoji.trim() || !label.trim() || !color.trim()) return;
    setBusy(true);
    try {
      await onSave(emoji.trim(), label.trim(), color.trim());
      onClose();
    } catch {
      // toast is handled in parent
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? "Редактировать бейдж" : "Создать бейдж"}</h3>
        <div className="field">
          <label>Эмодзи</label>
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="напр. ⭐"
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label>Название</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="напр. VIP"
            required
          />
        </div>
        <div className="field">
          <label>Цвет (hex)</label>
          <input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="#ffffff"
            required
          />
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="submit" disabled={busy || !emoji.trim() || !label.trim() || !color.trim()}>
            {busy ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}

function GradientModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: Gradient;
  onSave: (label: string, colorStart: string, colorEnd: string) => Promise<void>;
  onClose: () => void;
}) {
  useBodyScrollLock();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [colorStart, setColorStart] = useState(initial?.colorStart ?? "#ff0000");
  const [colorEnd, setColorEnd] = useState(initial?.colorEnd ?? "#ff8800");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !colorStart.trim() || !colorEnd.trim()) return;
    setBusy(true);
    try {
      await onSave(label.trim(), colorStart.trim(), colorEnd.trim());
      onClose();
    } catch {
      // toast is handled in parent
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? "Редактировать градиент" : "Создать градиент"}</h3>
        <div className="field">
          <label>Название</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="напр. Огненный"
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label>Цвет начала (hex)</label>
          <input
            value={colorStart}
            onChange={(e) => setColorStart(e.target.value)}
            placeholder="#ff0000"
            required
          />
        </div>
        <div className="field">
          <label>Цвет конца (hex)</label>
          <input
            value={colorEnd}
            onChange={(e) => setColorEnd(e.target.value)}
            placeholder="#ff8800"
            required
          />
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="submit" disabled={busy || !label.trim() || !colorStart.trim() || !colorEnd.trim()}>
            {busy ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}
