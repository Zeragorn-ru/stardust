import { ApiError, api, type SftpHostKeyChanged, type SftpHostKeyConfirmation } from "../api";
import { useConfirm } from "./feedback";

function validChange(value: unknown): value is SftpHostKeyChanged {
  if (!value || typeof value !== "object") return false;
  const change = value as Record<string, unknown>;
  return typeof change.host === "string" && change.host.length > 0 &&
    typeof change.fingerprint === "string" && change.fingerprint.length > 0 &&
    typeof change.knownFingerprint === "string" && change.knownFingerprint.length > 0;
}

export function useSftpHostKey() {
  const confirm = useConfirm();

  async function confirmHostKey(change: SftpHostKeyChanged): Promise<SftpHostKeyConfirmation | undefined> {
    if (!validChange(change)) return undefined;
    const ok = await confirm({
      title: "Ключ SFTP-сервера изменился",
      body: `ВНИМАНИЕ: возможно перехватывается соединение. Проверьте новый отпечаток независимо у администратора сервера. Хост: ${change.host}. Сохранённый отпечаток: ${change.knownFingerprint}. Новый отпечаток: ${change.fingerprint}. Подтверждайте только после проверки.`,
      confirmText: "Доверять этому ключу и повторить",
      danger: true,
    });
    return ok ? {
      confirmed_host: change.host,
      confirmed_fingerprint: change.fingerprint,
      known_fingerprint: change.knownFingerprint,
    } : undefined;
  }

  async function syncStats() {
    try {
      return await api.syncStats();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409 || !err.data || typeof err.data !== "object") throw err;
      const data = err.data as Record<string, unknown>;
      if (data.code !== "sftp_host_key_changed" || !validChange(data)) throw err;
      const confirmation = await confirmHostKey(data);
      return confirmation ? api.syncStats(confirmation) : undefined;
    }
  }

  return { confirmHostKey, syncStats };
}
