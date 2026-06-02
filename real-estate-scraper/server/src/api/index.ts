import { Router, Request, Response } from "express";
import {
  getAllProperties,
  getAllListingsHandler,
  updateFilterHandler,
  getFilterHandler,
  triggerScrapeHandler,
  stopScrapeHandler,
  getZillowListingsHandler,
  getRedfinListingsHandler,
  getRealtorListingsHandler,
  getPropwireListingsHandler,
  getScrapeStatusHandler,
  deleteListingHandler,
  deleteEstimateHandler,
  deletePropertyHandler,
} from "./handlers";

const router = Router();

/**
 * @swagger
 * /properties:
 *   get:
 *     tags:
 *       - Properties
 *     summary: Get all properties with listings and estimates
 *     description: Retrieve all properties with their related listings and estimates joined together
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of properties to return (max 10000)
 *     responses:
 *       200:
 *         description: Successfully retrieved properties
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 data:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     properties:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           normalizedAddress:
 *                             type: string
 *                           address:
 *                             type: string
 *                           city:
 *                             type: string
 *                           state:
 *                             type: string
 *                           zip:
 *                             type: string
 *                           listings:
 *                             type: array
 *                           estimates:
 *                             type: array
 *       500:
 *         description: Internal server error
 */
router.get("/properties", getAllProperties);

/**
 * @swagger
 * /listings:
 *   get:
 *     tags:
 *       - Listings
 *     summary: Get all listings with property data
 *     description: Retrieve all listings with their related property information
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of listings to return (max 10000)
 *     responses:
 *       200:
 *         description: Successfully retrieved listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 data:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     listings:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           url:
 *                             type: string
 *                           source:
 *                             type: string
 *                           title:
 *                             type: string
 *                           price:
 *                             type: integer
 *                           rawAddress:
 *                             type: string
 *                           location:
 *                             type: string
 *                           property:
 *                             type: object
 *       500:
 *         description: Internal server error
 */
router.get("/listings", getAllListingsHandler);

/**
 * @swagger
 * /filters:
 *   post:
 *     tags:
 *       - Filters
 *     summary: Create a new saved filter
 *     description: Create a new saved filter for scraping
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - source
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Cleveland Under $150k"
 *               description:
 *                 type: string
 *               source:
 *                 type: string
 *                 example: "craigslist"
 *               minPrice:
 *                 type: integer
 *               maxPrice:
 *                 type: integer
 *               propertyTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *               locations:
 *                 type: array
 *                 items:
 *                   type: string
 *               keywords:
 *                 type: array
 *                 items:
 *                   type: string
 *               excludeKeywords:
 *                 type: array
 *                 items:
 *                   type: string
 *               minBedrooms:
 *                 type: integer
 *               maxBedrooms:
 *                 type: integer
 *               minBathrooms:
 *                 type: number
 *               maxBathrooms:
 *                 type: number
 *               minSquareFeet:
 *                 type: integer
 *               maxSquareFeet:
 *                 type: integer
 *               minEquity:
 *                 type: integer
 *               minArv:
 *                 type: integer
 *               isActive:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Filter created successfully
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Internal server error
 *   get:
 *     tags:
 *       - Filters
 *     summary: Get all filters
 *     description: Retrieve all saved filters or only active filters
 *     parameters:
 *       - in: query
 *         name: activeOnly
 *         schema:
 *           type: boolean
 *         description: If true, return only active filters
 *     responses:
 *       200:
 *         description: Successfully retrieved filters
 *       500:
 *         description: Internal server error
 */
router.post("/filters", updateFilterHandler);

/**
 * @swagger
 * /filters:
 *   get:
 *     tags:
 *       - Filters
 *     summary: Get a filter by ID
 *     description: Retrieve a single saved filter by its ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Filter found
 *       404:
 *         description: Filter not found
 *       500:
 *         description: Internal server error
 *   put:
 *     tags:
 *       - Filters
 *     summary: Update a filter
 *     description: Update an existing saved filter
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - source
 *     responses:
 *       200:
 *         description: Filter updated successfully
 *       404:
 *         description: Filter not found
 *       500:
 *         description: Internal server error
 *   delete:
 *     tags:
 *       - Filters
 *     summary: Delete a filter
 *     description: Delete a saved filter by its ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Filter deleted successfully
 *       404:
 *         description: Filter not found
 *       500:
 *         description: Internal server error
 */
router.get("/filters", getFilterHandler);

