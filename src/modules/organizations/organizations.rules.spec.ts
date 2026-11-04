import { ORGANIZATION_ROLE_PERMISSIONS, OrganizationPermission } from '../access/permissions';
import { officialDomainSchema } from './organizations.schemas';
import { isOnOfficialDomain } from './organizations.service';

describe('official government domain', () => {
  it.each(['dncc.gov.bd', 'DSCC.GOV.BD', '@ccc.gov.bd', ' rhd.gov.bd '])('accepts %p', (value) => {
    expect(officialDomainSchema.safeParse(value).success).toBe(true);
  });

  it('normalizes case, whitespace and a leading @', () => {
    expect(officialDomainSchema.parse(' @DNCC.Gov.BD ')).toBe('dncc.gov.bd');
  });

  it.each([
    'gmail.com',
    'dncc.gov.bd.attacker.com',
    'gov.bd.example.org',
    'not a domain',
    '.gov.bd',
  ])('rejects %p', (value) => {
    expect(officialDomainSchema.safeParse(value).success).toBe(false);
  });
});

describe('isOnOfficialDomain', () => {
  it('accepts the domain and its subdomains', () => {
    expect(isOnOfficialDomain('mayor@dncc.gov.bd', 'dncc.gov.bd')).toBe(true);
    expect(isOnOfficialDomain('it@mail.dncc.gov.bd', 'dncc.gov.bd')).toBe(true);
    expect(isOnOfficialDomain('MAYOR@DNCC.GOV.BD', 'dncc.gov.bd')).toBe(true);
  });

  it('rejects lookalike and unrelated domains', () => {
    expect(isOnOfficialDomain('x@evildncc.gov.bd', 'dncc.gov.bd')).toBe(false);
    expect(isOnOfficialDomain('x@dncc.gov.bd.attacker.com', 'dncc.gov.bd')).toBe(false);
    expect(isOnOfficialDomain('x@gmail.com', 'dncc.gov.bd')).toBe(false);
  });
});

describe('organization roles', () => {
  it('lets reviewers review and verify work but not manage the organization', () => {
    const reviewer = ORGANIZATION_ROLE_PERMISSIONS.ORG_REVIEWER;
    expect(reviewer.has(OrganizationPermission.ReviewReports)).toBe(true);
    expect(reviewer.has(OrganizationPermission.VerifyWork)).toBe(true);
    expect(reviewer.has(OrganizationPermission.ManageMembers)).toBe(false);
    expect(reviewer.has(OrganizationPermission.ManageProfile)).toBe(false);
    expect(reviewer.has(OrganizationPermission.ManageCategories)).toBe(false);
  });

  it('never lets workers verify work (separation of duties)', () => {
    expect(ORGANIZATION_ROLE_PERMISSIONS.WORKER.has(OrganizationPermission.VerifyWork)).toBe(false);
  });
});
