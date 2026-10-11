// Сезоны (мобильный): переиспользуем десктопный экран — он размечен
// data-label на ячейках таблицы, а mobile.css превращает таблицу в карточки.
// Экран сам рисует оба раздела (сезоны + релизы лаунчера), поэтому здесь
// только мобильная обёртка с отступами.

import { SeasonsView } from "../views/SeasonsView";

export function MobileSeasons() {
  return (
    <div className="m-screen m-screen-reuse m-screen-seasons">
      <SeasonsView mobile />
    </div>
  );
}
