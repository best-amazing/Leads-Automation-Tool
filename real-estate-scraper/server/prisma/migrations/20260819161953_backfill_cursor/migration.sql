-- CreateTable
CREATE TABLE "BackfillCursor" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "seenIds" JSONB NOT NULL,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackfillCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackfillCursor_source_key" ON "BackfillCursor"("source");

-- CreateIndex
CREATE INDEX "BackfillCursor_source_idx" ON "BackfillCursor"("source");
