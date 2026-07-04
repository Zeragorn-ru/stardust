// Управление бейджами и градиентами для кастомизации ника.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Badge, Gradient } from "../types";
import { useToast, useConfirm } from "../ui/feedback";

export function CustomizationView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [gradients, setGradients] = useState<Gradient[]>([]);
  const [loading, setLoading] = useState(true);

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

  async function handleCreateBadge() {
    const emoji = prompt("Эмодзи бейджа:");
    if (!emoji) return;
    const label = prompt("Название:");
    if (!label) return;
    const color = prompt("Цвет (hex):", "#ffffff") || "#ffffff";
    try {
      await api.createBadge(emoji, label, color);
      toast.success("Бейдж создан");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    }
  }

  async function handleEditBadge(b: Badge) {
    const emoji = prompt("Эмодзи:", b.emoji);
    if (!emoji) return;
    const label = prompt("Название:", b.label);
    if (!label) return;
    const color = prompt("Цвет (hex):", b.color) || b.color;
    try {
      await api.updateBadge(b.id, emoji, label, color);
      toast.success("Бейдж обновлён");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
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

  async function handleCreateGradient() {
    const label = prompt("Название градиента:");
    if (!label) return;
    const colorStart = prompt("Цвет начала (hex):", "#ff0000") || "#ff0000";
    const colorEnd = prompt("Цвет конца (hex):", "#ff8800") || "#ff8800";
    try {
      await api.createGradient(label, colorStart, colorEnd);
      toast.success("Градиент создан");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    }
  }

  async function handleEditGradient(g: Gradient) {
    const label = prompt("Название:", g.label);
    if (!label) return;
    const colorStart = prompt("Цвет начала:", g.colorStart) || g.colorStart;
    const colorEnd = prompt("Цвет конца:", g.colorEnd) || g.colorEnd;
    try {
      await api.updateGradient(g.id, label, colorStart, colorEnd);
      toast.success("Градиент обновлён");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
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
          <button className="primary" onClick={handleCreateBadge}>+ Создать</button>
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
                    <button className="secondary" onClick={() => handleEditBadge(b)}>Ред.</button>
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
          <button className="primary" onClick={handleCreateGradient}>+ Создать</button>
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
                    <button className="secondary" onClick={() => handleEditGradient(g)}>Ред.</button>
                    <button className="danger" onClick={() => handleDeleteGradient(g)}>Уд.</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
