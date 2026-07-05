// Управление бейджами и градиентами для кастомизации ника.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Badge, Gradient } from "../types";
import { useToast, useConfirm } from "../ui/feedback";
import { useBodyScrollLock } from "../ui/useBodyScrollLock";

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

  if (loading) {
    return <div className="panel muted"><span className="spinner" /> Загрузка…</div>;
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Кастомизация ника</h1>
      </header>

      {/* Бейджи */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Бейджи</h2>
          <button className="primary" onClick={() => setBadgeModal({ mode: "create" })}>+ Создать</button>
        </div>
        {badges.length === 0 ? (
          <p className="muted">Бейджей пока нет.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 50 }}></th>
                <th>Название</th>
                <th>Цвет</th>
                <th style={{ width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {badges.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontSize: 20, textAlign: "center" }}>{b.emoji}</td>
                  <td>{b.label}</td>
                  <td>
                    <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 3, background: b.color, verticalAlign: "middle", marginRight: 6 }} />
                    <span className="mono muted">{b.color}</span>
                  </td>
                  <td>
                    <button className="secondary" onClick={() => setBadgeModal({ mode: "edit", badge: b })}>Ред.</button>
                    <button className="danger" onClick={() => handleDeleteBadge(b)}>Уд.</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Градиенты */}
      <div className="panel">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Градиенты</h2>
          <button className="primary" onClick={() => setGradientModal({ mode: "create" })}>+ Создать</button>
        </div>
        {gradients.length === 0 ? (
          <p className="muted">Градиентов пока нет.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Превью</th>
                <th style={{ width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {gradients.map((g) => (
                <tr key={g.id}>
                  <td>{g.label}</td>
                  <td>
                    <span
                      style={{
                        display: "inline-block",
                        width: 120,
                        height: 20,
                        borderRadius: 4,
                        background: `linear-gradient(90deg, ${g.colorStart}, ${g.colorEnd})`,
                      }}
                    />
                    <span className="mono muted" style={{ marginLeft: 8, fontSize: 12 }}>
                      {g.colorStart} → {g.colorEnd}
                    </span>
                  </td>
                  <td>
                    <button className="secondary" onClick={() => setGradientModal({ mode: "edit", gradient: g })}>Ред.</button>
                    <button className="danger" onClick={() => handleDeleteGradient(g)}>Уд.</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
