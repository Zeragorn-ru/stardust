import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ExternalModAllowlistEntry, ExternalModBlockRule } from "../types";
import { useToast } from "../ui/feedback";

export function ExternalModsView() {
  const toast = useToast();
  const [allowlist, setAllowlist] = useState<ExternalModAllowlistEntry[]>([]);
  const [rules, setRules] = useState<ExternalModBlockRule[]>([]);
  const [sha256, setSha256] = useState("");
  const [nameSubstring, setNameSubstring] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [allowlistResponse, rulesResponse] = await Promise.all([
        api.listExternalModAllowlist(),
        api.listExternalModBlockRules(),
      ]);
      setAllowlist(allowlistResponse.entries);
      setRules(rulesResponse.rules);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось загрузить правила модов");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function addRule(event: React.FormEvent) {
    event.preventDefault();
    const hash = sha256.trim().toLowerCase();
    const substring = nameSubstring.trim();
    if (!hash && !substring) return;
    setSaving(true);
    try {
      await api.addExternalModBlockRule({
        ...(hash ? { sha256: hash } : {}),
        ...(substring ? { nameSubstring: substring } : {}),
      });
      setSha256("");
      setNameSubstring("");
      toast.success("Правило блокировки добавлено");
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось добавить правило");
    } finally {
      setSaving(false);
    }
  }

  async function removeAllowlistEntry(entry: ExternalModAllowlistEntry) {
    try {
      await api.removeExternalModAllowlist(entry.id);
      setAllowlist((current) => current.filter((item) => item.id !== entry.id));
      toast.success(`Разрешение для ${entry.jarName} удалено`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось удалить разрешение");
    }
  }

  async function removeRule(rule: ExternalModBlockRule) {
    try {
      await api.removeExternalModBlockRule(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      toast.success("Правило блокировки удалено");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось удалить правило");
    }
  }

  async function blockHash(entry: ExternalModAllowlistEntry) {
    try {
      await api.addExternalModBlockRule({ sha256: entry.sha256 });
      toast.success(`Мод ${entry.jarName} заблокирован по хешу`);
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Не удалось заблокировать мод");
    }
  }

  return (
    <div className="view external-mods-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Безопасность клиента</span>
          <h1>Внешние моды</h1>
          <p className="muted">Разрешённые моды и правила удаления до запуска Minecraft.</p>
        </div>
      </header>

      <section className="panel panel-flat external-mods-warning">
        <strong>Правила применяются до запуска игры</strong>
        <span className="muted">Совпавшие JAR-файлы будут удалены из папки mods. Блокировка по хешу имеет приоритет над разрешением.</span>
      </section>

      <section className="panel panel-flat">
        <div className="section-head">
          <div>
            <span className="eyebrow">Block rules</span>
            <h2>Заблокировать мод</h2>
          </div>
        </div>
        <form className="external-mod-rule-form" onSubmit={addRule}>
          <label>
            SHA-256
            <input value={sha256} onChange={(event) => setSha256(event.target.value)} placeholder="64 символа хеша" inputMode="text" />
          </label>
          <label>
            Слово в имени JAR
            <input value={nameSubstring} onChange={(event) => setNameSubstring(event.target.value)} placeholder="например, voxy" />
          </label>
          <button className="primary" type="submit" disabled={saving || (!sha256.trim() && !nameSubstring.trim())}>
            {saving ? "Добавление…" : "Заблокировать"}
          </button>
        </form>
      </section>

      <div className="external-mods-columns">
        <section className="panel panel-flat">
          <div className="section-head">
            <div><span className="eyebrow">Allowlist</span><h2>Разрешённые моды</h2></div>
            <span className="badge">{allowlist.length}</span>
          </div>
          {loading ? <p className="muted">Загрузка…</p> : allowlist.length === 0 ? <p className="muted">Разрешённых модов пока нет.</p> : (
            <div className="external-mod-list">
              {allowlist.map((entry) => (
                <article className="external-mod-row" key={entry.id}>
                  <div className="external-mod-row__main">
                    <strong>{entry.jarName}</strong>
                    <small>{entry.modId}</small>
                    <code>{entry.sha256}</code>
                  </div>
                  <div className="external-mod-row__actions">
                    <button className="secondary" type="button" onClick={() => void blockHash(entry)}>Заблокировать hash</button>
                    <button className="danger" type="button" onClick={() => void removeAllowlistEntry(entry)}>Убрать</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel panel-flat">
          <div className="section-head">
            <div><span className="eyebrow">Deny rules</span><h2>Правила блокировки</h2></div>
            <span className="badge">{rules.length}</span>
          </div>
          {loading ? <p className="muted">Загрузка…</p> : rules.length === 0 ? <p className="muted">Правил блокировки пока нет.</p> : (
            <div className="external-mod-list">
              {rules.map((rule) => (
                <article className="external-mod-row" key={rule.id}>
                  <div className="external-mod-row__main">
                    {rule.sha256 && <code>{rule.sha256}</code>}
                    {rule.nameSubstring && <strong>Имя содержит: {rule.nameSubstring}</strong>}
                  </div>
                  <button className="danger" type="button" onClick={() => void removeRule(rule)}>Удалить</button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
