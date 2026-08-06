interface Props {
  fileName: string;
  copyName: string;
  onReplace: () => void;
  onRename: () => void;
  onCancel: () => void;
}

export default function ConfirmReplaceModal({ fileName, copyName, onReplace, onRename, onCancel }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
        <h3>File Already Exists</h3>
        <div className="confirm-body">
          <p><span className="confirm-file-highlight">"{fileName}"</span> already exists at the destination.</p>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-block" onClick={onReplace}>Replace</button>
          <button className="btn btn-block btn-ghost" onClick={onRename}>
            Keep Both (rename to "{copyName}")
          </button>
          <button className="btn btn-block btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
