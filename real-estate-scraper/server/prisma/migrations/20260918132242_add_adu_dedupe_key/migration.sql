-- CreateTable
CREATE TABLE "AduDedupeKey" (
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AduDedupeKey_pkey" PRIMARY KEY ("dedupKey")
);

-- CreateIndex
CREATE INDEX "AduDedupeKey_createdAt_idx" ON "AduDedupeKey"("createdAt");
