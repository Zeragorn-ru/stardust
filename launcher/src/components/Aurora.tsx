// Анимированный фон «аврора»: несколько размытых градиентных пятен,
// медленно дрейфующих. При data-motion="off" дрейф отключается через CSS,
// остаётся статичный градиент — дёшево для слабых машин.

export default function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span className="aurora__blob aurora__blob--1" />
      <span className="aurora__blob aurora__blob--2" />
      <span className="aurora__blob aurora__blob--3" />
      <div className="aurora__grain" />
    </div>
  );
}
