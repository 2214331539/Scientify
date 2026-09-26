import './brand.css';

/** Decorative mark; the containing control or heading supplies its accessible name. */
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img
        className="brand-mark-light"
        src="/brand/scientify-light.png"
        alt=""
        width={24}
        height={24}
        draggable={false}
      />
      <img
        className="brand-mark-dark"
        src="/brand/scientify-dark.png"
        alt=""
        width={24}
        height={24}
        draggable={false}
      />
    </span>
  );
}
