import { startAuthHarness, tokenFromEmail, type AuthHarness, type Client } from './auth-harness';

type Body<T = Record<string, unknown>> = {
  data: T;
  error?: { code: string; message: string; details: Array<{ field?: string; message: string }> };
};

/** Closed rectangle as a GeoJSON Polygon (WGS84 lon/lat). */
function rectangle(minLon: number, minLat: number, maxLon: number, maxLat: number) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

const NORTH_AREA = rectangle(90.3, 23.75, 90.5, 23.95);
const SOUTH_AREA = rectangle(90.35, 23.65, 90.55, 23.8); // overlaps NORTH_AREA
const POINT_IN_NORTH_ONLY = { latitude: 23.9, longitude: 90.4 };

describe('Organizations, membership, categories and service areas', () => {
  let h: AuthHarness;
  let admin: Client;
  let northId: string;
  let southId: string;
  let northAdmin: Client;

  beforeAll(async () => {
    h = await startAuthHarness();
    admin = await h.superAdmin('root@example.test');
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetRateLimits();
    h.mail.clear();
  });

  async function inviteAndAccept(
    organizationId: string,
    email: string,
    role: 'ORG_ADMIN' | 'ORG_REVIEWER' | 'WORKER',
    inviter: Client = admin,
    path = `/admin/organizations/${organizationId}/invitations`,
  ): Promise<Client> {
    await inviter.post(path, { email, role }).expect(201);
    const token = tokenFromEmail(await h.mail.waitFor(email, /invited to join/));
    const { client } = await h.signedIn(email);
    await client.post('/invitations/accept', { token }).expect(200);
    return client;
  }

  describe('creation and verification', () => {
    it('lets only Super Admins create organizations, on a government domain', async () => {
      const { client: citizen } = await h.signedIn('citizen@example.test');
      await citizen
        .post('/admin/organizations', { name: 'Fake', officialEmailDomain: 'fake.gov.bd' })
        .expect(403);

      const badDomain = await admin
        .post('/admin/organizations', { name: 'Gmail City', officialEmailDomain: 'gmail.com' })
        .expect(400);
      expect((badDomain.body as Body).error?.details[0]?.field).toBe('officialEmailDomain');

      const created = await admin
        .post('/admin/organizations', {
          name: 'Dhaka North City Corporation',
          officialEmailDomain: 'dncc.gov.bd',
          website: 'https://dncc.gov.bd',
        })
        .expect(201);
      const body = created.body as Body<{ id: string; verificationState: string; type: string }>;
      expect(body.data).toMatchObject({
        verificationState: 'UNVERIFIED',
        type: 'CITY_CORPORATION',
      });
      northId = body.data.id;

      await admin
        .post('/admin/organizations', {
          name: 'dhaka north city corporation',
          officialEmailDomain: 'x.gov.bd',
        })
        .expect(409);
    });

    it('requires a confirmed contact on the official domain before verifying', async () => {
      await admin.post(`/admin/organizations/${northId}/verify`, {}).expect(422);

      const wrongDomain = await admin
        .put(`/admin/organizations/${northId}/verification-contact`, {
          name: 'Contact Person',
          jobTitle: 'IT Officer',
          email: 'contact@gmail.com',
        })
        .expect(400);
      expect((wrongDomain.body as Body).error?.details[0]?.field).toBe('email');

      const pending = await admin
        .put(`/admin/organizations/${northId}/verification-contact`, {
          name: 'Contact Person',
          jobTitle: 'IT Officer',
          email: 'it@dncc.gov.bd',
        })
        .expect(200);
      expect((pending.body as Body).data).toMatchObject({
        verificationState: 'PENDING_VERIFICATION',
      });

      // Not confirmed yet.
      await admin.post(`/admin/organizations/${northId}/verify`, {}).expect(422);

      const token = tokenFromEmail(await h.mail.waitFor('it@dncc.gov.bd', /Confirm/));
      await h.client().post('/organization-contacts/confirm', { token }).expect(200);
      await h.client().post('/organization-contacts/confirm', { token }).expect(400);

      const verified = await admin
        .post(`/admin/organizations/${northId}/verify`, {
          reason: 'Domain confirmed by IT officer',
        })
        .expect(200);
      const detail = (
        verified.body as Body<{
          verificationState: string;
          verificationContact: { confirmedAt: string | null };
          verificationHistory: Array<{ toState: string }>;
        }>
      ).data;
      expect(detail.verificationState).toBe('VERIFIED');
      expect(detail.verificationContact.confirmedAt).not.toBeNull();
      expect(detail.verificationHistory.map((record) => record.toState)).toEqual([
        'VERIFIED',
        'PENDING_VERIFICATION',
      ]);
    });

    it('keeps verification history append-only', async () => {
      const record = await h.prisma.organizationVerificationRecord.findFirstOrThrow();
      await expect(
        h.prisma.organizationVerificationRecord.update({
          where: { id: record.id },
          data: { reason: 'x' },
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('lists only verified organizations publicly', async () => {
      const south = await admin
        .post('/admin/organizations', {
          name: 'Dhaka South City Corporation',
          officialEmailDomain: 'dscc.gov.bd',
        })
        .expect(201);
      southId = (south.body as Body<{ id: string }>).data.id;

      const directory = await h.client().get('/organizations').expect(200);
      const names = (directory.body as Body<Array<{ name: string }>>).data.map((o) => o.name);
      expect(names).toEqual(['Dhaka North City Corporation']);
      await h.client().get(`/organizations/${southId}`).expect(404);
      const profile = await h.client().get(`/organizations/${northId}`).expect(200);
      expect(Object.keys((profile.body as Body).data).sort()).toEqual(
        ['description', 'id', 'name', 'publicEmail', 'publicPhone', 'type', 'website'].sort(),
      );
    });
  });

  describe('invitations and membership', () => {
    it('accepts an invitation only for the invited, verified email address', async () => {
      await admin
        .post(`/admin/organizations/${northId}/invitations`, {
          email: 'boss@dncc.gov.bd',
          role: 'ORG_ADMIN',
        })
        .expect(201);
      const token = tokenFromEmail(await h.mail.waitFor('boss@dncc.gov.bd', /invited to join/));

      const { client: stranger } = await h.signedIn('stranger@example.test');
      const wrongUser = await stranger.post('/invitations/accept', { token }).expect(403);
      expect((wrongUser.body as Body).error?.code).toBe('FORBIDDEN');

      await h.createUser({ email: 'boss@dncc.gov.bd', verified: false });
      const unverified = h.client();
      await unverified.login('boss@dncc.gov.bd');
      const notVerified = await unverified.post('/invitations/accept', { token }).expect(403);
      expect((notVerified.body as Body).error?.code).toBe('EMAIL_NOT_VERIFIED');

      await h.prisma.user.update({
        where: { email: 'boss@dncc.gov.bd' },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
      });
      northAdmin = h.client();
      await northAdmin.login('boss@dncc.gov.bd');
      const accepted = await northAdmin.post('/invitations/accept', { token }).expect(200);
      expect((accepted.body as Body).data).toMatchObject({
        organizationId: northId,
        role: 'ORG_ADMIN',
      });
      await northAdmin.post('/invitations/accept', { token }).expect(400);

      const mine = await northAdmin.get('/users/me/organizations').expect(200);
      expect((mine.body as Body<Array<{ id: string; role: string }>>).data).toEqual([
        expect.objectContaining({ id: northId, role: 'ORG_ADMIN' }),
      ]);
    });

    it('rejects expired and revoked invitations', async () => {
      await northAdmin
        .post(`/organizations/${northId}/invitations`, {
          email: 'late@example.test',
          role: 'WORKER',
        })
        .expect(201);
      const expiredToken = tokenFromEmail(await h.mail.waitFor('late@example.test', /invited/));
      await h.prisma.organizationInvitation.updateMany({
        where: { email: 'late@example.test' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const { client: late } = await h.signedIn('late@example.test');
      await late.post('/invitations/accept', { token: expiredToken }).expect(400);

      h.mail.clear();
      const invited = await northAdmin
        .post(`/organizations/${northId}/invitations`, {
          email: 'revoked@example.test',
          role: 'WORKER',
        })
        .expect(201);
      const revokedToken = tokenFromEmail(await h.mail.waitFor('revoked@example.test', /invited/));
      await northAdmin
        .delete(
          `/organizations/${northId}/invitations/${(invited.body as Body<{ id: string }>).data.id}`,
        )
        .expect(200);
      const { client: revoked } = await h.signedIn('revoked@example.test');
      await revoked.post('/invitations/accept', { token: revokedToken }).expect(400);
    });

    it('applies role permissions inside the organization', async () => {
      const reviewer = await inviteAndAccept(
        northId,
        'reviewer@example.test',
        'ORG_REVIEWER',
        northAdmin,
        `/organizations/${northId}/invitations`,
      );
      const worker = await inviteAndAccept(
        northId,
        'worker@example.test',
        'WORKER',
        northAdmin,
        `/organizations/${northId}/invitations`,
      );

      await reviewer.get(`/organizations/${northId}/overview`).expect(200);
      await worker.get(`/organizations/${northId}/members`).expect(200);
      await worker
        .post(`/organizations/${northId}/invitations`, { email: 'x@example.test', role: 'WORKER' })
        .expect(404);
      await reviewer.put(`/organizations/${northId}/categories`, { categoryIds: [] }).expect(404);
      await reviewer.patch(`/organizations/${northId}`, { description: 'x' }).expect(404);
    });

    it('never removes or demotes the last administrator', async () => {
      const members = await northAdmin.get(`/organizations/${northId}/members`).expect(200);
      const self = (members.body as Body<Array<{ id: string; email: string }>>).data.find(
        (member) => member.email === 'boss@dncc.gov.bd',
      );
      const removed = await northAdmin
        .delete(`/organizations/${northId}/members/${self?.id}`)
        .expect(409);
      expect((removed.body as Body).error?.message).toMatch(/at least one administrator/);
      await northAdmin
        .patch(`/organizations/${northId}/members/${self?.id}`, { role: 'WORKER' })
        .expect(409);

      await inviteAndAccept(northId, 'deputy@dncc.gov.bd', 'ORG_ADMIN');
      await northAdmin
        .patch(`/organizations/${northId}/members/${self?.id}`, { role: 'ORG_REVIEWER' })
        .expect(200);
      // Restore for later tests.
      await admin
        .patch(`/admin/organizations/${northId}/members/${self?.id}`, { role: 'ORG_ADMIN' })
        .expect(200);
    });

    it('lets Org Admins edit the profile but not the name or official domain', async () => {
      await northAdmin
        .patch(`/organizations/${northId}`, { description: 'Serves the northern wards.' })
        .expect(200);
      await northAdmin.patch(`/organizations/${northId}`, { name: 'Renamed' }).expect(400);
      await northAdmin
        .patch(`/organizations/${northId}`, { officialEmailDomain: 'evil.gov.bd' })
        .expect(400);
    });
  });

  describe('isolation between organizations', () => {
    it('hides other organizations completely from members and Super Admins', async () => {
      await inviteAndAccept(southId, 'south-admin@example.test', 'ORG_ADMIN');

      // Built lazily: each request must start only after the previous one finished.
      const attempts = [
        () => northAdmin.get(`/organizations/${southId}/overview`),
        () => northAdmin.get(`/organizations/${southId}/members`),
        () => northAdmin.patch(`/organizations/${southId}`, { description: 'hijack' }),
        () =>
          northAdmin.post(`/organizations/${southId}/invitations`, {
            email: 'x@example.test',
            role: 'ORG_ADMIN',
          }),
        () => northAdmin.get('/organizations/not-a-uuid/overview'),
        // Platform role alone grants no access to an organization's workspace.
        () => admin.get(`/organizations/${northId}/overview`),
      ];
      for (const attempt of attempts) {
        const response = await attempt();
        expect(response.status).toBe(404);
        expect((response.body as Body).error?.code).toBe('NOT_FOUND');
      }
      const south = await h.prisma.organization.findUniqueOrThrow({ where: { id: southId } });
      expect(south.description).toBeNull();
    });

    it('blocks members of a suspended organization until it is reactivated', async () => {
      await admin.post(`/admin/organizations/${northId}/suspend`, { reason: 'x' }).expect(400);
      await admin
        .post(`/admin/organizations/${northId}/suspend`, { reason: 'Contract under review' })
        .expect(200);
      await northAdmin.get(`/organizations/${northId}/overview`).expect(404);
      await admin
        .post(`/admin/organizations/${northId}/invitations`, {
          email: 'new@example.test',
          role: 'WORKER',
        })
        .expect(422);
      await h.client().get(`/organizations/${northId}`).expect(404);

      await admin
        .post(`/admin/organizations/${northId}/reactivate`, { reason: 'Review completed' })
        .expect(200);
      await northAdmin.get(`/organizations/${northId}/overview`).expect(200);
    });
  });

  describe('categories', () => {
    it('serves the seeded PRD categories with parents before children', async () => {
      const response = await h.client().get('/categories').expect(200);
      const categories = (
        response.body as Body<
          Array<{ id: string; slug: string; parentId: string | null; nameBn: string }>
        >
      ).data;
      expect(categories).toHaveLength(15);
      expect(categories[0]?.slug).toBe('road-damage');
      expect(categories[1]).toMatchObject({ slug: 'pothole', parentId: categories[0]?.id });
      expect(categories.every((category) => /[ঀ-৿]/.test(category.nameBn))).toBe(true);
    });

    it('lets Org Admins choose active categories only', async () => {
      const all = (await h.client().get('/categories')).body as Body<
        Array<{ id: string; slug: string }>
      >;
      const pothole = all.data.find((category) => category.slug === 'pothole');
      const streetlight = all.data.find((category) => category.slug === 'broken-streetlight');

      const updated = await northAdmin
        .put(`/organizations/${northId}/categories`, {
          categoryIds: [pothole?.id, streetlight?.id],
        })
        .expect(200);
      expect((updated.body as Body<{ categoryIds: string[] }>).data.categoryIds.sort()).toEqual(
        [pothole?.id, streetlight?.id].sort(),
      );

      await admin.patch(`/admin/categories/${streetlight?.id}`, { isActive: false }).expect(200);
      await northAdmin
        .put(`/organizations/${northId}/categories`, { categoryIds: [streetlight?.id] })
        .expect(400);
      const publicList = (await h.client().get('/categories')).body as Body<
        Array<{ slug: string }>
      >;
      expect(publicList.data.map((category) => category.slug)).not.toContain('broken-streetlight');
      await admin.patch(`/admin/categories/${streetlight?.id}`, { isActive: true }).expect(200);
    });

    it('lets Super Admins set an organization’s categories', async () => {
      const all = (await h.client().get('/categories')).body as Body<
        Array<{ id: string; slug: string }>
      >;
      const waterlogging = all.data.find((category) => category.slug === 'waterlogging');
      const response = await admin
        .put(`/admin/organizations/${southId}/categories`, { categoryIds: [waterlogging?.id] })
        .expect(200);
      expect((response.body as Body<{ categoryIds: string[] }>).data.categoryIds).toEqual([
        waterlogging?.id,
      ]);
      await admin
        .put('/admin/organizations/00000000-0000-4000-8000-000000000000/categories', {
          categoryIds: [],
        })
        .expect(404);
    });

    it('keeps categories at most two levels deep', async () => {
      const all = (await h.client().get('/categories')).body as Body<
        Array<{ id: string; slug: string }>
      >;
      const pothole = all.data.find((category) => category.slug === 'pothole');
      const nested = await admin
        .post('/admin/categories', {
          slug: 'deep-pothole',
          nameEn: 'Deep pothole',
          nameBn: 'গভীর গর্ত',
          parentId: pothole?.id,
        })
        .expect(400);
      expect((nested.body as Body).error?.details[0]?.field).toBe('parentId');
    });
  });

  describe('service areas', () => {
    const upload = (organizationId: string, name: string, content: unknown) =>
      admin.upload(
        `/admin/organizations/${organizationId}/service-areas`,
        { name },
        {
          name: 'area.geojson',
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
      );

    it('stores a valid boundary and measures it on the ellipsoid', async () => {
      const response = await upload(northId, 'North wards', {
        type: 'Feature',
        geometry: NORTH_AREA,
      }).expect(201);
      const area = (
        response.body as Body<{
          areaSqKm: number;
          pointCount: number;
          previewGeoJson: { type: string };
        }>
      ).data;
      // 0.2° × 0.2° at about 23.85°N is roughly 20.4 km × 22.1 km.
      expect(area.areaSqKm).toBeGreaterThan(440);
      expect(area.areaSqKm).toBeLessThan(460);
      expect(area.previewGeoJson.type).toBe('MultiPolygon');
    });

    it.each([
      [
        'a self-intersecting ("bow-tie") polygon',
        {
          type: 'Polygon',
          coordinates: [
            [
              [90, 23],
              [91, 24],
              [91, 23],
              [90, 24],
              [90, 23],
            ],
          ],
        },
        /not valid: Self-intersection/,
      ],
      ['coordinates in the wrong order or range', rectangle(23, 190, 24, 191), /longitude/],
      ['a point', { type: 'Point', coordinates: [90.4, 23.8] }, /Only Polygon/],
      ['an area over the limit', rectangle(88, 21, 92.5, 26), /limit is 10000 km²/],
      [
        'a non-WGS84 file',
        { ...NORTH_AREA, crs: { type: 'name', properties: { name: 'EPSG:32646' } } },
        /WGS84/,
      ],
    ])('rejects %s without repairing it', async (_label, content, message) => {
      const response = await upload(northId, 'Rejected', content).expect(400);
      expect((response.body as Body).error?.message).toMatch(message);
    });

    it('rejects files over 5 MB', async () => {
      const huge = JSON.stringify({ ...NORTH_AREA, padding: 'x'.repeat(5 * 1024 * 1024) });
      const response = await upload(northId, 'Huge', huge).expect(413);
      expect((response.body as Body).error?.code).toBe('FILE_TOO_LARGE');
    });

    it('does not let Org Admins draw service areas', async () => {
      await northAdmin
        .upload(
          `/admin/organizations/${northId}/service-areas`,
          { name: 'Mine' },
          { name: 'a.geojson', content: JSON.stringify(NORTH_AREA) },
        )
        .expect(403);
      const listed = await northAdmin.get(`/organizations/${northId}/service-areas`).expect(200);
      expect((listed.body as Body<unknown[]>).data).toHaveLength(1);
    });

    it('reports overlaps between organizations without resolving them', async () => {
      await upload(southId, 'South wards', SOUTH_AREA).expect(201);
      const overlaps = await admin.get('/admin/service-areas/overlaps').expect(200);
      const rows = (
        overlaps.body as Body<
          Array<{ organizationName: string; otherOrganizationName: string; overlapSqKm: number }>
        >
      ).data;
      expect(rows).toHaveLength(1);
      expect([rows[0]?.organizationName, rows[0]?.otherOrganizationName].sort()).toEqual([
        'Dhaka North City Corporation',
        'Dhaka South City Corporation',
      ]);
      expect(rows[0]?.overlapSqKm).toBeGreaterThan(0);
    });

    it('finds verified organizations covering a point, optionally by category', async () => {
      const covering = await h
        .client()
        .post('/locations/organization-match', POINT_IN_NORTH_ONLY)
        .expect(200);
      expect((covering.body as Body<Array<{ name: string }>>).data.map((o) => o.name)).toEqual([
        'Dhaka North City Corporation',
      ]);

      // A point inside both areas: the unverified south organization is never offered.
      const both = await h
        .client()
        .post('/locations/organization-match', { latitude: 23.77, longitude: 90.45 })
        .expect(200);
      expect((both.body as Body<Array<{ name: string }>>).data.map((o) => o.name)).toEqual([
        'Dhaka North City Corporation',
      ]);

      const all = (await h.client().get('/categories')).body as Body<
        Array<{ id: string; slug: string }>
      >;
      const garbage = all.data.find((category) => category.slug === 'garbage-accumulation');
      const filtered = await h
        .client()
        .post('/locations/organization-match', { ...POINT_IN_NORTH_ONLY, categoryId: garbage?.id })
        .expect(200);
      expect((filtered.body as Body<unknown[]>).data).toEqual([]);

      await h
        .client()
        .post('/locations/organization-match', { latitude: 95, longitude: 90 })
        .expect(400);
    });

    it('stops covering a point once the area is deactivated', async () => {
      const areas = await admin.get(`/admin/organizations/${northId}/service-areas`).expect(200);
      const id = (areas.body as Body<Array<{ id: string }>>).data[0]?.id;
      await admin.patch(`/admin/service-areas/${id}`, { isActive: false }).expect(200);
      const covering = await h
        .client()
        .post('/locations/organization-match', POINT_IN_NORTH_ONLY)
        .expect(200);
      expect((covering.body as Body<unknown[]>).data).toEqual([]);
    });
  });

  it('audits organization changes', async () => {
    const actions = await h.prisma.auditLog.findMany({
      select: { action: true },
      distinct: ['action'],
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'organization.created',
        'organization.contact_set',
        'organization.contact_confirmed',
        'organization.verified',
        'organization.suspended',
        'organization.reactivated',
        'organization.invitation_created',
        'organization.invitation_accepted',
        'organization.invitation_revoked',
        'organization.member_role_changed',
        'organization.categories_updated',
        'service_area.created',
        'service_area.updated',
        'category.updated',
      ]),
    );
  });
});
