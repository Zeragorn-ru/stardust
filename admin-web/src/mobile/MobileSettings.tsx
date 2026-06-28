// Настройки (мобильный): переиспользуем десктопный экран, mobile.css
// раскладывает карточки в одну колонку. Экран сам рисует заголовок, поэтому
// добавляем только тонкую полоску с выходом и переключатель на полную версию.

import { SettingsView } from "../views/SettingsView";
import { useAuth } from "../app/useAuth";
import { switchViewHref } from "../app/viewMode";
import { IconLogout, IconMonitor } from "../ui/icons";

export function MobileSettings() {
  const { logout } = useAuth();
  return (
    <div className="m-screen m-screen-reuse">
      <div className="m-top-bar">
        <a className="m-top-link" href={switchViewHref("desktop")}>
          <IconMonitor size={16} /> Полная версия
        </a>
        <button className="m-logout-bar" onClick={logout}>
          <IconLogout size={16} /> Выйти
        </button>
      </div>
      <SettingsView />
    </div>
  );
}
