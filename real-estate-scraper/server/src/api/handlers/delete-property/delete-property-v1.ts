import { Request, Response, NextFunction } from "express";
import { deleteProperty } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Delete a property and all its associated listings and estimates
 * @route DELETE /api/v1/properties/:propertyId
 * @param propertyId - The property ID to delete
 * @returns {Object} { status, message, data: { property, listings, estimates } }
 */
export const deletePropertyHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { propertyId } = req.params;

    if (!propertyId) {
      return res.status(400).json({
        status: "error",
        message: "Missing propertyId parameter",
      });
    }

    logger.info(
      `[DELETE /properties/:propertyId] Deleting property and related data: ${propertyId}`,
    );

    const result = await deleteProperty(propertyId);

    if (result.property === 0) {
      return res.status(404).json({
        status: "error",
        message: `Property not found: ${propertyId}`,
      });
    }

    logger.info(
      `[DELETE /properties/:propertyId] Successfully deleted property ${propertyId} ` +
        `with ${result.listings} listings and ${result.estimates} estimates`,
    );

    res.status(200).json({
      status: "ok",
      message: `Property deleted successfully along with ${result.listings} listings and ${result.estimates} estimates`,
      data: result,
    });
  } catch (error) {
    logger.error(`[DELETE /properties/:propertyId] Error:`, error);
    next(error);
  }
};
