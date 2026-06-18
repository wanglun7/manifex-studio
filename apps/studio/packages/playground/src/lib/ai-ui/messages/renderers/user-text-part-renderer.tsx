import type { TextPart } from '@mastra/react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@mastra/playground-ui';
import {
  ArchiveIcon,
  DownloadIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  PresentationIcon,
} from 'lucide-react';

import type { MessageMetadata } from '../message-metadata';
import { SystemReminderBadge } from '../system-reminder-badge';
import { InMessageAttachment } from './in-message-attachment';
import { MessageText } from './message-text';

export interface UserTextPartRendererProps {
  part: TextPart;
  metadata?: MessageMetadata;
}

const MANIFEX_ATTACHMENTS_BLOCK = /<manifex_attachments>[\s\S]*?<\/manifex_attachments>/g;

export const stripManifexAttachmentManifest = (text: string) => text.replace(MANIFEX_ATTACHMENTS_BLOCK, '').trim();

export interface ManifexAttachmentManifestItem {
  name: string;
  sandboxPath?: string;
  url?: string;
  mimeType?: string;
  size?: string;
  sha256?: string;
}

const getCurrentThreadId = () => {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.pathname.match(/\/agents\/[^/]+\/chat\/([^/?#]+)/);
  const threadId = match?.[1];
  if (!threadId || threadId === 'new') return undefined;
  return decodeURIComponent(threadId);
};

const artifactUrlForSandboxPath = (sandboxPath?: string) => {
  const threadId = getCurrentThreadId();
  if (!threadId || !sandboxPath) return undefined;
  return `/manifex/threads/${encodeURIComponent(threadId)}/artifacts?path=${encodeURIComponent(sandboxPath)}`;
};

const formatAttachmentSize = (rawSize?: string) => {
  if (!rawSize) return undefined;
  const bytes = Number(rawSize);
  if (!Number.isFinite(bytes)) return rawSize;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

const getExtension = (name: string) => {
  const match = name.match(/\.([^.]+)$/);
  return match?.[1]?.toLowerCase() ?? 'file';
};

const iconForAttachment = (item: ManifexAttachmentManifestItem) => {
  const mimeType = item.mimeType ?? '';
  const extension = getExtension(item.name);
  if (mimeType.startsWith('image/')) return FileImageIcon;
  if (mimeType.includes('spreadsheet') || ['csv', 'xls', 'xlsx', 'numbers'].includes(extension)) return FileSpreadsheetIcon;
  if (mimeType.includes('presentation') || ['ppt', 'pptx', 'key'].includes(extension)) return PresentationIcon;
  if (mimeType.includes('zip') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return ArchiveIcon;
  if (
    mimeType.startsWith('text/') ||
    ['md', 'txt', 'json', 'yaml', 'yml', 'xml', 'log', 'csv', 'doc', 'docx', 'pdf'].includes(extension)
  ) {
    return FileTextIcon;
  }
  return FileIcon;
};

export const parseManifexAttachmentManifest = (text: string): ManifexAttachmentManifestItem[] => {
  const blocks = text.match(MANIFEX_ATTACHMENTS_BLOCK) ?? [];
  const items: ManifexAttachmentManifestItem[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let current: ManifexAttachmentManifestItem | undefined;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const itemMatch = line.match(/^\d+\.\s+(.+)$/);
      if (itemMatch) {
        current = { name: itemMatch[1] };
        items.push(current);
        continue;
      }
      if (!current) continue;

      const fieldMatch = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (!fieldMatch) continue;
      const [, key, value] = fieldMatch;
      if (key === 'sandbox_path') current.sandboxPath = value;
      if (key === 'url') current.url = value;
      if (key === 'mime_type') current.mimeType = value;
      if (key === 'size') current.size = value;
      if (key === 'sha256') current.sha256 = value;
    }
  }

  return items;
};

const ManifexAttachmentCard = ({ item }: { item: ManifexAttachmentManifestItem }) => {
  const src = artifactUrlForSandboxPath(item.sandboxPath) || item.url;
  const Icon = iconForAttachment(item);
  const extension = getExtension(item.name).slice(0, 8);
  const size = formatAttachmentSize(item.size);
  const detail = [item.mimeType, size].filter(Boolean).join(' · ');

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="group flex max-w-[22rem] items-center gap-3 rounded-xl border border-border1 bg-surface3/80 px-3 py-2.5 shadow-sm transition-colors hover:border-border2 hover:bg-surface4"
            aria-label={item.name}
          >
            <div className="relative flex size-10 shrink-0 items-center justify-center rounded-lg border border-border1 bg-surface1 text-icon4">
              <Icon className="size-5" aria-hidden="true" />
              <span className="absolute -bottom-1.5 rounded bg-surface5 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none text-neutral5">
                {extension}
              </span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-neutral12">{item.name}</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-neutral7">
                {detail || item.sandboxPath || item.url || 'uploaded file'}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 opacity-75 transition-opacity group-hover:opacity-100">
              {src ? (
                <a
                  href={src}
                  download={item.name}
                  className="inline-flex size-7 items-center justify-center rounded-md text-icon4 hover:bg-surface5 hover:text-icon6"
                  aria-label={`Download ${item.name}`}
                  onClick={event => event.stopPropagation()}
                >
                  <DownloadIcon className="size-3.5" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="max-w-96">
            <div className="truncate">{item.name}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-neutral4">
              {[item.mimeType, size, item.sandboxPath || item.url].filter(Boolean).join(' · ')}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const ManifexAttachmentCards = ({ items }: { items: ManifexAttachmentManifestItem[] }) => {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex max-w-full flex-row flex-wrap items-start gap-2">
      {items.map((item, index) => (
        <ManifexAttachmentCard key={`${item.sandboxPath ?? item.url ?? item.name}-${index}`} item={item} />
      ))}
    </div>
  );
};

/**
 * Renders a user `MessageFactory` `Text` slot. System-reminder text and inline
 * `<attachment name=...>` text get dedicated badges/previews; everything else
 * renders as markdown.
 */
export const UserTextPartRenderer = ({ part, metadata }: UserTextPartRendererProps) => {
  const rawText = part.text ?? '';
  const attachments = parseManifexAttachmentManifest(rawText);
  const text = stripManifexAttachmentManifest(rawText);
  if (!text) return <ManifexAttachmentCards items={attachments} />;

  if (text.trimStart().startsWith('<system-reminder')) {
    return <SystemReminderBadge text={text} />;
  }
  if (text.includes('<attachment name=')) {
    return <InMessageAttachment type="document" contentType="text/plain" data={text} />;
  }

  return (
    <>
      <MessageText text={text} metadata={metadata} />
      <ManifexAttachmentCards items={attachments} />
    </>
  );
};
