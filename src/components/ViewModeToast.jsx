// Minimal toast for view-mode transitions. Auto-dismisses after a
// short timeout — the caller just sets `message` to a non-empty
// string. Empty / null hides the toast.
//
// Intentionally a separate component so App.jsx stays focused on the
// player state machine and so the toast can be reused if other
// surface-mode flows grow.

import { useEffect, useState } from "react";

const AUTO_DISMISS_MS = 3500;

export default function ViewModeToast({ message }) {
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return undefined;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message || !visible) return null;

  return (
    <div className="viewModeToast" role="status" aria-live="polite">
      <span>{message}</span>
    </div>
  );
}