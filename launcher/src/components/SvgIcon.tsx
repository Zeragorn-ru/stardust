import mapIconUrl from "../assets/icons/map.svg";
import membersIconUrl from "../assets/icons/members.svg";
import settingsIconUrl from "../assets/icons/settings.svg";

/**
 * Квадратные иконки-кнопки на карточках главного экрана (карта, список
 * игроков, шестерёнка сборки). SVG-файлы в src/assets/icons нормализованы
 * под currentColor: цвет наследуется от кнопки.
 */
export function SvgIcon({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} className="svg-icon" draggable={false} />;
}

export const ICONS = {
  map: mapIconUrl,
  members: membersIconUrl,
  settings: settingsIconUrl,
};
