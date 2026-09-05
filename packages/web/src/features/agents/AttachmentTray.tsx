import type { Attachment } from '@jkj/shared';
import { isImage, previewUrl } from '../../lib/attachments.js';

/** What is about to be sent, and a way to change your mind about each one. */
export function AttachmentTray({
  attachments, onRemove,
}: {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="tray">
      {attachments.map((file, index) => (
        <div className="chipfile" key={`${file.name}-${index}`}>
          {isImage(file)
            ? <img src={previewUrl(file)} alt="" />
            : <span className="doc" aria-hidden="true">TXT</span>}
          <span className="fname" title={file.name}>{file.name}</span>
          <button
            className="x"
            onClick={() => onRemove(index)}
            aria-label={`Remove ${file.name}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
