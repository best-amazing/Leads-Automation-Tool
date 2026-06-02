import { Request, Response, NextFunction } from "express";
import { deleteListing } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Delete a single listing by ID
 * @route DELETE /api/v1/listings/:listingId
 * @param listingId - The listing ID to delete
 * @returns {Object} { status, message, data? }
 */
export const deleteListingHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { listingId } = req.params;

    if (!listingId) {
      return res.status(400).json({
        status: "error",
        message: "Missing listingId parameter",
      });
    }

    logger.info(`[DELETE /listings/:listingId] Deleting listing: ${listingId}`);

    const success = await deleteListing(listingId);

    if (!success) {
      return res.status(404).json({
        status: "error",
        message: `Listing not found: ${listingId}`,
      });
    }

    logger.info(
      `[DELETE /listings/:listingId] Successfully deleted listing: ${listingId}`,
    );

    res.status(200).json({
      status: "ok",
      message: `Listing deleted successfully`,
      data: { listingId },
    });
  } catch (error) {
    logger.error(`[DELETE /listings/:listingId] Error:`, error);
    next(error);
  }
};
