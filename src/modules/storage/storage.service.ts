import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';

/** How long signed upload and download links stay valid. */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * Private S3-compatible object storage (SeaweedFS locally, Cloudflare R2 in production).
 * Nothing is publicly readable: browsers upload and download only through short-lived signed
 * URLs issued after an authorization check.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const storage = config.storage;
    this.bucket = storage.bucket;
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
    });
  }

  /**
   * Local development and tests only: create the bucket and allow the web app's origins to
   * upload and download directly (browsers send a CORS preflight for signed PUTs). In
   * staging/production the bucket and the same CORS rule are configured on R2 itself.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.storage.createBucket) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket ${this.bucket}`);
    }
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: this.config.corsOrigins,
              AllowedMethods: ['PUT', 'GET'],
              AllowedHeaders: ['content-type'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    );
  }

  /** Signed PUT URL bound to the declared content type and exact length. */
  presignUpload(key: string, contentType: string, contentLength: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      {
        expiresIn: SIGNED_URL_TTL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  presignDownload(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: SIGNED_URL_TTL_SECONDS,
    });
  }

  /** Size of a stored object, or null if it does not exist. */
  async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? 0;
    } catch {
      return null;
    }
  }

  /** Downloads an object into memory, refusing anything larger than maxBytes. */
  async read(key: string, maxBytes: number): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if ((result.ContentLength ?? 0) > maxBytes || !result.Body) {
      throw new Error('Object is too large or empty');
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error('Object is too large');
    return Buffer.from(bytes);
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
