/**
 * Extracts polygon geometries from an uploaded GeoJSON document (RFC 7946). Accepts a Polygon
 * or MultiPolygon geometry, a Feature, or a FeatureCollection of such features. Coordinates
 * must be WGS84 longitude/latitude, as RFC 7946 requires; legacy "crs" members naming any other
 * system are rejected rather than guessed at.
 */

export class GeoJsonError extends Error {}

type Json = Record<string, unknown>;

const POLYGON_TYPES = new Set(['Polygon', 'MultiPolygon']);
const WGS84_CRS_NAMES = new Set([
  'urn:ogc:def:crs:OGC:1.3:CRS84',
  'urn:ogc:def:crs:EPSG::4326',
  'EPSG:4326',
]);

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWgs84(document: Json): void {
  if (!('crs' in document)) return;
  const crs = document['crs'];
  const name = isObject(crs) && isObject(crs['properties']) ? crs['properties']['name'] : undefined;
  if (typeof name !== 'string' || !WGS84_CRS_NAMES.has(name)) {
    throw new GeoJsonError('Coordinates must be WGS84 longitude/latitude (EPSG:4326).');
  }
}

function polygonGeometry(geometry: unknown): Json {
  if (!isObject(geometry) || typeof geometry['type'] !== 'string') {
    throw new GeoJsonError('Every feature must have a geometry.');
  }
  if (!POLYGON_TYPES.has(geometry['type'])) {
    throw new GeoJsonError(
      `Only Polygon and MultiPolygon shapes are allowed (found ${geometry['type']}).`,
    );
  }
  if (!Array.isArray(geometry['coordinates'])) {
    throw new GeoJsonError('The geometry has no coordinates.');
  }
  return { type: geometry['type'], coordinates: geometry['coordinates'] };
}

export function extractPolygons(text: string): Json[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new GeoJsonError('The file is not valid JSON.');
  }
  if (!isObject(document)) throw new GeoJsonError('The file is not a GeoJSON object.');
  assertWgs84(document);

  switch (document['type']) {
    case 'Polygon':
    case 'MultiPolygon':
      return [polygonGeometry(document)];
    case 'Feature':
      return [polygonGeometry(document['geometry'])];
    case 'FeatureCollection': {
      const features = document['features'];
      if (!Array.isArray(features) || features.length === 0) {
        throw new GeoJsonError('The FeatureCollection has no features.');
      }
      return features.map((feature) =>
        polygonGeometry(isObject(feature) ? feature['geometry'] : undefined),
      );
    }
    case 'Point':
    case 'MultiPoint':
    case 'LineString':
    case 'MultiLineString':
    case 'GeometryCollection':
      return [polygonGeometry(document)];
    default:
      throw new GeoJsonError('Expected a Polygon, MultiPolygon, Feature or FeatureCollection.');
  }
}
