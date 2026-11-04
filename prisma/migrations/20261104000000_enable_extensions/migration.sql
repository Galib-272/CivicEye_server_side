-- Phase 1: enable the PostgreSQL extensions CivicEye depends on.
-- postgis: spatial types and operations (EPSG:4326 service areas and report locations).
-- pg_trgm: trigram text similarity for duplicate candidate generation.
-- citext: case-insensitive email identity keys.
-- No domain tables are created in Phase 1.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

