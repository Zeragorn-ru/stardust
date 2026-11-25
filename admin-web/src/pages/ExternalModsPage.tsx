// Внешние моды: allowlist и block-правила для защиты от сторонних JAR.

import { useCallback, useState } from "react";
import { api } from "../api";
import type { ExternalModAllowlistEntry, ExternalModBlockRule } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
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
} from "../ui/components";
import { useToast, useConfirm } from "../ui/feedback";
import { formatDateTime } from "../format";
import { IconPlus, IconTrash } from "../ui/icons";

export function ExternalModsPage() {
  const [addingAllow, setAddingAllow] = useState(false);
  const [addingBlock, setAddingBlock] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const allow = useAsyncData(useCallback(() => api.listExternalModAllowlist(), []), { pollMs: 30000 });
  const block = useAsyncData(useCallback(() => api.listExternalModBlockRules(), []), { pollMs: 30000 });

  async function removeAllow(entry: ExternalModAllowlistEntry) {
    const ok = await confirm({ title: `Убрать ${entry.jarName} из разрешённых?`, confirmText: "Убрать", danger: true });
    if (!ok) return;
    try {
      await api.removeExternalModAllowlist(entry.id);
      allow.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось убрать");
    }
  }

  async function removeBlock(rule: ExternalModBlockRule) {
    const ok = await confirm({ title: "Удалить правило блокировки?", confirmText: "Удалить", danger: true });
    if (!ok) return;
    try {
      await api.removeExternalModBlockRule(rule.id);
      block.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="Внешние моды" />

      <div className="page-columns">
        <Panel
          flush
          title="Разрешённые моды"
          description="Сторонние JAR, которые клиенту разрешено иметь (по SHA-256)."
          actions={
            <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setAddingAllow(true)}>
              Разрешить
            </Button>
          }
        >
          <PageState loading={allow.loading} error={allow.error} onRetry={allow.reload}>
            <Table
              columns={[
                { key: "mod", label: "Мод" },
                { key: "jar", label: "Файл" },
                { key: "sha", label: "SHA-256" },
                { key: "created", label: "Добавлен", width: "150px" },
                { key: "actions", label: "", width: "60px", align: "right" },
              ]}
              empty={
                <EmptyState
                  title="Список пуст"
                  body="Разрешайте моды из карточки события «внешние моды» в разделе «Логи»."
                />
              }
              rows={(allow.data?.entries ?? []).map((entry) => ({
                key: String(entry.id),
                cells: {
                  mod: entry.modId,
                  jar: <span className="ellipsis mono" title={entry.jarName}>{entry.jarName}</span>,
                  sha: <span className="mono faint ellipsis" title={entry.sha256}>{entry.sha256.slice(0, 12)}…</span>,
                  created: <span className="faint">{formatDateTime(entry.createdAt)}</span>,
                  actions: (
                    <IconButton label="Убрать" size="sm" onClick={() => void removeAllow(entry)}>
                      <IconTrash size={14} />
                    </IconButton>
                  ),
                },
              }))}
            />
          </PageState>
        </Panel>

        <Panel
          flush
          title="Правила блокировки"
          description="JAR, которые удаляются с клиента перед запуском."
          actions={
            <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setAddingBlock(true)}>
              Добавить правило
            </Button>
          }
        >
          <PageState loading={block.loading} error={block.error} onRetry={block.reload}>
            <Table
              columns={[
                { key: "match", label: "Условие" },
                { key: "value", label: "Значение" },
                { key: "created", label: "Создано", width: "150px" },
                { key: "actions", label: "", width: "60px", align: "right" },
              ]}
              empty={
                <EmptyState
                  title="Правил нет"
                  body="Правило блокирует JAR по точному SHA-256 или подстроке имени файла."
                />
              }
              rows={(block.data?.rules ?? []).map((rule) => ({
                key: String(rule.id),
                cells: {
                  match: rule.sha256 ? <Chip>по SHA-256</Chip> : <Chip>по имени</Chip>,
                  value: <span className="mono ellipsis" title={rule.sha256 ?? rule.nameSubstring}>{rule.sha256?.slice(0, 16) ?? rule.nameSubstring}</span>,
                  created: <span className="faint">{formatDateTime(rule.createdAt)}</span>,
                  actions: (
                    <IconButton label="Удалить" size="sm" onClick={() => void removeBlock(rule)}>
                      <IconTrash size={14} />
                    </IconButton>
                  ),
                },
              }))}
            />
          </PageState>
        </Panel>
      </div>

      {addingAllow && (
        <AllowModal
          onClose={() => setAddingAllow(false)}
          onSaved={() => {
            setAddingAllow(false);
            allow.reload();
          }}
        />
      )}
      {addingBlock && (
        <BlockModal
          onClose={() => setAddingBlock(false)}
          onSaved={() => {
            setAddingBlock(false);
            block.reload();
          }}
        />
      )}
    </div>
  );
}

function AllowModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [modId, setModId] = useState("");
  const [jarName, setJarName] = useState("");
  const [sha256, setSha256] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Разрешить внешний мод" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.allowExternalMod({ modId: modId.trim(), jarName: jarName.trim(), sha256: sha256.trim() });
            toast.success("Мод разрешён");
            onSaved();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form>
          <Field label="Mod ID">
            <Input value={modId} onChange={(e) => setModId(e.target.value)} className="mono" required autoFocus />
          </Field>
          <Field label="Имя JAR-файла">
            <Input value={jarName} onChange={(e) => setJarName(e.target.value)} required />
          </Field>
          <Field label="SHA-256 файла" wide>
            <Input value={sha256} onChange={(e) => setSha256(e.target.value)} className="mono" required />
          </Field>
          <FormActions>
            <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" busy={busy}>Разрешить</Button>
          </FormActions>
        </Form>
      </form>
    </Modal>
  );
}

function BlockModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"sha" | "name">("name");
  const [sha256, setSha256] = useState("");
  const [nameSubstring, setNameSubstring] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Правило блокировки" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.addExternalModBlockRule(
              mode === "sha" ? { sha256: sha256.trim() } : { nameSubstring: nameSubstring.trim() },
            );
            toast.success("Правило добавлено");
            onSaved();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form>
          <Field label="Условие" wide>
            <div className="row">
              <Button type="button" variant={mode === "name" ? "primary" : "secondary"} onClick={() => setMode("name")}>
                По имени файла
              </Button>
              <Button type="button" variant={mode === "sha" ? "primary" : "secondary"} onClick={() => setMode("sha")}>
                По SHA-256
              </Button>
            </div>
          </Field>
          {mode === "sha" ? (
            <Field label="SHA-256" wide>
              <Input value={sha256} onChange={(e) => setSha256(e.target.value)} className="mono" required autoFocus />
            </Field>
          ) : (
            <Field label="Подстрока имени файла" hint="Блокируются все JAR, содержащие эту подстроку" wide>
              <Input value={nameSubstring} onChange={(e) => setNameSubstring(e.target.value)} required autoFocus />
            </Field>
          )}
          <FormActions>
            <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" busy={busy}>Добавить</Button>
          </FormActions>
        </Form>
      </form>
    </Modal>
  );
}

export default ExternalModsPage;
