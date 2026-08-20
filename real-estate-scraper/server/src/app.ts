import express, { Express, Request, Response, NextFunction } from "express";
import { logger } from "./utils/logger";
import { aduRunState } from "./scrapers/property-purchase-research/adu-run-state";

const app: Express = express();

// ── Middleware ───────────────────────────────────────────────────────────────

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Request logging middleware — suppress noisy endpoints
const IGNORED_LOG_PATHS = new Set(['/api/v1/scrape/status']);
app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip logging for the scrape status endpoint (OPTIONS/GET spam)
  if (IGNORED_LOG_PATHS.has(req.path) && (req.method === 'OPTIONS' || req.method === 'GET')) {
    return next();
  }

  logger.info(`${req.method} ${req.path}`);
  next();
});

// CORS middleware for frontend dev requests
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin as string | undefined;

  // Always set CORS headers for all origins (permissive for dev/testing)
  // Change this to restrict to specific origins in production if needed
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "3600");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check — also surfaces ADU research run state as an out-of-band
// heartbeat so liveness/progress is visible even if the log viewer wedges.
app.get("/api/healthcheck", (req: Request, res: Response) => {
  const idleSec = aduRunState.lastProgressAt
    ? Math.round((Date.now() - aduRunState.lastProgressAt) / 1000)
    : 0;
  res.status(200).json({
    status: "ok",
    message: "Server is running",
    adu: {
      ...aduRunState,
      idleSec,
    },
  });
});

// API v1 routes
import apiRoutes from "./api";
app.use("/api/v1", apiRoutes);

// Root redirect to API documentation
app.get("/", (req: Request, res: Response) => {
  res.redirect("/api/v1/properties");
});

// ── Error Handling ───────────────────────────────────────────────────────────

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    status: "error",
    message: "Route not found",
  });
});

// Global error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Error: ${err.message}`, err);

  res.status(err.statusCode || 500).json({
    status: "error",
    message: err.message || "Internal server error",
  });
});

export default app;
