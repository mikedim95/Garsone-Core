export type DbTarget = 'primary' | 'default' | 'render_internal' | 'render_external';

const maybeEnforceSsl = (url: string | undefined, target: DbTarget) => {
  if (!url) return url;
  if (target !== 'render_external') return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.get('sslmode')) {
      u.searchParams.set('sslmode', 'require');
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
};

export function resolveDbConfig() {
  const normalizeTarget = (value: string | undefined): DbTarget => {
    const normalized = (value || '').toLowerCase();
    if (normalized === 'render_internal' || normalized === 'render_external' || normalized === 'default') {
      return normalized;
    }
    // When running on Render with missing/mis-set DB_CONNECTION, prefer the hosted DB (external) over Supabase.
    if (process.env.RENDER || (process.env.NODE_ENV || '').toLowerCase() === 'production') {
      return 'render_external';
    }
    return 'primary';
  };

  const target = normalizeTarget(process.env.DB_CONNECTION);

  const databaseUrlByTarget: Record<DbTarget, string | undefined> = {
    primary: process.env.DATABASE_URL,
    default: process.env.DATABASE_URL,
    render_internal: process.env.DATABASE_URL_RENDER_INTERNAL,
    render_external: process.env.DATABASE_URL_RENDER_EXTERNAL,
  };

  const directUrlByTarget: Record<DbTarget, string | undefined> = {
    primary: process.env.DIRECT_URL,
    default: process.env.DIRECT_URL,
    render_internal: process.env.DIRECT_URL_RENDER_INTERNAL,
    render_external: process.env.DIRECT_URL_RENDER_EXTERNAL,
  };

  const databaseUrl =
    maybeEnforceSsl(
      databaseUrlByTarget[target] ||
    databaseUrlByTarget.primary ||
      databaseUrlByTarget.default,
      target
    );

  if (!databaseUrl) {
    throw new Error(`[db] DATABASE_URL not configured for DB_CONNECTION=${target}`);
  }

  const directUrl =
    maybeEnforceSsl(
      directUrlByTarget[target] ||
    directUrlByTarget.primary ||
      directUrlByTarget.default,
      target
    );

  return { target, databaseUrl, directUrl };
}

export function applyDbConnection() {
  const config = resolveDbConfig();
  process.env.DATABASE_URL = config.databaseUrl;
  if (config.directUrl) {
    process.env.DIRECT_URL = config.directUrl;
  }
  return config;
}
