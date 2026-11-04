# PostgreSQL 17 with PostGIS 3 for local development and integration tests.
#
# The upstream postgis/postgis images are published for amd64 only, so they do not run
# natively on Apple silicon. This builds the same stack on the official multi-architecture
# postgres image, installing PostGIS from the PostgreSQL Global Development Group (PGDG)
# apt repository that the postgres image already configures.
FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*
