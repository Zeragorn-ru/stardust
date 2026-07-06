// Аккаунты (мобильный): переиспользуем десктопный экран — он уже размечен с
// data-label на ячейках, а mobile.css превращает таблицу в карточки. Экран сам
// рисует заголовок и поиск, поэтому добавляем только тонкую полоску с выходом.

import { AccountsView } from "../views/AccountsView";

export function MobileAccounts() {
  return (
    <div className="m-screen m-screen-reuse">
      <AccountsView />
    </div>
  );
}
