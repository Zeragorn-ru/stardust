// Статичный декоративный фон «звёздной пыли».
//
// Дорогая анимация авроры удалена: фон состоит из нескольких статичных
// CSS-слоёв (туманности-градиенты, звёздные поля через box-shadow на
// крошечных элементах), которые не требуют JS-анимаций и почти бесплатны
// для рендера. Слои не перехватывают события.
//
// Позиции звёзд сгенерированы один раз при первом импорте модуля
// (детерминированный PRNG — без «мигания» между ре-рендерами React).

/** Детерминированный PRNG (mulberry32): одинаковый фон при каждом запуске. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  x: number;
  y: number;
  size: number;
  opacity: number;
}

/** Пул «звёзд» с зёрнами PRNG — кэшируется на уровне модуля. */
function makeStars(count: number, seed: number): Star[] {
  const rnd = mulberry32(seed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.round(rnd() * 10000) / 100, // 0–100% с шагом 0.01
      y: Math.round(rnd() * 10000) / 100,
      size: rnd() < 0.85 ? 1 : 2,
      opacity: 0.25 + rnd() * 0.5,
    });
  }
  return stars;
}

const STARS_BACK = makeStars(90, 0x5d2b8);
const STARS_MID = makeStars(45, 0x1e9f3);
const STARS_FRONT = makeStars(14, 0x77aa2);

/**
 * box-shadow-«поле» из звёзд: базовый элемент 1×1 в левом верхнем углу,
 * каждая звезда — offset тени от него (формат box-shadow, не background).
 */
function starField(stars: Star[], color: string): string {
  return stars
    .map(
      (s) =>
        `${s.x}vw ${s.y}vh ${s.opacity * 2}px ${s.size / 2}px ${color}`,
    )
    .join(", ");
}

interface StarLayerProps {
  stars: Star[];
  color: string;
  className: string;
}

/** Слой звёзд: невидимая точка 1×1, звёзды — её тени. */
function StarLayer({ stars, color, className }: StarLayerProps) {
  return (
    <span
      className={className}
      style={{ boxShadow: starField(stars, color) } as React.CSSProperties}
      aria-hidden
    />
  );
}

export default function Aurora() {
  return (
    <div className="aurora" aria-hidden>
      {/* Дальний слой: глубокая фиолетовая туманность у левого края. */}
      <div className="aurora__nebula aurora__nebula--left">
        <StarLayer
          className="aurora__stars aurora__stars--back"
          stars={STARS_BACK}
          color="rgba(210, 214, 235, 0.5)"
        />
      </div>
      {/* Средний слой: голубая дымка у правого верхнего угла. */}
      <div className="aurora__nebula aurora__nebula--right">
        <StarLayer
          className="aurora__stars aurora__stars--mid"
          stars={STARS_MID}
          color="rgba(190, 205, 255, 0.55)"
        />
      </div>
      {/* Ближний слой: редкие крупные «пылинки». */}
      <StarLayer
        className="aurora__stars aurora__stars--front"
        stars={STARS_FRONT}
        color="rgba(233, 236, 250, 0.75)"
      />
    </div>
  );
}
