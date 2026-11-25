// Кастомизация: CRUD бейджей и градиентов.

import { useCallback, useState } from "react";
import { api } from "../api";
import type { Badge, Gradient } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  EmptyState,
  Field,
  Form,
  FormActions,
  IconButton,
  Input,
  Modal,
  PageHeader,
  PageState,
  Panel,
  Table,
  Tabs,
} from "../ui/components";
import { useToast, useConfirm } from "../ui/feedback";
import { IconPencil, IconPlus, IconTrash } from "../ui/icons";

type Tab = "badges" | "gradients";

export function CustomizationPage() {
  const [tab, setTab] = useState<Tab>("badges");
  return (
    <div className="page-stack">
      <PageHeader title="Кастомизация" />
      <Tabs
        tabs={[
          { key: "badges", label: "Бейджи" },
          { key: "gradients", label: "Градиенты" },
        ]}
        active={tab}
        onSelect={setTab}
      />
      {tab === "badges" ? <BadgesTab /> : <GradientsTab />}
    </div>
  );
}

function BadgesTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const fetcher = useCallback(() => api.listBadges(), []);
  const { data, loading, error, reload } = useAsyncData(fetcher);
  const [editing, setEditing] = useState<Badge | "new" | null>(null);

  async function remove(badge: Badge) {
    const ok = await confirm({
      title: `Удалить бейдж «${badge.label}»?`,
      body: "Он исчезнет у всех игроков.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteBadge(badge.id);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  return (
    <Panel
      flush
      title="Бейджи"
      description="Значки рядом с ником: эмодзи, подпись и цвет."
      actions={
        <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setEditing("new")}>
          Новый бейдж
        </Button>
      }
    >
      <PageState loading={loading} error={error} onRetry={reload}>
        <Table
          columns={[
            { key: "emoji", label: "", width: "48px" },
            { key: "label", label: "Название" },
            { key: "desc", label: "Описание" },
            { key: "color", label: "Цвет", width: "110px" },
            { key: "actions", label: "", width: "90px", align: "right" },
          ]}
          empty={
            <EmptyState
              title="Бейджей нет"
              body="Создайте первый бейдж, чтобы выдавать его игрокам."
              action={<Button onClick={() => setEditing("new")}>Новый бейдж</Button>}
            />
          }
          rows={(data ?? []).map((badge) => ({
            key: String(badge.id),
            cells: {
              emoji: <span style={{ fontSize: "var(--fs-lg)" }}>{badge.emoji}</span>,
              label: badge.label,
              desc: <span className="muted ellipsis" title={badge.description}>{badge.description}</span>,
              color: <span className="row mono"><span className="gradient-dot" style={{ background: badge.color }} />{badge.color}</span>,
              actions: (
                <span className="row" style={{ justifyContent: "flex-end" }}>
                  <IconButton label="Изменить" size="sm" onClick={() => setEditing(badge)}>
                    <IconPencil size={14} />
                  </IconButton>
                  <IconButton label="Удалить" size="sm" onClick={() => void remove(badge)}>
                    <IconTrash size={14} />
                  </IconButton>
                </span>
              ),
            },
          }))}
        />
      </PageState>

      {editing && (
        <BadgeModal
          badge={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </Panel>
  );
}

function BadgeModal({
  badge,
  onClose,
  onSaved,
}: {
  badge: Badge | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [emoji, setEmoji] = useState(badge?.emoji ?? "");
  const [label, setLabel] = useState(badge?.label ?? "");
  const [description, setDescription] = useState(badge?.description ?? "");
  const [color, setColor] = useState(badge?.color ?? "#f0c979");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (badge) await api.updateBadge(badge.id, emoji, label, description, color);
      else await api.createBadge(emoji, label, description, color);
      toast.success(badge ? "Бейдж обновлён" : "Бейдж создан");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={badge ? "Изменить бейдж" : "Новый бейдж"} onClose={onClose}>
      <form onSubmit={submit}>
        <Form>
          <Field label="Эмодзи">
            <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} required autoFocus />
          </Field>
          <Field label="Название">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          <Field label="Описание" wide>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Цвет">
            <div className="row">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer" }}
              />
              <Input value={color} onChange={(e) => setColor(e.target.value)} className="mono" />
            </div>
          </Field>
          <FormActions>
            <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" busy={busy}>Сохранить</Button>
          </FormActions>
        </Form>
      </form>
    </Modal>
  );
}

function GradientsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const fetcher = useCallback(() => api.listGradients(), []);
  const { data, loading, error, reload } = useAsyncData(fetcher);
  const [editing, setEditing] = useState<Gradient | "new" | null>(null);

  async function remove(gradient: Gradient) {
    const ok = await confirm({
      title: `Удалить градиент «${gradient.label}»?`,
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteGradient(gradient.id);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  return (
    <Panel
      flush
      title="Градиенты ника"
      description="Двухцветные градиенты, накладываемые на ник игрока."
      actions={
        <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setEditing("new")}>
          Новый градиент
        </Button>
      }
    >
      <PageState loading={loading} error={error} onRetry={reload}>
        <Table
          columns={[
            { key: "preview", label: "", width: "120px" },
            { key: "label", label: "Название" },
            { key: "desc", label: "Описание" },
            { key: "colors", label: "Цвета", width: "220px" },
            { key: "actions", label: "", width: "90px", align: "right" },
          ]}
          empty={
            <EmptyState
              title="Градиентов нет"
              body="Создайте первый градиент для ников игроков."
              action={<Button onClick={() => setEditing("new")}>Новый градиент</Button>}
            />
          }
          rows={(data ?? []).map((gradient) => ({
            key: String(gradient.id),
            cells: {
              preview: (
                <span
                  style={{
                    display: "block",
                    height: 10,
                    borderRadius: 5,
                    background: `linear-gradient(90deg, ${gradient.colorStart}, ${gradient.colorEnd})`,
                  }}
                />
              ),
              label: gradient.label,
              desc: <span className="muted ellipsis" title={gradient.description}>{gradient.description}</span>,
              colors: <span className="mono faint">{gradient.colorStart} → {gradient.colorEnd}</span>,
              actions: (
                <span className="row" style={{ justifyContent: "flex-end" }}>
                  <IconButton label="Изменить" size="sm" onClick={() => setEditing(gradient)}>
                    <IconPencil size={14} />
                  </IconButton>
                  <IconButton label="Удалить" size="sm" onClick={() => void remove(gradient)}>
                    <IconTrash size={14} />
                  </IconButton>
                </span>
              ),
            },
          }))}
        />
      </PageState>

      {editing && (
        <GradientModal
          gradient={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </Panel>
  );
}

function GradientModal({
  gradient,
  onClose,
  onSaved,
}: {
  gradient: Gradient | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(gradient?.label ?? "");
  const [description, setDescription] = useState(gradient?.description ?? "");
  const [start, setStart] = useState(gradient?.colorStart ?? "#f0c979");
  const [end, setEnd] = useState(gradient?.colorEnd ?? "#8fb7e8");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (gradient) await api.updateGradient(gradient.id, label, description, start, end);
      else await api.createGradient(label, description, start, end);
      toast.success(gradient ? "Градиент обновлён" : "Градиент создан");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={gradient ? "Изменить градиент" : "Новый градиент"} onClose={onClose}>
      <form onSubmit={submit}>
        <Form>
          <Field label="Название">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus />
          </Field>
          <Field label="Описание">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Начальный цвет">
            <div className="row">
              <input type="color" value={start} onChange={(e) => setStart(e.target.value)}
                style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer" }} />
              <Input value={start} onChange={(e) => setStart(e.target.value)} className="mono" />
            </div>
          </Field>
          <Field label="Конечный цвет">
            <div className="row">
              <input type="color" value={end} onChange={(e) => setEnd(e.target.value)}
                style={{ width: 36, height: 36, border: "none", background: "none", cursor: "pointer" }} />
              <Input value={end} onChange={(e) => setEnd(e.target.value)} className="mono" />
            </div>
          </Field>
          <div className="field-wide">
            <span
              style={{
                display: "block",
                height: 14,
                borderRadius: 7,
                background: `linear-gradient(90deg, ${start}, ${end})`,
              }}
            />
          </div>
          <FormActions>
            <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" busy={busy}>Сохранить</Button>
          </FormActions>
        </Form>
      </form>
    </Modal>
  );
}

export default CustomizationPage;
