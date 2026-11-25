import mapIconRaw from "../assets/icons/map.svg?raw";
import membersIconRaw from "../assets/icons/members.svg?raw";
import settingsIconRaw from "../assets/icons/settings.svg?raw";

/**
 * Иконки-кнопки на карточках главного экрана (карта, игроки, шестерёнка).
 * SVG вставляются инлайн (`?raw`), а не через <img>: у img своя изоляция
 * и currentColor из кнопки внутрь не протекает — иконки красились бы
 * зашитым в файл цветом. Инлайн-SVG красится от CSS: цвет задаёт кнопка.
 */
export function SvgIcon({ src, alt }: { src: string; alt: string }) {
  return (
    <span
      className="svg-icon"
      role="img"
      aria-label={alt}
      dangerouslySetInnerHTML={{ __html: src }}
    />
  );
}

export const ICONS = {
  map: mapIconRaw,
  members: membersIconRaw,
  settings: settingsIconRaw,
};
