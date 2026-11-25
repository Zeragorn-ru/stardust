// Единая таблица навигации: имена, иконки, маршруты и группы для сайдбара
// и топбара. Один источник — рассинхрон невозможен.

import type { ReactNode } from "react";
import {
  IconArchive,
  IconBookOpen,
  IconBox,
  IconChart,
  IconDownload,
  IconMegaphone,
  IconSettings,
  IconShield,
  IconStar,
  IconTerminal,
  IconUsers,
} from "./icons";

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
  | "seasons"
  | "releases";

export interface NavItem {
  tab: NavTab;
  label: string;
  description: string;
  route: string;
  group: string;
  icon: (size: number) => ReactNode;
}

export const NAV_GROUPS = ["Обзор", "Платформа", "Игроки", "Контент", "Мониторинг"];

export const NAV: NavItem[] = [
  {
    tab: "overview",
    label: "Обзор",
    description: "Ключевые статусы платформы и последние события.",
    route: "/overview",
    group: "Обзор",
    icon: (size) => <IconChart size={size} />,
  },
  {
    tab: "builds",
    label: "Сборки",
    description: "Релизы, содержимое сборок и проверка артефактов.",
    route: "/builds",
    group: "Платформа",
    icon: (size) => <IconBox size={size} />,
  },
  {
    tab: "releases",
    label: "Релизы",
    description: "Каналы апдейтера, CI-сборки и публикация релизов.",
    route: "/releases",
    group: "Платформа",
    icon: (size) => <IconDownload size={size} />,
  },
  {
    tab: "settings",
    label: "Настройки",
    description: "Telegram, SFTP, бэкапы и интеграции.",
    route: "/settings",
    group: "Платформа",
    icon: (size) => <IconSettings size={size} />,
  },
  {
    tab: "accounts",
    label: "Аккаунты",
    description: "Поиск, модерация, Telegram-связка и скины.",
    route: "/accounts",
    group: "Игроки",
    icon: (size) => <IconUsers size={size} />,
  },
  {
    tab: "customization",
    label: "Кастомизация",
    description: "Бейджи и градиенты ников.",
    route: "/customization",
    group: "Игроки",
    icon: (size) => <IconStar size={size} />,
  },
  {
    tab: "seasons",
    label: "Сезоны",
    description: "Архив статистики и завершение сезона.",
    route: "/seasons",
    group: "Игроки",
    icon: (size) => <IconArchive size={size} />,
  },
  {
    tab: "news",
    label: "Новости",
    description: "Публикации для лаунчера.",
    route: "/news",
    group: "Контент",
    icon: (size) => <IconMegaphone size={size} />,
  },
  {
    tab: "guides",
    label: "Гайды",
    description: "База знаний для игроков.",
    route: "/guides",
    group: "Контент",
    icon: (size) => <IconBookOpen size={size} />,
  },
  {
    tab: "logs",
    label: "Логи",
    description: "События сервера и AI-анализ крашей.",
    route: "/logs",
    group: "Мониторинг",
    icon: (size) => <IconTerminal size={size} />,
  },
  {
    tab: "mods",
    label: "Внешние моды",
    description: "Разрешённые моды и правила очистки клиента.",
    route: "/mods",
    group: "Мониторинг",
    icon: (size) => <IconShield size={size} />,
  },
];

export function navItem(tab: string): NavItem {
  return NAV.find((item) => item.tab === tab) ?? NAV[0];
}

export function subrouteTitle(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [, sub] = segments;
  if (sub === "new") return "Новый";
  return /^\d+$/.test(sub) ? "Детали" : null;
}
