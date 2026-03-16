/**
 * Tool registry and request router.
 *
 * Aggregates all tool definitions and routes tool calls to the correct handler.
 */

import { POST_TOOLS, handleListPosts, handleGetPost, handleListRevisions, handleCreatePost, handleUpdatePost, handleDeletePost } from './posts.js';
import { MEDIA_TOOLS, handleListMedia, handleUploadMedia, handleDeleteMedia } from './media.js';
import { TAXONOMY_TOOLS, handleGetCategories, handleGetTags } from './taxonomy.js';
import { SITE_TOOLS, handleGetSiteInfo } from './site.js';
import { CHANGES_TOOLS, handleListChanges, handleRestore } from './changes.js';

export const TOOLS = [
  ...POST_TOOLS,
  ...MEDIA_TOOLS,
  ...TAXONOMY_TOOLS,
  ...SITE_TOOLS,
  ...CHANGES_TOOLS,
];

/**
 * Route a tool call to the correct handler.
 *
 * @param {string} name - Tool name
 * @param {object} args - Clean arguments (gateway fields already stripped)
 * @param {import('../wordpress-client.js').WordPressClient} client - WP API client for the target site
 * @param {import('../backup-store.js').BackupStore} backupStore - Backup store
 * @param {string|null} userEmail - Caller identity from gateway
 * @param {string} site - Site slug
 * @param {object} siteConfig - Site configuration object
 * @returns {Promise<object>} MCP response content
 */
export async function handleToolCall(name, args, client, backupStore, userEmail, site, siteConfig) {
  let result;

  switch (name) {
    // Posts
    case 'wp_list_posts':
      result = await handleListPosts(client, args);
      break;
    case 'wp_get_post':
      result = await handleGetPost(client, args);
      break;
    case 'wp_list_revisions':
      result = await handleListRevisions(client, args);
      break;
    case 'wp_create_post':
      result = await handleCreatePost(client, backupStore, args, userEmail, site);
      break;
    case 'wp_update_post':
      result = await handleUpdatePost(client, backupStore, args, userEmail, site);
      break;
    case 'wp_delete_post':
      result = await handleDeletePost(client, backupStore, args, userEmail, site);
      break;

    // Media
    case 'wp_list_media':
      result = await handleListMedia(client, args);
      break;
    case 'wp_upload_media':
      result = await handleUploadMedia(client, args);
      break;
    case 'wp_delete_media':
      result = await handleDeleteMedia(client, backupStore, args, userEmail, site);
      break;

    // Taxonomy
    case 'wp_get_categories':
      result = await handleGetCategories(client, args);
      break;
    case 'wp_get_tags':
      result = await handleGetTags(client, args);
      break;

    // Site
    case 'wp_get_site_info':
      result = await handleGetSiteInfo(client, site, siteConfig);
      break;

    // Changes / Restore
    case 'wp_list_changes':
      result = await handleListChanges(backupStore, args);
      break;
    case 'wp_restore':
      result = await handleRestore(client, backupStore, args, userEmail, site);
      break;

    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}
