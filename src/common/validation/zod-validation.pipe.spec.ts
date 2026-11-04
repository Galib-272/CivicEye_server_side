import { z } from 'zod';
import { AppException } from '../errors/app-exception';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.strictObject({
  title: z.string().min(5),
  location: z.strictObject({ latitude: z.number().min(-90).max(90) }),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns parsed data for valid input', () => {
    const value = { title: 'Pothole on Road 7', location: { latitude: 23.8 } };
    expect(pipe.transform(value)).toEqual(value);
  });

  it('throws VALIDATION_ERROR with field-level details', () => {
    expect.assertions(3);
    try {
      pipe.transform({ title: 'x', location: { latitude: 120 }, role: 'SUPER_ADMIN' });
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const appError = error as AppException;
      expect(appError.code).toBe('VALIDATION_ERROR');
      expect(appError.details.map((detail) => detail.field ?? '(root)')).toEqual(
        expect.arrayContaining(['title', 'location.latitude', '(root)']),
      );
    }
  });
});
