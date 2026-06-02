import { Request, Response, NextFunction } from "express";
import { deleteEstimate } from "../../../db/repository";
import { logger } from "../../../utils/logger";

/**
 * Delete a single estimate by ID
 * @route DELETE /api/v1/estimates/:estimateId
 * @param estimateId - The estimate ID to delete
 * @returns {Object} { status, message, data? }
 */
export const deleteEstimateHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { estimateId } = req.params;

    if (!estimateId) {
      return res.status(400).json({
        status: "error",
        message: "Missing estimateId parameter",
      });
    }

    logger.info(
      `[DELETE /estimates/:estimateId] Deleting estimate: ${estimateId}`,
    );

    const success = await deleteEstimate(estimateId);

    if (!success) {
      return res.status(404).json({
        status: "error",
        message: `Estimate not found: ${estimateId}`,
      });
    }

    logger.info(
      `[DELETE /estimates/:estimateId] Successfully deleted estimate: ${estimateId}`,
    );

    res.status(200).json({
      status: "ok",
      message: `Estimate deleted successfully`,
      data: { estimateId },
    });
  } catch (error) {
    logger.error(`[DELETE /estimates/:estimateId] Error:`, error);
    next(error);
  }
};
