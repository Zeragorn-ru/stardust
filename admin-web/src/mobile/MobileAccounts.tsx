// Аккаунты (мобильный): переиспользуем десктопный экран — он уже размечен с
// data-label на ячейках, а mobile.css превращает таблицу в карточки. Экран сам
// рисует заголовок и поиск, поэтому добавляем только тонкую полоску с выходом.

import { AccountsView } from "../views/AccountsView";
import { useAuth } from "../app/useAuth";
import { IconLogout } from "../ui/icons";

export function MobileAccounts() {
  const { logout } = useAuth();
  return (
    <div className="m-screen m-screen-reuse">
      <button className="m-logout-bar" onClick={logout}>
        <IconLogout size={16} /> Выйти
      </button>
      <AccountsView />
    </div>
  );
}
