// Настройки (мобильный): переиспользуем десктопный экран, mobile.css
// раскладывает карточки в одну колонку. Общие действия живут в MobileApp shell.

import { SettingsView } from "../views/SettingsView";

export function MobileSettings() {
  return (
    <div className="m-screen m-screen-reuse">
      <SettingsView />
    </div>
  );
}
