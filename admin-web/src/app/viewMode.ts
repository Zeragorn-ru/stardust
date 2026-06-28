// Выбор интерфейса (десктоп `/` против мобильного `/m`).
//
// Телефоны, заходящие на десктопный URL, перекидываем на мобильный, и наоборот.
// При этом уважаем явный выбор пользователя: переход по ссылке `?view=desktop`
// или `?view=mobile` запоминается в localStorage и переопределяет
// автоопределение, чтобы человек не «застревал» в неподходящем интерфейсе.

type View = "desktop" | "mobile";

const STORE_KEY = "stardust-view";

function readOverride(): View | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === "desktop" || v === "mobile" ? v : null;
  } catch {
    return null;
  }
}

function writeOverride(v: View) {
  try {
    localStorage.setItem(STORE_KEY, v);
  } catch {
    // Приватный режим/заблокированное хранилище — просто не запоминаем.
  }
}

// Снимаем `?view=` из URL после того, как учли его, чтобы параметр не висел в
// адресе и не попадал в закладки/историю.
function consumeQueryOverride(): View | null {
  const params = new URLSearchParams(window.location.search);
  const v = params.get("view");
  if (v !== "desktop" && v !== "mobile") return null;
  writeOverride(v);
  params.delete("view");
  const qs = params.toString();
  const clean = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(null, "", clean);
  return v;
}

// Грубое, но практичное определение телефона: узкий вьюпорт ИЛИ мобильный UA.
// Планшеты намеренно остаются на десктопе — там раскладка уже адаптивная.
function isPhone(): boolean {
  const narrow = window.matchMedia("(max-width: 760px)").matches;
  const ua = /Android|iPhone|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(
    navigator.userAgent,
  );
  return narrow || ua;
}

function preferredView(): View {
  const override = consumeQueryOverride() ?? readOverride();
  if (override) return override;
  return isPhone() ? "mobile" : "desktop";
}

// Если текущий интерфейс не совпадает с предпочтительным — уводим на нужный URL
// и сообщаем вызвавшему (true), чтобы тот не рендерил «не тот» интерфейс.
export function redirectIfWrongView(current: View): boolean {
  const want = preferredView();
  if (want === current) return false;
  window.location.replace(want === "mobile" ? "/m/" : "/");
  return true;
}

// Ссылка для ручного переключения: пишем выбор и ведём на корень интерфейса.
export function switchViewHref(target: View): string {
  return target === "mobile" ? "/m/?view=mobile" : "/?view=desktop";
}
