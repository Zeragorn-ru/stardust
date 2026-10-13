// Экран «Внешние моды»: allowlist разрешённых хешей и правила блокировки,
// по которым лаунчер удаляет совпавшие JAR-файлы из папки mods до запуска
// игры. Опасные действия — только через useConfirm, результаты действий —
// тостами.
//
// Форма allow (план 3.7): allowlist пополняется не только из модалки
// деталей лога — хеш можно вписать прямо здесь. Валидация
// /^[a-f0-9]{64}$/i — inline, до сабмита; пустое состояние allowlist
// ссылается на /logs?type=external_mods, откуда берутся хеши.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import type { ExternalModAllowlistEntry, ExternalModBlockRule } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { Field, FieldInput, fieldTouchedError } from "../ui/Field";
import { LoadPanel } from "../ui/EmptyState";

// Валидация хеша — та же, что на бэкенде (64 hex-символа).
const SHA_RE = /^[a-f0-9]{64}$/i;

// Короткое человекочитаемое описание правила — для диалога подтверждения и
// aria-label кнопки удаления. Хеш усекаем, чтобы не тащить 64 символа в подпись.
function describeRule(rule: ExternalModBlockRule): string {
  const parts: string[] = [];
  if (rule.sha256) parts.push(`хеш ${rule.sha256.slice(0, 12)}…`);
  if (rule.nameSubstring) parts.push(`имя содержит «${rule.nameSubstring}»`);
  return parts.join(" или ");
}

