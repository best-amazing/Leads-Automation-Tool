# UI Design Brief: Server + Client Overview

## Project structure

### Server

- `server/`
  - `index.ts` — main server entry point
  - `package.json`, `tsconfig.json`, `.env`, `docker-compose.yaml`
  - `prisma/`
    - `schema.prisma` — database schema definitions for listings, properties, filters, etc.
    - `migrations/`
  - `src/`
    - `api/`
      - `index.ts` — Express router for API routes under `/api/v1`
      - `handlers/`
        - `get-all-properties/`
          - `get-all-properties-v1.ts` — handler for `GET /api/v1/properties`
        - `get-all-listings/`
          - `get-all-listings.v1.ts` — handler for `GET /api/v1/listings`
        - `filters/`
          - `filters.v1.ts` — handler for `GET /api/v1/filters` and `PUT /api/v1/filters`
        - `index.ts` — barrel exports for handlers
    - `db/`
      - `repository.ts` — data access layer using Prisma, includes:
        - `getAllPropertiesWithListings`
        - `getAllListings`
        - `upsertFilter`
        - `getFilter`
    - `utils/` — utility modules such as logger
    - other backend logic and runner code for scraping

### Client

- `client/`
  - `package.json`, `tsconfig.json`, `vite.config.ts`, Tailwind config
  - `index.html` — app shell
  - `src/`
    - `main.tsx` — React application bootstrap
    - `App.tsx` — top-level React component / placeholder UI
    - `App.css`, `index.css` — styles
    - `services/`
      - `api.ts` — typed client API wrapper for backend calls
      - `types.ts` — shared response and model interfaces
      - `index.ts` — exports common service functions and types

## API endpoints

All endpoints are mounted under the `/api/v1` base path.

### 1. `GET /api/v1/properties`

Purpose: return all saved properties with their related listings and estimate metadata.

Query parameters:
- `limit` (optional) — maximum number of records to return, default `1000`, capped at `10000`

Response shape:
```json
{
  "status": "ok",
  "data": {
    "count": 123,
    "properties": [
      {
        "id": "...",
        "normalizedAddress": "...",
        "address": "...",
        "city": "...",
        "state": "...",
        "zip": "...",
        "latitude": 41.5,
        "longitude": -81.7,
        "listings": [
          {
            "id": "...",
            "url": "...",
            "source": "craigslist",
            "title": "...",
            "price": 120000,
            "rawAddress": "...",
            "location": "Cleveland, OH",
            "propertyType": "single_family",
            "bedrooms": 3,
            "bathrooms": 2,
            "squareFeet": 1500,
            "description": "...",
            "dealScore": "...",
            "equityEstimate": 30000,
            "createdAt": "...",
            "updatedAt": "..."
          }
        ],
        "estimates": [
          {
            "id": "...",
            "source": "zillow",
            "value": 150000,
            "fetchedAt": "..."
          }
        ]
      }
    ]
  },
  "message": "Retrieved 123 properties with listings and estimates"
}
```

### 2. `GET /api/v1/listings`

Purpose: return all listing records with related property reference data.

Query parameters:
- `limit` (optional) — maximum number of records to return, default `1000`, capped at `10000`

Response shape:
```json
{
  "status": "ok",
  "data": {
    "count": 123,
    "listings": [
      {
        "id": "...",
        "url": "...",
        "source": "craigslist",
        "title": "...",
        "price": 120000,
        "rawAddress": "...",
        "location": "Cleveland, OH",
        "propertyType": "single_family",
        "bedrooms": 3,
        "bathrooms": 2,
        "squareFeet": 1500,
        "description": "...",
        "dealScore": "...",
        "equityEstimate": 30000,
        "createdAt": "...",
        "updatedAt": "...",
        "property": {
          "id": "...",
          "normalizedAddress": "...",
          "address": "...",
          "city": "...",
          "state": "...",
          "zip": "...",
          "latitude": 41.5,
          "longitude": -81.7
        }
      }
    ]
  },
  "message": "Retrieved 123 listings with property data"
}
```

### 3. `GET /api/v1/filters`

Purpose: return the single saved filter record, if any.

Response shape:
```json
{
  "status": "ok",
  "data": {
    "id": "...",
    "name": "Cleveland Under $150k",
    "description": "...",
    "source": "craigslist",
    "minPrice": 0,
    "maxPrice": 150000,
    "propertyTypes": ["single_family"],
    "locations": ["Cleveland, OH"],
    "keywords": ["investment"],
    "excludeKeywords": ["lease"],
    "postedAfter": "2026-01-01T00:00:00.000Z",
    "postedBefore": null,
    "minBedrooms": 2,
    "maxBedrooms": 4,
    "minBathrooms": 1,
    "maxBathrooms": 3,
    "minSquareFeet": 900,
    "maxSquareFeet": 2500,
    "minEquity": 20000,
    "minArv": 120000,
    "isActive": true,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "message": "Filter retrieved successfully"
}
```

If no filter exists, `data` is `null` and the response still returns `status: "ok"`.

### 4. `PUT /api/v1/filters`

Purpose: create or update the single saved filter record. The backend uses a singleton pattern so only one filter record is kept.

Request body:
```json
{
  "name": "Cleveland Under $150k",
  "source": "craigslist",
  "description": "...",
  "minPrice": 0,
  "maxPrice": 150000,
  "propertyTypes": ["single_family"],
  "locations": ["Cleveland, OH"],
  "keywords": ["investment"],
  "excludeKeywords": ["lease"],
  "postedAfter": "2026-01-01T00:00:00.000Z",
  "postedBefore": null,
  "minBedrooms": 2,
  "maxBedrooms": 4,
  "minBathrooms": 1,
  "maxBathrooms": 3,
  "minSquareFeet": 900,
  "maxSquareFeet": 2500,
  "minEquity": 20000,
  "minArv": 120000,
  "isActive": true
}
```

Response shape:
```json
{
  "status": "ok",
  "data": {
    "id": "...",
    "name": "Cleveland Under $150k",
    "source": "craigslist",
    ...
  },
  "message": "Filter saved successfully"
}
```

## Client service layer

The client uses a typed `services/` folder.

- `client/src/services/types.ts` defines:
  - `ApiResponse<Data>`
  - `FilterCriteria`
  - `SavedFilter`
  - `Listing`, `ListingProperty`, `PropertyListing`, `PropertyEstimate`, `Property`
  - `ListingsPayload`, `PropertiesPayload`
- `client/src/services/api.ts` defines wrapper functions:
  - `getAllListings(limit?)`
  - `getAllProperties(limit?)`
  - `getFilter()`
  - `updateFilter(filter)`
- `client/src/services/index.ts` re-exports service functions and types for easy import.

## UI design considerations

- A `Properties` page should display the property list from `GET /api/v1/properties`, including nested listing and estimate details.
- A `Listings` page should display the flattened listing view from `GET /api/v1/listings`, with related property context visible.
- A `Filter` editor page should load the current saved filter from `GET /api/v1/filters` and save changes with `PUT /api/v1/filters`.
- The filter model is singleton-backed, so the UI should treat it as a single active configuration rather than a list of filters.
- Use the `services/api.ts` functions to keep API calls centralized and typed.

## Notes

- The server currently uses a single filter record pattern: `upsertFilter` will create the filter if none exists and update the existing one if present.
- The client API base path is configured as `/api/v1`.
- The frontend currently has a placeholder `App.tsx`, so UI design should wire into the new `services` layer.
