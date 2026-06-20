import type { CoreUserMessage } from '@mastra/core/llm';
import { getFileContentType } from '@mastra/playground-ui';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ComposerAttachmentKind = 'image' | 'pdf' | 'text';

export interface ComposerAttachment {
  id: string;
  /** The picked file. For URL attachments this is an empty File whose `name` is the URL. */
  file: File;
  name: string;
  contentType: string;
  kind: ComposerAttachmentKind;
  /** True when this attachment was added by URL (name is a https:// link). */
  isUrl: boolean;
}

interface ComposerAttachmentsContextValue {
  attachments: ComposerAttachment[];
  addFiles: (files: File[] | FileList) => void;
  addUrl: (url: string) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  toCoreUserMessages: (options?: { agentId?: string; threadId?: string }) => Promise<CoreUserMessage[]>;
}

const ComposerAttachmentsContext = createContext<ComposerAttachmentsContextValue | null>(null);

const kindForContentType = (contentType: string): ComposerAttachmentKind => {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf') return 'pdf';
  return 'text';
};

let attachmentCounter = 0;
const nextId = () => `att-${Date.now()}-${++attachmentCounter}`;

const toAttachment = (file: File): ComposerAttachment => {
  const isUrl = file.name.startsWith('https://');
  const contentType = file.type || 'text/plain';
  return {
    id: nextId(),
    file,
    name: file.name,
    contentType,
    kind: kindForContentType(contentType),
    isUrl,
  };
};

interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  sandboxPath: string;
}

const formatBytes = (value: number) => {
  if (!Number.isFinite(value)) return 'unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const uploadLocalAttachments = async (threadId: string, attachments: ComposerAttachment[], agentId?: string) => {
  const formData = new FormData();
  attachments.forEach(att => formData.append('files', att.file, att.name));

  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  const query = params.size ? `?${params.toString()}` : '';

  const response = await fetch(`/manifex/threads/${encodeURIComponent(threadId)}/attachments${query}`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Attachment upload failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { attachments?: UploadedAttachment[] };
  return data.attachments ?? [];
};

const attachmentsToCoreUserMessage = async (
  attachments: ComposerAttachment[],
  options?: { agentId?: string; threadId?: string },
): Promise<CoreUserMessage> => {
  const localAttachments = attachments.filter(att => !att.isUrl);
  const urlAttachments = attachments.filter(att => att.isUrl);

  if (localAttachments.length > 0 && !options?.threadId) {
    throw new Error('A thread id is required before uploading local attachments.');
  }

  const uploaded =
    localAttachments.length > 0
      ? await uploadLocalAttachments(options!.threadId!, localAttachments, options?.agentId)
      : [];
  const lines = [
    '<manifex_attachments>',
    'The user attached files for this turn. They are available inside the current thread workspace.',
    'Do not infer file contents from filenames. Use filesystem and shell tools to inspect them.',
    '',
  ];

  uploaded.forEach((att, index) => {
    lines.push(`${index + 1}. ${att.name}`);
    lines.push(`   sandbox_path: ${att.sandboxPath}`);
    lines.push(`   mime_type: ${att.mimeType}`);
    lines.push(`   size: ${formatBytes(att.size)}`);
    lines.push(`   sha256: ${att.sha256}`);
    lines.push('');
  });

  urlAttachments.forEach((att, index) => {
    lines.push(`${uploaded.length + index + 1}. ${att.name}`);
    lines.push(`   url: ${att.name}`);
    lines.push(`   mime_type: ${att.contentType}`);
    lines.push('');
  });

  lines.push('</manifex_attachments>');

  return {
    role: 'user' as const,
    content: lines.join('\n'),
  };
};

export const ComposerAttachmentsProvider = ({ children }: { children: ReactNode }) => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

  const addFiles = useCallback((files: File[] | FileList) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setAttachments(prev => [...prev, ...list.map(toAttachment)]);
  }, []);

  const addUrl = useCallback(async (url: string) => {
    const contentType = (await getFileContentType(url)) ?? 'application/octet-stream';
    // URL attachments are represented by an empty File named with the URL.
    const file = new File([], url, { type: contentType });
    setAttachments(prev => [...prev, toAttachment(file)]);
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  const toCoreUserMessages = useCallback(async (options?: { threadId?: string }) => {
    if (attachments.length === 0) return [];
    return [await attachmentsToCoreUserMessage(attachments, options)];
  }, [attachments]);

  const value = useMemo<ComposerAttachmentsContextValue>(
    () => ({ attachments, addFiles, addUrl, remove, clear, toCoreUserMessages }),
    [attachments, addFiles, addUrl, remove, clear, toCoreUserMessages],
  );

  return <ComposerAttachmentsContext.Provider value={value}>{children}</ComposerAttachmentsContext.Provider>;
};

export const useComposerAttachments = (): ComposerAttachmentsContextValue => {
  const ctx = useContext(ComposerAttachmentsContext);
  if (!ctx) {
    throw new Error('useComposerAttachments must be used within a ComposerAttachmentsProvider');
  }
  return ctx;
};