export function ExternalModsView({ mobile = false }: { mobile?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [allowlist, setAllowlist] = useState<ExternalModAllowlistEntry[]>([]);
  const [rules, setRules] = useState<ExternalModBlockRule[]>([]);
  const [sha256, setSha256] = useState("");
  const [nameSubstring, setNameSubstring] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Поля формы allow: хеш + подпись (modId/jarName), по которой запись
  // опознают в списке и в отчётах лаунчера.
  const [allowHash, setAllowHash] = useState("");
  const [allowName, setAllowName] = useState("");
  const [allowTouched, setAllowTouched] = useState({ hash: false, name: false });
  const [allowing, setAllowing] = useState(false);

  const load = useCallback(async () => {
    // Флаг ставим и на повторных вызовах, чтобы «Повторить» давал видимый
    // отклик (спиннер), а не «тихий» фоновый запрос.
    setLoading(true);
    setError(null);
    try {
      const [allowlistResponse, rulesResponse] = await Promise.all([
        api.listExternalModAllowlist(),
        api.listExternalModBlockRules(),
      ]);
      setAllowlist(allowlistResponse.entries);
      setRules(rulesResponse.rules);
    } catch (reason) {
      // Ошибку загрузки показываем панелью с кнопкой «Повторить» (как в
      // журнале), а не только тостом: без списков экран бесполезен.
      setError(reason instanceof ApiError ? reason.message : "Не удалось загрузить правила модов");
    } finally {
      setLoading(false);
    }
  }, []);

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
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : "Не удалось добавить правило");
    } finally {
      setSaving(false);
    }
  }

  async function addAllow(event: React.FormEvent) {
    event.preventDefault();
    const hash = allowHash.trim().toLowerCase();
    const name = allowName.trim();
    if (!SHA_RE.test(hash) || !name) return;
    setAllowing(true);
    try {
      await api.allowExternalMod({ modId: name, jarName: name, sha256: hash });
      setAllowHash("");
      setAllowName("");
      setAllowTouched({ hash: false, name: false });
      toast.success(`Мод «${name}» разрешён`);
      await load();
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : "Не удалось разрешить мод");
    } finally {
      setAllowing(false);
    }
  }

  async function removeAllowlistEntry(entry: ExternalModAllowlistEntry) {
    const ok = await confirm({
      title: `Убрать разрешение для «${entry.jarName}»?`,
      body: "Файл с диска не удаляется, но при следующем запуске мод снова попадёт в отчёт о сторонних модах.",
      confirmText: "Убрать",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeExternalModAllowlist(entry.id);
      setAllowlist((current) => current.filter((item) => item.id !== entry.id));
      toast.success(`Разрешение для ${entry.jarName} удалено`);
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : "Не удалось удалить разрешение");
    }
  }

  async function removeRule(rule: ExternalModBlockRule) {
    const ok = await confirm({
      title: "Удалить правило блокировки?",
      body: `Правило: ${describeRule(rule)}. Совпавшие JAR-файлы больше не будут удаляться из папки mods до запуска игры.`,
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeExternalModBlockRule(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      toast.success("Правило блокировки удалено");
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : "Не удалось удалить правило");
    }
  }

  async function blockHash(entry: ExternalModAllowlistEntry) {
    const ok = await confirm({
      title: `Заблокировать «${entry.jarName}» по хешу?`,
      body: "JAR-файлы с этим хешем будут удаляться из папки mods у всех игроков до запуска игры. Блокировка имеет приоритет над разрешением.",
      confirmText: "Заблокировать",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.addExternalModBlockRule({ sha256: entry.sha256 });
      toast.success(`Мод ${entry.jarName} заблокирован по хешу`);
      await load();
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : "Не удалось заблокировать мод");
    }
  }

  const hashError = allowHash.trim() !== "" && !SHA_RE.test(allowHash.trim())
    ? "Хеш — 64 hex-символа (a–f, 0–9)"
    : null;

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
            <span className="eyebrow">Правила блокировки</span>
            <h2>Заблокировать мод</h2>
          </div>
        </div>
        <form className="external-mod-rule-form" onSubmit={addRule}>
          <Field label="SHA-256" inputId="block-sha">
            {(control) => (
              <FieldInput
                control={control}
                value={sha256}
                onChange={(event) => setSha256(event.target.value)}
                placeholder="64 символа хеша"
                inputMode="text"
              />
            )}
          </Field>
          <Field label="Слово в имени JAR" inputId="block-name">
            {(control) => (
              <FieldInput
                control={control}
                value={nameSubstring}
                onChange={(event) => setNameSubstring(event.target.value)}
                placeholder="например, voxy"
              />
            )}
          </Field>
          <button className="primary" type="submit" disabled={saving || (!sha256.trim() && !nameSubstring.trim())}>
            {saving ? "Добавление…" : "Заблокировать"}
          </button>
        </form>
      </section>

      {/* Форма allow (план 3.7): пополняет allowlist прямо с экрана, а не
          только из модалки деталей лога. Хеш валидируется inline. */}
      <section className="panel panel-flat">
        <div className="section-head">
          <div>
            <span className="eyebrow">Разрешить мод</span>
            <h2>Разрешить по SHA-256</h2>
          </div>
        </div>
        <form className="external-mod-rule-form" onSubmit={addAllow}>
          <Field
            label="SHA-256"
            inputId="allow-sha"
            error={fieldTouchedError(allowTouched.hash, hashError)}
          >
            {(control) => (
              <FieldInput
                control={control}
                value={allowHash}
                onChange={(event) => setAllowHash(event.target.value)}
                onBlur={() => setAllowTouched((t) => ({ ...t, hash: true }))}
                placeholder="хеш из отчёта о сторонних модах"
                inputMode="text"
              />
            )}
          </Field>
          <Field label="Имя мода / JAR" inputId="allow-name">
            {(control) => (
              <FieldInput
                control={control}
                value={allowName}
                onChange={(event) => setAllowName(event.target.value)}
                onBlur={() => setAllowTouched((t) => ({ ...t, name: true }))}
                placeholder="например, voxy"
              />
            )}
          </Field>
          <button className="primary" type="submit" disabled={allowing || !SHA_RE.test(allowHash.trim()) || !allowName.trim()}>
            {allowing ? "Добавление…" : "Разрешить"}
          </button>
        </form>
      </section>

      {error ? (
        <section className="panel panel-flat external-mod-empty">
          <strong>{error}</strong>
          <button className="secondary" type="button" onClick={() => void load()}>Повторить</button>
        </section>
      ) : (
        <div className="external-mods-columns">
          <section className="panel panel-flat">
            <div className="section-head">
              <div><span className="eyebrow">Разрешённые</span><h2>Разрешённые моды</h2></div>
              <span className="badge">{allowlist.length}</span>
            </div>
            {loading ? (
              <LoadPanel aria-label="Загрузка разрешённых модов" />
            ) : allowlist.length === 0 ? (
              <div className="external-mod-empty">
                <strong>Разрешённых модов пока нет</strong>
                <p className="muted">
                  {/* На десктопе — SPA-ссылка в роутер; на мобильном (без
                      роутера) — обычный переход на /m/?tab=logs&type=. */}
                  Хеш можно взять из событий{" "}
                  {mobile
                    ? <a href="/m/?tab=logs&type=external_mods">«Сторонние моды» в журнале</a>
                    : <Link to="/logs?type=external_mods">«Сторонние моды» в журнале</Link>}{" "}
                  — или вписать его в форму «Разрешить по SHA-256» выше.
                </p>
              </div>
            ) : (
              <div className="external-mod-list">
                {allowlist.map((entry) => (
                  <article className="external-mod-row" key={entry.id}>
                    <div className="external-mod-row__main">
                      <strong>{entry.jarName}</strong>
                      <small>{entry.modId}</small>
                      <code>{entry.sha256}</code>
                    </div>
                    <div className="external-mod-row__actions">
                      {/* aria-label с именем JAR: кнопки в разных строках
                          иначе одинаково звучат для скринридера. */}
                      <button className="secondary" type="button" aria-label={`Заблокировать hash мода ${entry.jarName}`} onClick={() => void blockHash(entry)}>Заблокировать hash</button>
                      <button className="danger" type="button" aria-label={`Убрать разрешение для ${entry.jarName}`} onClick={() => void removeAllowlistEntry(entry)}>Убрать</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel panel-flat">
            <div className="section-head">
              <div><span className="eyebrow">Запреты</span><h2>Правила блокировки</h2></div>
              <span className="badge">{rules.length}</span>
            </div>
            {loading ? (
              <LoadPanel aria-label="Загрузка правил блокировки" />
            ) : rules.length === 0 ? (
              <div className="external-mod-empty">
                <strong>Правил блокировки пока нет</strong>
                <p className="muted">Заполните форму «Заблокировать мод» выше: совпавшие JAR-файлы будут удаляться из папки mods до запуска игры.</p>
              </div>
            ) : (
              <div className="external-mod-list">
                {rules.map((rule) => (
                  <article className="external-mod-row" key={rule.id}>
                    <div className="external-mod-row__main">
                      {rule.sha256 && <code>{rule.sha256}</code>}
                      {rule.nameSubstring && <strong>Имя содержит: {rule.nameSubstring}</strong>}
                    </div>
                    <button className="danger" type="button" aria-label={`Удалить правило: ${describeRule(rule)}`} onClick={() => void removeRule(rule)}>Удалить</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
