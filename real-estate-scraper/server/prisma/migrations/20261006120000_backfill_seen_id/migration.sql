-- CreateTable
CREATE TABLE "BackfillSeenId" (
    "source" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackfillSeenId_pkey" PRIMARY KEY ("source","listingId")
);

-- Copy the existing seen IDs out of the BackfillCursor.seenIds JSON arrays,
-- entirely inside Postgres. The JSON is left in place here (rollback safety);
-- the application clears each source's array after re-copying it on first
-- load, which also picks up IDs written by old code during the deploy.
INSERT INTO "BackfillSeenId" ("source", "listingId")
SELECT DISTINCT c."source", ids.value
FROM "BackfillCursor" c
CROSS JOIN LATERAL jsonb_array_elements_text(c."seenIds") AS ids(value)
WHERE jsonb_typeof(c."seenIds") = 'array'
ON CONFLICT DO NOTHING;
