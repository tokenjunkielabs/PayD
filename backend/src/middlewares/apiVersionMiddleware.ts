import express, { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

export type ApiVersion = 'v1';

export interface VersionConfig {
  version: ApiVersion;
  deprecated: boolean;
  sunset?: string;
  deprecationMessage?: string;
}

const VERSION_CONFIGS: Record<ApiVersion, VersionConfig> = {
  v1: {
    version: 'v1',
    deprecated: false,
  },
};

const CURRENT_VERSION: ApiVersion = 'v1';
const SUPPORTED_VERSIONS: ApiVersion[] = ['v1'];
const LEGACY_ROUTES_SUNSET = 'Fri, 01 Jan 2027 00:00:00 GMT';
const LEGACY_DEPRECATION_MESSAGE =
  `Legacy API routes are deprecated. Please use /api/${CURRENT_VERSION}/ instead.`;

function extractRequestedVersion(path: string): string | null {
  return path.match(/^\/api\/(v\d+)(?:\/|$)/)?.[1] ?? null;
}

export function extractApiVersion(path: string): ApiVersion | null {
  const requestedVersion = extractRequestedVersion(path);

  if (requestedVersion && SUPPORTED_VERSIONS.includes(requestedVersion as ApiVersion)) {
    return requestedVersion as ApiVersion;
  }

  return null;
}

function isLegacyRoute(path: string): boolean {
  const isApiPath = path === '/api' || path.startsWith('/api/');
  return isApiPath && extractRequestedVersion(path) === null;
}

function successorPath(path: string): string {
  const suffix = path.slice('/api'.length);
  return `/api/${CURRENT_VERSION}${suffix}`;
}

export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const version = extractApiVersion(req.path);

  res.setHeader('X-API-Version', version || CURRENT_VERSION);
  res.setHeader('X-API-Supported-Versions', SUPPORTED_VERSIONS.join(', '));
  res.setHeader('X-API-Current-Version', CURRENT_VERSION);

  if (version) {
    const config = VERSION_CONFIGS[version];

    if (config.deprecated) {
      res.setHeader('Deprecation', 'true');

      if (config.sunset) {
        res.setHeader('Sunset', config.sunset);
      }

      if (config.deprecationMessage) {
        res.setHeader('X-API-Deprecation-Message', config.deprecationMessage);
      }

      res.setHeader('Link', `</api/${CURRENT_VERSION}>; rel="successor-version"`);

      logger.warn(`Deprecated API version ${version} accessed`, {
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
    }
  } else if (isLegacyRoute(req.path)) {
    const replacement = successorPath(req.path);

    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', LEGACY_ROUTES_SUNSET);
    res.setHeader('Warning', `299 PayD "${LEGACY_DEPRECATION_MESSAGE}"`);
    res.setHeader('X-API-Deprecation-Message', LEGACY_DEPRECATION_MESSAGE);
    res.setHeader('Link', `<${replacement}>; rel="successor-version"`);

    logger.warn('Legacy API route accessed', {
      path: req.path,
      replacement,
      method: req.method,
      ip: req.ip,
    });
  }

  req.apiVersion = version || CURRENT_VERSION;

  next();
}

export function requireApiVersion(minVersion: ApiVersion) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const version = req.apiVersion || CURRENT_VERSION;
    const versionNum = parseInt(version.replace('v', ''), 10);
    const minVersionNum = parseInt(minVersion.replace('v', ''), 10);

    if (versionNum < minVersionNum) {
      res.status(400).json({
        error: 'Unsupported API version',
        message: `This endpoint requires API version ${minVersion} or higher`,
        currentVersion: version,
        minimumVersion: minVersion,
      });
      return;
    }

    next();
  };
}

export function versionedRouter(version: ApiVersion, router: express.Router) {
  return router;
}

declare global {
  namespace Express {
    interface Request {
      apiVersion?: ApiVersion;
    }
  }
}
