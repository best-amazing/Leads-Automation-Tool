// src/utils/logger.ts
/**
 * Logger configuration: Console (stdout) only, colorized output
 * Format: `${level}: ${message}`
 * Example: "info: ✓ Database connected"
 * 
 * All logs (scraper, enrichment, API, etc.) output to stdout for real-time visibility
 */
import winston from "winston";

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(({ level, message }) => `${level}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
  ],
});
