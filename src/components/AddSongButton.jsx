import { Plus } from "lucide-react";

export default function AddSongButton({ onClick }) {
  return (
    <button
      type="button"
      className="topBadgeButton"
      onClick={onClick}
      aria-label="Thêm bài hát từ YouTube"
      title="Thêm bài hát từ YouTube"
    >
      <Plus size={15} />
      <span>Thêm bài</span>
    </button>
  );
}