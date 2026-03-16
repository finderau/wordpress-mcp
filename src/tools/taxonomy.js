/**
 * Taxonomy tools — categories, tags.
 */

import { listSiteSlugs } from '../config.js';

const siteEnum = listSiteSlugs();

export const TAXONOMY_TOOLS = [
  {
    name: 'wp_get_categories',
    description: 'List WordPress categories with optional search.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: siteEnum, description: 'Target WordPress site' },
        search: { type: 'string', description: 'Search query' },
        per_page: { type: 'number', description: 'Results per page (default: 100)' },
      },
      required: ['site'],
    },
  },
  {
    name: 'wp_get_tags',
    description: 'List WordPress tags with optional search.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: siteEnum, description: 'Target WordPress site' },
        search: { type: 'string', description: 'Search query' },
        per_page: { type: 'number', description: 'Results per page (default: 100)' },
      },
      required: ['site'],
    },
  },
];

export async function handleGetCategories(client, args) {
  const params = new URLSearchParams();
  params.set('per_page', String(Math.max(1, Math.min(Number(args.per_page) || 100, 100))));
  if (args.search) params.set('search', args.search);

  const categories = await client.get(`/categories?${params.toString()}`);
  return {
    count: categories.length,
    categories: categories.map(c => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      parent: c.parent,
      count: c.count,
    })),
  };
}

export async function handleGetTags(client, args) {
  const params = new URLSearchParams();
  params.set('per_page', String(Math.max(1, Math.min(Number(args.per_page) || 100, 100))));
  if (args.search) params.set('search', args.search);

  const tags = await client.get(`/tags?${params.toString()}`);
  return {
    count: tags.length,
    tags: tags.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      count: t.count,
    })),
  };
}
