import sharp from 'sharp';
import { ImageRejectedError, processImage } from './image-processing';

function photo(format: 'jpeg' | 'png' | 'webp' | 'gif', width = 800, height = 600) {
  const image = sharp({ create: { width, height, channels: 3, background: '#7a8a99' } });
  return (
    format === 'jpeg'
      ? image.jpeg().withExif({
          IFD0: { Make: 'TestCam', Model: 'X1' },
          IFD3: {
            GPSLatitudeRef: 'N',
            GPSLatitude: '23/1 48/1 0/1',
            GPSLongitudeRef: 'E',
            GPSLongitude: '90/1 24/1 0/1',
          },
        })
      : image.toFormat(format)
  ).toBuffer();
}

describe('processImage', () => {
  it('removes all metadata, including GPS, from the stored renditions', async () => {
    const input = await photo('jpeg');
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processImage(input);
    for (const output of [result.display, result.thumbnail]) {
      const metadata = await sharp(output).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    }
    expect(result).toMatchObject({ format: 'jpeg', width: 800, height: 600 });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('downsizes large photos and never enlarges small ones', async () => {
    const large = await processImage(await photo('png', 4000, 3000));
    expect((await sharp(large.display).metadata()).width).toBe(1600);
    expect((await sharp(large.thumbnail).metadata()).width).toBe(400);

    const small = await processImage(await photo('webp', 300, 300));
    expect((await sharp(small.display).metadata()).width).toBe(300);
  });

  it.each([
    ['a text file renamed to .jpg', Buffer.from('this is not an image at all, just text')],
    ['an empty file', Buffer.alloc(0)],
  ])('rejects %s by its content', async (_label, input) => {
    await expect(processImage(input)).rejects.toThrow(ImageRejectedError);
  });

  it('rejects formats outside JPEG, PNG and WebP', async () => {
    await expect(processImage(await photo('gif'))).rejects.toThrow(/Only JPEG, PNG and WebP/);
  });

  it('rejects images too small to show anything', async () => {
    await expect(processImage(await photo('png', 150, 600))).rejects.toThrow(/too small/);
  });

  it('rejects truncated image data', async () => {
    const input = await photo('jpeg');
    await expect(processImage(input.subarray(0, input.length / 3))).rejects.toThrow(
      ImageRejectedError,
    );
  });
});
