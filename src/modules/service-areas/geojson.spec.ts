import { extractPolygons, GeoJsonError } from './geojson';

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [90.3, 23.7],
      [90.5, 23.7],
      [90.5, 23.9],
      [90.3, 23.9],
      [90.3, 23.7],
    ],
  ],
};

describe('extractPolygons', () => {
  it('accepts a bare Polygon or MultiPolygon geometry', () => {
    expect(extractPolygons(JSON.stringify(square))).toEqual([square]);
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates] };
    expect(extractPolygons(JSON.stringify(multi))).toEqual([multi]);
  });

  it('accepts a Feature and a FeatureCollection, keeping only the geometry', () => {
    const feature = { type: 'Feature', properties: { name: 'Ward 1' }, geometry: square };
    expect(extractPolygons(JSON.stringify(feature))).toEqual([square]);
    expect(
      extractPolygons(JSON.stringify({ type: 'FeatureCollection', features: [feature, feature] })),
    ).toEqual([square, square]);
  });

  it('accepts an explicit WGS84 crs member', () => {
    const doc = { ...square, crs: { type: 'name', properties: { name: 'EPSG:4326' } } };
    expect(extractPolygons(JSON.stringify(doc))).toHaveLength(1);
  });

  it.each([
    ['not JSON', 'not json', /not valid JSON/],
    ['a JSON array', '[]', /not a GeoJSON object/],
    ['a Point', JSON.stringify({ type: 'Point', coordinates: [90, 23] }), /Only Polygon/],
    [
      'a LineString feature',
      JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }),
      /Only Polygon/,
    ],
    [
      'an empty collection',
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      /no features/,
    ],
    [
      'a projected coordinate system',
      JSON.stringify({ ...square, crs: { type: 'name', properties: { name: 'EPSG:32646' } } }),
      /WGS84/,
    ],
    ['a feature without geometry', JSON.stringify({ type: 'Feature', geometry: null }), /geometry/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => extractPolygons(text)).toThrow(GeoJsonError);
    expect(() => extractPolygons(text)).toThrow(message);
  });
});
