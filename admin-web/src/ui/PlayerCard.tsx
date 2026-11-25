// Карточка игрока: модерация, Telegram, статистика, скин, кастомизация.
// Все действия из прежних модалок сведены в один модальный центр с табами.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Account, PlayerCustomization, PlayerStats } from "../types";
import {
  Button,
  Chip,
  CopyButton,
  Field,
  Form,
  FormActions,
  Input,
  Modal,
  Select,
  Tabs,
  Textarea,
} from "./components";
import { useToast } from "./feedback";
import { SkinHead } from "./SkinHead";
import { formatDateTime, formatPlaytime } from "../format";

type Tab = "profile" | "moderation" | "skin" | "customization";

export function PlayerCard({
  account,
  onClose,
  onChanged,
}: {
  account: Account;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");

  return (
    <Modal title={`Игрок: ${account.username}`} size="lg" onClose={onClose}>
      <Tabs
        tabs={[
          { key: "profile", label: "Профиль" },
          { key: "moderation", label: "Модерация" },
          { key: "skin", label: "Скин" },
          { key: "customization", label: "Кастомизация" },
        ]}
        active={tab}
        onSelect={setTab}
      />
      <div style={{ paddingTop: "var(--s4)" }}>
        {tab === "profile" && <ProfileTab account={account} />}
        {tab === "moderation" && (
          <ModerationTab account={account} onChanged={onChanged} onClose={onClose} />
        )}
        {tab === "skin" && <SkinTab account={account} onChanged={onChanged} />}
        {tab === "customization" && <CustomizationTab account={account} />}
      </div>
    </Modal>
  );
}

// ───────────────────────── Профиль ─────────────────────────

function ProfileTab({ account }: { account: Account }) {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getAccountStats(account.uuid)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((err) => { if (!cancelled) setStatsError(err instanceof Error ? err.message : "—"); });
    return () => { cancelled = true; };
  }, [account.uuid]);

  return (
    <div className="page-stack">
      <div className="kv-grid">
        <div className="kv-row">
          <span className="faint">UUID</span>
          <span className="row mono ellipsis" title={account.uuid}>
            {account.uuid.slice(0, 18)}…
            <CopyButton text={account.uuid} />
          </span>
        </div>
        <div className="kv-row">
          <span className="faint">Время в игре</span>
          <span>{stats ? formatPlaytime(stats.playtimeSeconds) : (statsError ?? "—")}</span>
        </div>
        <div className="kv-row">
          <span className="faint">Был в игре</span>
          <span>{stats?.lastJoinedAt ? formatDateTime(stats.lastJoinedAt) : "—"}</span>
        </div>
        <div className="kv-row">
          <span className="faint">Telegram</span>
          <span>
            {account.telegramLinked ? (
              <Chip tone="ok">привязан</Chip>
            ) : (
              <span className="faint">не привязан</span>
            )}
          </span>
        </div>
      </div>
      {statsError && (
        <div className="stale-banner" style={{ borderRadius: "var(--radius)" }}>
          Статистика недоступна: {statsError}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Модерация ─────────────────────────

function ModerationTab({
  account,
  onChanged,
  onClose,
}: {
  account: Account;
  onChanged: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState(account.username);
  const [banReason, setBanReason] = useState("");
  const [banDuration, setBanDuration] = useState("");
  const [password, setPassword] = useState("");
  const [telegramChatId, setTelegramChatId] = useState(account.telegramChatId ?? "");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Действие не удалось");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <Form>
        <Field label="Ник" wide>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <FormActions>
          <Button
            busy={busy}
            disabled={!username.trim() || username.trim() === account.username}
            onClick={() => run(() => api.renameAccount(account.uuid, username.trim()), "Ник изменён")}
          >
            Переименовать
          </Button>
        </FormActions>

        <Field label="Роль">
          <Select
            value={account.isAdmin ? "admin" : "user"}
            onChange={(e) =>
              run(
                () => api.setRole(account.uuid, e.target.value as "admin" | "user"),
                "Роль изменена",
              )
            }
          >
            <option value="user">Игрок</option>
            <option value="admin">Админ</option>
          </Select>
        </Field>
        <Field label="Новый пароль" hint="Старый пароль не требуется">
          <div className="row">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <Button
              busy={busy}
              disabled={password.length < 4}
              onClick={() => {
                const p = password;
                setPassword("");
                return run(() => api.setPassword(account.uuid, p), "Пароль обновлён");
              }}
            >
              Задать
            </Button>
          </div>
        </Field>

        <Field label="Telegram chat_id" hint="Пусто — отвязать">
          <div className="row">
            <Input
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              className="mono"
            />
            <Button
              busy={busy}
              onClick={() =>
                run(
                  () => api.setTelegram(account.uuid, telegramChatId.trim() || null),
                  "Telegram обновлён",
                )
              }
            >
              Сохранить
            </Button>
            {account.telegramLinked && (
              <Button
                variant="danger"
                busy={busy}
                onClick={() => run(() => api.unlinkTelegram(account.uuid), "Telegram отвязан")}
              >
                Отвязать
              </Button>
            )}
          </div>
        </Field>
      </Form>

      <div className="danger-zone">
        <h3>Блокировка</h3>
        {account.banned ? (
          <div className="row" style={{ gap: "var(--s2)" }}>
            <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              {account.banReason ? `Причина: ${account.banReason}. ` : ""}
              {account.bannedUntil ? `До ${formatDateTime(account.bannedUntil)}` : "Постоянный"}
            </span>
            <span className="spacer" />
            <Button
              busy={busy}
              onClick={() => run(() => api.unbanAccount(account.uuid), "Блокировка снята")}
            >
              Разбанить
            </Button>
          </div>
        ) : (
          <Form>
            <Field label="Причина">
              <Textarea
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                rows={2}
              />
            </Field>
            <Field label="Длительность" hint="Часы; пусто — навсегда">
              <Input
                type="number"
                min={1}
                value={banDuration}
                onChange={(e) => setBanDuration(e.target.value)}
                placeholder="навсегда"
              />
            </Field>
            <FormActions>
              <Button
                variant="danger"
                busy={busy}
                disabled={!banReason.trim()}
                onClick={() =>
                  run(
                    () =>
                      api.banAccount(account.uuid, {
                        reason: banReason.trim(),
                        ...(banDuration
                          ? { durationSecs: Number(banDuration) * 3600 }
                          : {}),
                      }),
                    "Аккаунт заблокирован",
                  )
                }
              >
                Забанить
              </Button>
            </FormActions>
          </Form>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── Скин ─────────────────────────

function SkinTab({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<"classic" | "slim">("classic");
  const [hasSkin, setHasSkin] = useState<boolean | null>(null);

  const reloadSkin = useCallback(() => {
    api.getAccountSkin(account.uuid).then((s) => setHasSkin(s != null)).catch(() => setHasSkin(false));
  }, [account.uuid]);

  useEffect(() => {
    reloadSkin();
  }, [reloadSkin]);

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      await api.setAccountSkin(account.uuid, file, model);
      toast.success("Скин обновлён");
      reloadSkin();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось загрузить скин");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="row" style={{ gap: "var(--s4)", alignItems: "flex-start" }}>
        <SkinHead uuid={account.uuid} username={account.username} size={96} />
        <div className="page-stack grow" style={{ gap: "var(--s3)" }}>
          <Field label="Модель">
            <Select value={model} onChange={(e) => setModel(e.target.value as "classic" | "slim")}>
              <option value="classic">Классическая (4px руки)</option>
              <option value="slim">Тонкая (Alex, 3px руки)</option>
            </Select>
          </Field>
          <Field label="PNG-файл" hint="Стандартный скин 64×64">
            <input
              className="input"
              type="file"
              accept="image/png"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="row">
            {hasSkin === false && <span className="faint">Скин не задан</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Кастомизация ─────────────────────────

function CustomizationTab({ account }: { account: Account }) {
  const toast = useToast();
  const [custom, setCustom] = useState<PlayerCustomization | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getAccountCustomization(account.uuid).then(setCustom).catch(() => setCustom(null));
  }, [account.uuid]);

  if (!custom) {
    return <p className="muted">Кастомизация недоступна.</p>;
  }

  const ownedBadges = new Set(custom.ownedBadgeIds ?? custom.availableBadges.map((b) => b.id));
  const ownedGradients = new Set(custom.ownedGradientIds ?? custom.availableGradients.map((g) => g.id));

  async function save(patch: Partial<{ badgeIds: number[]; gradientIds: number[]; activeBadge: number | null; activeGradient: number | null }>) {
    setBusy(true);
    try {
      if (patch.badgeIds) await api.setAccountBadges(account.uuid, patch.badgeIds);
      if (patch.gradientIds) await api.setAccountGradients(account.uuid, patch.gradientIds);
      if ("activeBadge" in patch || "activeGradient" in patch) {
        await api.setAccountActive(
          account.uuid,
          patch.activeBadge !== undefined ? patch.activeBadge : custom?.activeBadgeId ?? null,
          patch.activeGradient !== undefined ? patch.activeGradient : custom?.activeGradientId ?? null,
        );
      }
      const updated = await api.getAccountCustomization(account.uuid);
      setCustom(updated);
      toast.success("Кастомизация сохранена");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <div>
        <h3 style={{ marginBottom: "var(--s2)" }}>Бейджи</h3>
        <div className="flags-row">
          {custom.availableBadges.map((badge) => (
            <Chip
              key={badge.id}
              tone={custom.activeBadgeId === badge.id ? "accent" : "neutral"}
              title={badge.description}
            >
              <button
                type="button"
                className="chip-toggle"
                disabled={busy || !ownedBadges.has(badge.id)}
                onClick={() =>
                  void save({
                    badgeIds: ownedBadgeIds(custom, badge.id),
                    activeBadge: custom.activeBadgeId === badge.id ? null : badge.id,
                  })
                }
              >
                {badge.emoji} {badge.label}
              </button>
            </Chip>
          ))}
        </div>
      </div>
      <div>
        <h3 style={{ marginBottom: "var(--s2)" }}>Градиенты</h3>
        <div className="flags-row">
          {custom.availableGradients.map((gradient) => (
            <Chip
              key={gradient.id}
              tone={custom.activeGradientId === gradient.id ? "accent" : "neutral"}
              title={gradient.description}
            >
              <button
                type="button"
                className="chip-toggle"
                disabled={busy || !ownedGradients.has(gradient.id)}
                onClick={() =>
                  void save({
                    gradientIds: ownedGradientIds(custom, gradient.id),
                    activeGradient: custom.activeGradientId === gradient.id ? null : gradient.id,
                  })
                }
              >
                <span
                  className="gradient-dot"
                  style={{
                    background: `linear-gradient(135deg, ${gradient.colorStart}, ${gradient.colorEnd})`,
                  }}
                />
                {gradient.label}
              </button>
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

function ownedBadgeIds(custom: PlayerCustomization, badgeId: number): number[] {
  const set = new Set(custom.ownedBadgeIds ?? custom.availableBadges.map((b) => b.id));
  if (set.has(badgeId)) set.delete(badgeId);
  else set.add(badgeId);
  return Array.from(set);
}

function ownedGradientIds(custom: PlayerCustomization, gradientId: number): number[] {
  const set = new Set(custom.ownedGradientIds ?? custom.availableGradients.map((g) => g.id));
  if (set.has(gradientId)) set.delete(gradientId);
  else set.add(gradientId);
  return Array.from(set);
}
