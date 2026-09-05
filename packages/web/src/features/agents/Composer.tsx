import { useEffect, useRef, useState } from 'react';
import type { Agent, Attachment } from '@jkj/shared';
import { sendMessage, showToast } from '../../state/store.js';
import { readFile } from '../../lib/attachments.js';
import { AttachmentTray } from './AttachmentTray.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';

/**
 * Steer a session, with whatever it needs to see.
 *
 * Three states, and only one of them is a refusal: a session JKJ drives takes
 * the message, a finished one is picked back up, and a session open in a
 * terminal cannot be typed into because that process owns its input.
 */
export function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const openElsewhere = !agent.driven && (agent.status === 'running' || agent.status === 'waiting');
  const isSubagent = Boolean(agent.parentAgentId);
  const canSend = !openElsewhere && !isSubagent;
  const resuming = !agent.driven && canSend;

  useEffect(() => {
    if (canSend) boxRef.current?.querySelector('textarea')?.focus();
  }, [agent.id, canSend]);

  // A new conversation starts with an empty tray.
  useEffect(() => { setAttachments([]); setText(''); }, [agent.id]);

  const take = async (files: FileList | File[] | null): Promise<void> => {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        setAttachments(current => [...current, { name: '', mediaType: '', data: '' }]);
        const read = await readFile(file);
        setAttachments(current => [...current.slice(0, -1), read]);
      } catch (err) {
        setAttachments(current => current.slice(0, -1));
        showToast(err instanceof Error ? err.message : 'That file could not be read.');
      }
    }
  };

  const send = async (): Promise<void> => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || busy) return;

    setBusy(true);
    const sending = attachments;
    setText('');
    setAttachments([]);
    await sendMessage(agent.id, value, sending);
    setBusy(false);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    await send();
  };

  // Enter sends, because that is what a chat box does. A message long enough
  // to want paragraphs gets them with shift.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  if (!canSend) {
    return (
      <div className="composer readonly">
        <span>
          {isSubagent
            ? 'A subagent run is part of its parent session. Continue the parent instead.'
            : 'This session is open in a terminal right now, so that terminal owns its input. Close it there and it becomes continuable here.'}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className={`composerwrap${dragging ? ' dropping' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        void take(e.dataTransfer.files);
      }}
    >
      <AttachmentTray
        attachments={attachments}
        onRemove={index => setAttachments(current => current.filter((_, i) => i !== index))}
      />

      <form className="composer" onSubmit={e => void submit(e)}>
        <button
          type="button"
          className="btn sm ghost attach"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a file"
          title="Attach an image or a text file"
        >
          ＋
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={e => { void take(e.target.files); e.target.value = ''; }}
        />

        <GrowTextarea
          value={text}
          onChange={setText}
          onKeyDown={onKeyDown}
          onPaste={e => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault();   // keep the filename out of the text box
            void take(files);
          }}
          placeholder={resuming ? 'Continue this session…' : `Message ${agent.name}…`}
          aria-label="Message this session"
          rows={1}
          minHeight={38}
          maxHeight={220}
          disabled={busy}
        />

        <button
          className="btn sm primary"
          type="submit"
          disabled={busy || (!text.trim() && attachments.length === 0)}
        >
          {busy ? 'Sending…' : resuming ? 'Continue' : 'Send'}
        </button>
      </form>

      <div className="hintline">
        {dragging
          ? 'Drop to attach'
          : 'Enter to send · Shift+Enter for a new line · paste a screenshot or drop a file'}
      </div>
    </div>
  );
}
