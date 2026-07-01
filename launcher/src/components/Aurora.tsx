import { memo } from "react";

const Aurora = memo(function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span className="aurora__blob aurora__blob--1" />
      <span className="aurora__blob aurora__blob--2" />
      <span className="aurora__blob aurora__blob--3" />
      <div className="aurora__grain" />
    </div>
  );
});

export default Aurora;
