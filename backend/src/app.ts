import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config/index.js';
import logger from './utils/logger.js';
import passport from './config/passport.js';
import { apiVersionMiddleware } from './middlewares/apiVersionMiddleware.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { auditLoggerMiddleware } from './middleware/auditLogger.js';
import { tieredOrganizationRateLimit } from './middleware/advancedRateLimiting.js';
import { rateLimitHeaders } from './middleware/rateLimitHeaders.js';
import { syncTenantFromUser } from './middleware/tenantContext.js';

// Public and API routes
import v1Routes from './routes/v1/index.js';
import authRoutes from './routes/authRoutes.js';
import webhookRoutes from './routes/webhook.routes.js';
import { HealthController } from './controllers/healthController.js';

// Part 48 — request auditing, rate limiting, tenant security
import { requestAuditLoggerMiddleware } from './middleware/requestAuditLogger.js';
import { organizationRateLimiter } from './middleware/organizationRateLimiter.js';
import { detectSqlInjection } from './middleware/tenantSecurityMonitor.js';

// Part 45 — enhanced audit analytics, smart rate limiting, tenant security guard
import { enhancedAuditMiddleware } from './middleware/enhancedAuditAnalytics.js';
import { smartRateLimitMiddleware } from './middleware/smartRateLimiter.js';
import { tenantSecurityGuardMiddleware } from './middleware/tenantSecurityGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Reuse the exact v1 route graph for the legacy /api alias. Version-looking
// paths are skipped here so an unknown /api/vN endpoint cannot fall through
// and accidentally resolve as a legacy route.
const legacyApiAliasRouter = express.Router();
legacyApiAliasRouter.use((req, _res, next) => {
  if (/^\/v\d+(?:\/|$)/.test(req.path)) {
    next('router');
    return;
  }

  next();
});
legacyApiAliasRouter.use(v1Routes);

// Middleware — request ID first for correlation across all layers
app.use(requestIdMiddleware);

// Standard X-RateLimit-* response headers on every response, normalized from
// whichever rate limiter (tiered/advanced, organization, or smart) ran for
// this request. Mounted first so the res.json/res.send hook is installed
// before any handler — including error/404 paths — can respond.
app.use(
  rateLimitHeaders({
    routeOverrides: {
      '/auth': { limit: 20 },
      '/api/auth': { limit: 20 },
      '/api/v1/auth': { limit: 20 },
    },
  })
);

// Global security headers via helmet with stricter CSP
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use(cors());

// Attach request ID to morgan logs for end-to-end traceability
morgan.token('request-id', (req) => (req as any).requestId || '-');
app.use(
  morgan(
    ':method :url :status :res[content-length] - :response-time ms request-id=:request-id'
  )
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());

// Global audit logging — records every API request with sanitization
app.use(
  auditLoggerMiddleware({
    logRequestBody: true,
    logResponseBody: false,
    sensitiveFields: ['password', 'token', 'secret', 'apiKey', 'privateKey', 'totp_secret'],
    skipPaths: [/^\/health/, /^\/metrics/, /^\/\.well-known/],
    logOnlyErrors: false,
  })
);

// Global rate limiting — organization-tier based, always on
app.use(
  tieredOrganizationRateLimit({
    enableBypass: true,
    enableDynamicLimits: true,
  })
);

// Global tenant context sync — sets req.tenantId from JWT user when available
// Must run before any authenticated routes
app.use(syncTenantFromUser);

// Serve stellar.toml for SEP-0001
app.get('/.well-known/stellar.toml', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(__dirname, '../.well-known/stellar.toml'));
});

// Health check endpoints (public / unauthenticated)
app.get('/health', HealthController.getHealthStatus);
app.get('/health/live', HealthController.getLiveness);

// Resolve API version and deprecation metadata before API security middleware.
app.use(apiVersionMiddleware);

// Part 48 — request audit logging, rate limiting, SQL injection detection
app.use('/api', requestAuditLoggerMiddleware());
app.use('/api', organizationRateLimiter());
app.use('/api', detectSqlInjection());

// Part 45 — enhanced audit analytics, smart rate limiting, tenant security guard
app.use('/api', enhancedAuditMiddleware({ trackPerformance: true, trackErrors: true }));
app.use('/api', smartRateLimitMiddleware({ organizationBased: true }));
app.use('/api', tenantSecurityGuardMiddleware({ detectAnomalies: true }));

// Public compatibility endpoints.
app.use('/auth', authRoutes);
app.use('/webhooks', webhookRoutes);

// One canonical API route graph. /api is a backwards-compatible alias of v1,
// rather than a separately maintained collection of duplicate route mounts.
app.use('/api/v1', v1Routes);
app.use('/api', legacyApiAliasRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    requestId: (req as any).requestId,
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { err, requestId: (req as any).requestId });
  res.status(500).json({
    error: 'Internal Server Error',
    message: config.nodeEnv === 'development' ? err.message : 'An error occurred',
    requestId: (req as any).requestId,
  });
});

export default app;