/**
 * @swagger
 * /scrape/trigger:
 *   post:
 *     tags:
 *       - Scraping
 *     summary: Trigger scraper(s)
 *     description: Start scraping for specified source(s). Equivalent to npm run scrape:all or scrape:[source]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source:
 *                 type: string
 *                 default: all
 *                 description: Source to scrape - can be 'all', a specific source, or comma-separated sources. Available sources include facebook_marketplace, facebook, offmarket, investorlift, crexi, loopnet, craigslist_milwaukee, craigslist_columbus, craigslist_cleveland, craigslist_toledo, zillow, realtor, redfin, propwire
 *                 example: "all"
 *             example:
 *               source: "all"
 *     responses:
 *       202:
 *         description: Scraping started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 message:
 *                   type: string
 *                   example: "Scraping started for sources: facebook_marketplace, facebook, offmarket, investorlift, crexi, loopnet, craigslist_milwaukee, craigslist_columbus, craigslist_cleveland, craigslist_toledo, zillow, realtor, redfin, propwire"
 *                 data:
 *                   type: object
 *                   properties:
 *                     sources:
 *                       type: array
 *                       items:
 *                         type: string
 *                     scrapingStartedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid source specified
 *       500:
 *         description: Internal server error
 */
router.post("/scrape/trigger", triggerScrapeHandler);

/**
 * @swagger
 * /scrape/stop:
 *   post:
 *     tags:
 *       - Scraper
 *     summary: Stop the currently running scraper
 *     description: Request to stop the currently running scrape job. The current source will finish, then scraping stops.
 *     responses:
 *       200:
 *         description: Stop request accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     isStopping:
 *                       type: boolean
 *                     scrapingId:
 *                       type: string
 *       400:
 *         description: No scrape is currently running
 *       500:
 *         description: Internal server error
 */
router.post("/scrape/stop", stopScrapeHandler);

/**
 * @swagger
 * /listings/zillow:
 *   get:
 *     tags:
 *       - Listings
 *     summary: Get Zillow listings from source table
 *     description: Retrieve raw Zillow listings directly from the ZillowListing table (unenriched)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of listings to return (max 10000)
 *     responses:
 *       200:
 *         description: Successfully retrieved Zillow listings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 data:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     listings:
 *                       type: array
 *       500:
 *         description: Internal server error
 */
router.get("/listings/zillow", getZillowListingsHandler);

/**
 * @swagger
 * /listings/redfin:
 *   get:
 *     tags:
 *       - Listings
 *     summary: Get Redfin listings from source table
 *     description: Retrieve raw Redfin listings directly from the RedfinListing table (unenriched)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of listings to return (max 10000)
 *     responses:
 *       200:
 *         description: Successfully retrieved Redfin listings
 *       500:
 *         description: Internal server error
 */
router.get("/listings/redfin", getRedfinListingsHandler);

/**
 * @swagger
 * /listings/realtor:
 *   get:
 *     tags:
 *       - Listings
 *     summary: Get Realtor listings from source table
 *     description: Retrieve raw Realtor listings directly from the RealtorListing table (unenriched)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of listings to return (max 10000)
 *     responses:
 *       200:
 *         description: Successfully retrieved Realtor listings
 *       500:
 *         description: Internal server error
 */
router.get("/listings/realtor", getRealtorListingsHandler);

/**
 * @swagger
 * /listings/propwire:
 *   get:
 *     tags:
 *       - Listings
 *     summary: Get Propwire listings from source table
 *     description: Retrieve raw Propwire listings directly from the PropwireListing table (unenriched)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of listings to return (max 10000)
 *     responses:
 *       200:
 *         description: Successfully retrieved Propwire listings
 *       500:
 *         description: Internal server error
 */
router.get("/listings/propwire", getPropwireListingsHandler);

/**
 * Scrape status (polled)
 */
router.get("/scrape/status", getScrapeStatusHandler);

/**
 * Delete listing by ID
 * @route DELETE /api/v1/listings/:listingId
 */
router.delete("/listings/:listingId", deleteListingHandler);

/**
 * Delete estimate by ID
 * @route DELETE /api/v1/estimates/:estimateId
 */
router.delete("/estimates/:estimateId", deleteEstimateHandler);

/**
 * Delete property by ID (cascades to delete listings and estimates)
 * @route DELETE /api/v1/properties/:propertyId
 */
router.delete("/properties/:propertyId", deletePropertyHandler);

export default router;
