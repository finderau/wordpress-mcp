/**
 * Media tools — list, upload, delete.
 *
 * Delete auto-backs up media metadata before removing.
 */

import { listSiteSlugs } from '../config.js';

const siteEnum = listSiteSlugs();

export const MEDIA_TOOLS = [
  {
    name: 'wp_list_media',
    description: 'List media items in the WordPress media library.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: siteEnum, description: 'Target WordPress site' },
        search: { type: 'string', description: 'Search query' },
        media_type: { type: 'string', description: 'Filter by type: image, video, audio, application' },
        per_page: { type: 'number', description: 'Results per page (default: 20, max: 100)' },
        page: { type: 'number', description: 'Page number (default: 1)' },
      },
      required: ['site'],
    },
  },
  {
    name: 'wp_upload_media',
    description: 'Upload a file to the WordPress media library. Provide base64-encoded file content.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: siteEnum, description: 'Target WordPress site' },
        filename: { type: 'string', description: 'Filename with extension (e.g. "hero.jpg")' },
        content_base64: { type: 'string', description: 'Base64-encoded file content' },
        content_type: { type: 'string', description: 'MIME type (e.g. "image/jpeg")' },
        title: { type: 'string', description: 'Media title' },
        alt_text: { type: 'string', description: 'Alt text for images' },
        caption: { type: 'string', description: 'Media caption' },
        description: { type: 'string', description: 'Media description' },
      },
      required: ['site', 'filename', 'content_base64', 'content_type'],
    },
  },
  {
    name: 'wp_delete_media',
    description: 'Delete a media item. Automatically backs up media metadata before deleting.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: siteEnum, description: 'Target WordPress site' },
        id: { type: 'number', description: 'Media ID to delete' },
        force: { type: 'boolean', description: 'Permanently delete (default: true for media)' },
      },
      required: ['site', 'id'],
    },
  },
];

function clampPagination(perPage, page) {
  const pp = Math.max(1, Math.min(Number(perPage) || 20, 100));
  const pg = Math.max(1, Number(page) || 1);
  return { perPage: pp, page: pg };
}

export async function handleListMedia(client, args) {
  const { perPage, page } = clampPagination(args.per_page, args.page);
  const params = new URLSearchParams();
  params.set('per_page', String(perPage));
  params.set('page', String(page));
  if (args.search) params.set('search', args.search);
  if (args.media_type) params.set('media_type', args.media_type);

  const media = await client.get(`/media?${params.toString()}`);

  return {
    count: media.length,
    media: media.map(m => ({
      id: m.id,
      title: m.title?.rendered || m.title,
      source_url: m.source_url,
      media_type: m.media_type,
      mime_type: m.mime_type,
      date: m.date,
      alt_text: m.alt_text,
    })),
  };
}

export async function handleUploadMedia(client, args) {
  // Early size check on base64 string to avoid allocating huge buffers.
  // 10MB file ≈ 13.4MB base64. Reject anything clearly over the limit.
  const MAX_BASE64_LENGTH = 14 * 1024 * 1024;
  if (args.content_base64.length > MAX_BASE64_LENGTH) {
    throw new Error(`File too large. Base64 input exceeds ${MAX_BASE64_LENGTH} bytes (max file size: 10MB)`);
  }
  const fileBuffer = Buffer.from(args.content_base64, 'base64');
  const meta = {};
  if (args.title) meta.title = args.title;
  if (args.alt_text) meta.alt_text = args.alt_text;
  if (args.caption) meta.caption = args.caption;
  if (args.description) meta.description = args.description;

  const uploaded = await client.uploadMedia(fileBuffer, args.filename, args.content_type, meta);

  return {
    id: uploaded.id,
    title: uploaded.title?.rendered || uploaded.title,
    source_url: uploaded.source_url,
    media_type: uploaded.media_type,
    message: `Media uploaded successfully (ID: ${uploaded.id})`,
  };
}

// Intentionally duplicated in posts.js and changes.js to keep tool files self-contained
function requirePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

export async function handleDeleteMedia(client, backupStore, args, userEmail, site) {
  const id = requirePositiveInt(args.id, 'id');

  // 1. Snapshot current state (metadata only — can't back up the actual file)
  const current = await client.get(`/media/${id}?context=edit`);

  // 2. Store backup
  const backupId = backupStore.createBackup({
    objectType: 'media',
    objectId: id,
    snapshot: current,
    action: 'delete',
    changedBy: userEmail || 'unknown',
    changeSummary: `Deleted media "${current.title?.rendered || current.title || id}" (${current.source_url})`,
    wpSite: site,
  });

  // 3. Delete (media requires force=true to actually delete)
  const force = args.force !== false;
  const result = await client.del(`/media/${id}?force=${force}`);

  return {
    id,
    backup_id: backupId,
    message: `Media ${id} deleted. Backup ID: ${backupId} (metadata only — file cannot be restored via API)`,
  };
}
