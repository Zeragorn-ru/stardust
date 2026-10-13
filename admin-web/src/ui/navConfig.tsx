// Единая таблица навигации админки: один источник имён, иконок, маршрутов
// и групп для десктопного сайдбара (DesktopApp) и мобильного drawer
// (MobileApp). Раньше имена одних и тех же маршрутов расходились в четырёх
// местах («Интеграции»/«Инфраструктура»/«Система», «Косметика»/
// «Кастомизация ника»/«Студия кастомизации» и т.д.) — теперь рассинхрон
// невозможен по построению.
//
// Канонические имена маршрутов (план 2.1): /settings — «Настройки»,
// /customization — «Кастомизация», /accounts — «Аккаунты», /builds — «Сборки».

import type { ReactNode } from "react";
import {
  IconArchive,
  IconBookOpen,
  IconBox,
  IconChart,
  IconMegaphone,
  IconSettings,
  IconShield,
  IconStar,
  IconTerminal,
  IconUsers,
} from "./icons";

/** Ключ навигации: сегмент первого уровня URL (десктоп) и вкладка (mobile). */
export type NavTab =
  | "overview"
  | "builds"
  | "settings"
  | "accounts"
  | "customization"
  | "news"
  | "guides"
  | "logs"
  | "mods"
  | "seasons";

export interface NavItem {
  /** Ключ вкладки; на десктопе совпадает с сегментом маршрута. */
  tab: NavTab;
  /** Каноническое имя — одинаковое в sidebar, topbar и drawer. */
  label: string;
  /** Подпись для топбара/шапки (одно предложение о разделе). */
  description: string;
  /** Маршрут десктопного шелла. */
  route: string;
  /** Группа навигации: Обзор · Платформа · Игроки · Контент · Мониторинг. */
  group: string;
  /** Иконка пункта; колбэки получают размер под шелл. */
  icon: (size: number) => ReactNode;
}

/** Порядок групп на экране. */
export const NAV_GROUPS: string[] = [
  "Обзор",
  "Платформа",
  "Игроки",
  "Контент",
  "Мониторинг",
];

export const NAV: NavItem[] = [
  {
    tab: "overview",
    label: "Обзор",
    description: "Ключевые статусы платформы и быстрые операционные действия.",
    route: "/overview",
    group: "Обзор",
    icon: (size) => <IconChart size={size} />,
  },
  {
    tab: "builds",
    label: "Сборки",
    description: "Релизы, содержимое сборок и проверка клиентских артефактов.",
    route: "/builds",
    group: "Платформа",
    icon: (size) => <IconBox size={size} />,
  },
  {
    tab: "settings",
    label: "Настройки",
    description: "Telegram, SFTP и backend-конфигурация без потери контекста.",
    route: "/settings",
    group: "Платформа",
    icon: (size) => <IconSettings size={size} />,
  },
  {
    tab: "accounts",
    label: "Аккаунты",
    description: "Поиск, модерация, Telegram-связка и статусы аккаунтов.",
    route: "/accounts",
    group: "Игроки",
    icon: (size) => <IconUsers size={size} />,
  },
  {
    tab: "customization",
    label: "Кастомизация",
    description: "Бейджи, градиенты и элементы идентичности игроков.",
    route: "/customization",
    group: "Игроки",
    icon: (size) => <IconStar size={size} />,
  },
  {
    tab: "news",
    label: "Новости",
    description: "Публикации и закреплённые объявления для лаунчера.",
    route: "/news",
    group: "Контент",
    // Иконка новостей отличается от Кастомизации (план 2.2: Megaphone).
    icon: (size) => <IconMegaphone size={size} />,
  },
  {
    tab: "guides",
    label: "Гайды",
    description: "Публичная база знаний для игроков и новичков.",
    route: "/guides",
    group: "Контент",
    // Гайды и Логи раньше делили IconFile (план 2.2: BookOpen/Terminal).
    icon: (size) => <IconBookOpen size={size} />,
  },
  {
    tab: "logs",
    label: "Логи",
    description: "Запуски, входы, выходы и аварийные завершения Minecraft.",
    route: "/logs",
    group: "Мониторинг",
    icon: (size) => <IconTerminal size={size} />,
  },
  {
    tab: "mods",
    label: "Внешние моды",
    description: "Разрешённые моды и правила очистки перед запуском клиента.",
    route: "/mods",
    group: "Мониторинг",
    // Внешние моды отличны от Сборок (план 2.2: IconShield).
    icon: (size) => <IconShield size={size} />,
  },
  {
    tab: "seasons",
    label: "Сезоны",
    description:
      "Архив статистики игроков по сезонам и выкат релизов лаунчера в стабильный канал.",
    route: "/seasons",
    group: "Мониторинг",
    icon: (size) => <IconArchive size={size} />,
  },
];

/** Найти пункт по ключу вкладки (сегменту маршрута). */
export function navItem(tab: string): NavItem {
  return NAV.find((item) => item.tab === tab) ?? NAV[0];
}

/** Ключи вкладок, которые понимает мобильный шелл (query-параметр ?tab=). */
export function isNavTab(value: string): value is NavTab {
  return NAV.some((item) => item.tab === value);
}

/**
 * Заголовок подмаршрута для топбара десктопа (план 2.5).
 *
 * `pathname` вида `/builds/12`, `/builds/new`, `/news/3`, `/guides/new`.
 * Возвращает null, если маршрут — индекс раздела (заголовок берётся из NAV).
 * Имя сборки/поста топбар подтягивает сам из данных экрана, здесь —
 * универсальная подпись на случай, пока данные грузятся.
 */
export function subrouteTitle(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [section, sub] = segments;
  switch (section) {
    case "builds":
      if (sub === "new") return "Новая сборка";
      return /^[\w-]+$/.test(sub) ? "Детали сборки" : null;
    case "news":
      if (sub === "new") return "Новая новость";
      return /^[\w-]+$/.test(sub) ? "Редактирование новости" : null;
    case "guides":
      if (sub === "new") return "Новый гайд";
      return /^[\w-]+$/.test(sub) ? "Редактирование гайда" : null;
    default:
      return null;
  }
}
