import { validateSep9KycFields } from '../src/services/sep9-kyc-field-validation';

describe('SEP-9 customer information validation', () => {
  it('accepts a minimal valid individual payload', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      payload: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email_address: 'ada@example.com',
        mobile_number: '+14155552671',
      },
    });

    expect(result.payloadValid).toBe(true);
    expect(result.summary.errors).toBe(0);
    expect(result.fieldsPresent).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'email_address', 'mobile_number']),
    );
  });

  it('accepts a minimal valid organization payload', async () => {
    const result = await validateSep9KycFields({
      customerType: 'organization',
      payload: {
        'organization.name': 'Analytical Engines Ltd',
        'organization.VAT_number': 'GB123456789',
        'organization.address_country_code': 'GB',
      },
    });

    expect(result.payloadValid).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it('flags an invalid email address', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      payload: { email_address: 'not-an-email' },
    });

    expect(result.payloadValid).toBe(false);
    expect(result.findings.some((f) => f.code === 'INVALID_EMAIL')).toBe(true);
  });

  it('flags an invalid E.164 phone number', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      payload: { mobile_number: '555-1234' },
    });

    expect(result.findings.some((f) => f.code === 'INVALID_PHONE')).toBe(true);
  });

  it('flags an invalid ISO 8601 birth date', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      payload: { birth_date: '31/12/1990' },
    });

    expect(result.findings.some((f) => f.code === 'INVALID_DATE')).toBe(true);
  });

  it('treats unknown fields permissively by default', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      payload: { email_address: 'a@b.co', unknown_field: 'x' },
    });

    expect(result.findings.some((f) => f.code === 'UNKNOWN_FIELD' && f.severity === 'info')).toBe(true);
    expect(result.payloadValid).toBe(true);
  });

  it('treats unknown fields as warnings in strict mode', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      mode: 'strict',
      payload: { email_address: 'a@b.co', unknown_field: 'x' },
    });

    expect(
      result.findings.some((f) => f.code === 'UNKNOWN_FIELD' && f.severity === 'warning'),
    ).toBe(true);
  });

  it('reports missing context as inconclusive when customer type is absent', async () => {
    const result = await validateSep9KycFields({
      payload: { email_address: 'a@b.co' },
    });

    expect(result.findings.some((f) => f.severity === 'inconclusive')).toBe(true);
  });

  it('honors caller-supplied required fields', async () => {
    const result = await validateSep9KycFields({
      customerType: 'individual',
      requiredFields: ['email_address', 'id_number'],
      payload: { email_address: 'a@b.co' },
    });

    expect(
      result.findings.some(
        (f) => f.code === 'MISSING_REQUIRED_FIELD' && f.field === 'id_number',
      ),
    ).toBe(true);
    expect(result.payloadValid).toBe(false);
  });

  it('rejects malformed JSON', async () => {
    const result = await validateSep9KycFields({ payload: '{"not_json' });
    expect(result.payloadValid).toBe(false);
    expect(result.findings.some((f) => f.code === 'PARSE_ERROR')).toBe(true);
  });

  it('rejects array payloads', async () => {
    const result = await validateSep9KycFields({ payload: [1, 2, 3] });
    expect(result.payloadValid).toBe(false);
  });

  it('never echoes raw field values in findings', async () => {
    const secret = 'secret-email-that-should-not-leak@example.com';
    const result = await validateSep9KycFields({
      customerType: 'individual',
      payload: { email_address: secret.replace('@', '_at_') },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
  });

  it('does not perform any network IO', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await validateSep9KycFields({
      customerType: 'individual',
      payload: { email_address: 'a@b.co' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});