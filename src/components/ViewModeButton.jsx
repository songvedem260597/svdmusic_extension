import { Maximize2, Pin } from "lucide-react";

// Two icons, one button. Render is driven entirely by the `mode` prop
// so the caller (App.jsx) keeps full control of state + click handler.
//
// `disabled` reflects the in-flight transition so the user can't double
// click and open two tabs at once.
export default function ViewModeButton({ mode, onClick, disabled }) {
  const isStandalone = mode === "standalone";
  const Icon = isStandalone ? Pin : Maximize2;
  const label = isStandalone
    ? "Ghim SVD Music Player lại Side Panel"
    : "Mở SVD Music Player trong tab riêng";
  const title = isStandalone ? "Ghim lại Side Panel" : "Mở trong tab riêng";
  const className = `topBadgeButton viewModeButton${isStandalone ? " isStandalone" : ""}`;

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
    >
      <Icon size={15} />
      <span>{isStandalone ? "Ghim lại" : "Mở trong tab"}</span>
    </button>
  );
}