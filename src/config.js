/**
 * Site registry and credential resolution.
 *
 * Each site has a slug, display label, base URL, multisite flag,
 * and a credential prefix that maps to environment variables.
 *
 * For site "finder-com-au-qa1" with prefix "WP_FINDER_COM_AU_QA1":
 *   - WP_FINDER_COM_AU_QA1_USER → WordPress username
 *   - WP_FINDER_COM_AU_QA1_APP_PASSWORD → Application Password
 */

const SITES = {
  'finder-com-au-prod': {
    label: 'finder.com.au Production',
    baseUrl: 'https://www.finder.com.au',
    multisite: false,
    credentialPrefix: 'WP_FINDER_COM_AU_PROD',
  },
  'finder-com-prod': {
    label: 'finder.com Production',
    baseUrl: 'https://www.finder.com',
    multisite: false,
    credentialPrefix: 'WP_FINDER_COM_PROD',
  },
  // QA sites — Application Passwords support pending
  'finder-com-au-qa1': {
    label: 'finder.com.au QA1',
    baseUrl: 'https://site-fin.qa01.au-se1.gcp.finder.com',
    multisite: false,
    credentialPrefix: 'WP_FINDER_COM_AU_QA1',
  },
  'finder-com-au-qa2': {
    label: 'finder.com.au QA2',
    baseUrl: 'https://site-fca.qa02.au-se1.gcp.finder.com',
    multisite: false,
    credentialPrefix: 'WP_FINDER_COM_AU_QA2',
  },
};

/**
 * Get site configuration by slug.
 * @param {string} siteSlug
 * @returns {object} Site config
 */
export function getSiteConfig(siteSlug) {
  const site = SITES[siteSlug];
  if (!site) {
    throw new Error('Unknown site — check the site parameter is valid');
  }
  return site;
}

/**
 * Resolve credentials for a site, using per-user overrides if available.
 * @param {string} siteSlug
 * @param {object} credentials - Merged credentials (defaults + per-user overrides)
 * @returns {{ user: string, appPassword: string }}
 */
export function getSiteCredentials(siteSlug, credentials) {
  const site = getSiteConfig(siteSlug);
  const prefix = site.credentialPrefix;

  const user = credentials[`${prefix}_USER`];
  const appPassword = credentials[`${prefix}_APP_PASSWORD`];

  if (!user || !appPassword) {
    throw new Error(`Missing credentials for site "${siteSlug}"`);
  }

  return { user, appPassword };
}

/**
 * Get all site slugs (used for enum generation in tool schemas).
 * @returns {string[]}
 */
export function listSiteSlugs() {
  return Object.keys(SITES);
}

/**
 * Build the default credentials object from environment variables.
 * @returns {object}
 */
export function getDefaultCredentials() {
  const creds = {};
  for (const site of Object.values(SITES)) {
    const prefix = site.credentialPrefix;
    creds[`${prefix}_USER`] = process.env[`${prefix}_USER`];
    creds[`${prefix}_APP_PASSWORD`] = process.env[`${prefix}_APP_PASSWORD`];
  }
  return creds;
}
