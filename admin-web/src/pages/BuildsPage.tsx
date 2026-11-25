// Сборки: список, создание, клонирование, удаление, активация.
// Маршрут-осведомлённая страница: /builds — список, /builds/:id — детали,
// /builds/new — форма создания.

import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { CreateBuildInput } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
  EllipsisCell,
  EmptyState,
  Field,
  Form,
  FormActions,
  Input,
  Modal,
  PageHeader,
  PageState,
  Panel,
  Select,
  Table,
} from "../ui/components";
import { useToast } from "../ui/feedback";
import { BuildDetail } from "./builds/BuildDetail";
import { IconPlus } from "../ui/icons";

export function BuildsPage() {
  const { id, action } = useParams();
  const navigate = useNavigate();

  if (action === "new") {
    return <NewBuild onCreated={(created) => navigate(`/builds/${created.id}`, { replace: true })} />;
  }
  if (id != null && /^\d+$/.test(id)) {
    return <BuildDetail id={Number(id)} />;
  }
  return <BuildsList />;
}

function BuildsList() {
  const navigate = useNavigate();
  const fetcher = useCallback(() => api.listBuilds(), []);
  const { data: builds, loading, error, reload } = useAsyncData(fetcher);
  const [creating, setCreating] = useState(false);

  return (
    <div className="page-stack">
      <PageHeader
        title="Сборки"
        actions={
          <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => setCreating(true)}>
            Новая сборка
          </Button>
        }
      />

      <PageState loading={loading} error={error} onRetry={reload}>
        <Panel flush>
          <Table
            columns={[
              { key: "name", label: "Название" },
              { key: "version", label: "Версия" },
              { key: "loader", label: "Загрузчик" },
              { key: "mc", label: "Minecraft" },
              { key: "status", label: "Статус" },
            ]}
            empty={
              <EmptyState
                title="Сборок ещё нет"
                body="Создайте первую сборку и загрузите в неё файлы."
                action={
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Новая сборка
                  </Button>
                }
              />
            }
            rows={(builds ?? []).map((build) => ({
              key: String(build.id),
              clickable: true,
              onClick: () => navigate(`/builds/${build.id}`),
              cells: {
                name: <EllipsisCell text={build.name} />,
                version: <span className="mono">{build.version}</span>,
                loader: build.loaderKind,
                mc: <span className="mono">{build.mcVersion}</span>,
                status: build.isActive ? <Chip tone="accent">активная</Chip> : <Chip>неактивная</Chip>,
              },
            }))}
          />
        </Panel>
      </PageState>

      {/* Быстрые действия: клон, удаление */}
      {builds && builds.length > 0 && (
        <Panel
          title="Действия сборок"
          description="Используйте таблицу выше, чтобы выбрать сборку"
        >
          <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
            Нажмите на строку сборки в таблице, чтобы открыть её детали. Там вы сможете загружать файлы, управлять профилями, устанавливать моды и выполнять операции с сборкой.
          </p>
        </Panel>
      )}

      {creating && (
        <BuildForm
          onClose={() => setCreating(false)}
          onSaved={(created) => {
            setCreating(false);
            navigate(`/builds/${created.id}`);
          }}
        />
      )}
    </div>
  );
}

function NewBuild({ onCreated }: { onCreated: (created: { id: number }) => void }) {
  return (
    <div className="page-stack">
      <PageHeader title="Новая сборка" />
      <Panel>
        <BuildFormInner onSaved={onCreated} onCancel={() => history.back()} />
      </Panel>
    </div>
  );
}

function BuildForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (created: { id: number }) => void;
}) {
  return (
    <Modal title="Новая сборка" onClose={onClose}>
      <BuildFormInner onSaved={onSaved} onCancel={onClose} />
    </Modal>
  );
}

function BuildFormInner({
  onSaved,
  onCancel,
}: {
  onSaved: (created: { id: number }) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [input, setInput] = useState<CreateBuildInput>({
    name: "",
    version: "",
    loaderKind: "neoforge",
    mcVersion: "",
    loaderVersion: "",
  });
  const [busy, setBusy] = useState(false);

  function set<K extends keyof CreateBuildInput>(key: K, value: CreateBuildInput[K]) {
    setInput((cur) => ({ ...cur, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api.createBuild(input);
      toast.success("Сборка создана");
      onSaved(created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось создать сборку");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Form>
        <Field label="Название">
          <Input value={input.name} onChange={(e) => set("name", e.target.value)} required autoFocus />
        </Field>
        <Field label="Версия сборки">
          <Input value={input.version} onChange={(e) => set("version", e.target.value)} required />
        </Field>
        <Field label="Загрузчик">
          <Select value={input.loaderKind} onChange={(e) => set("loaderKind", e.target.value)}>
            <option value="neoforge">NeoForge</option>
            <option value="forge">Forge</option>
            <option value="fabric">Fabric</option>
            <option value="quilt">Quilt</option>
          </Select>
        </Field>
        <Field label="Версия Minecraft">
          <Input value={input.mcVersion} onChange={(e) => set("mcVersion", e.target.value)} required placeholder="1.21.1" />
        </Field>
        <Field label="Версия загрузчика">
          <Input value={input.loaderVersion} onChange={(e) => set("loaderVersion", e.target.value)} required />
        </Field>
        <FormActions>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Создать
          </Button>
        </FormActions>
      </Form>
    </form>
  );
}

// Нужен в двух местах (модалка и страница) — реэкспорт.
export { BuildForm };

export default BuildsPage;
