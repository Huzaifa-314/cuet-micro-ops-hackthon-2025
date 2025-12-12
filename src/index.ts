import { HeadObjectCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "crypto";
import archiver from "archiver";
import { Readable } from "stream";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { sentry } from "@hono/sentry";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { rateLimiter } from "hono-rate-limiter";
import { streamSSE } from "hono/streaming";
// Import database operations
import { dbOperations } from "./db/database.js";

// Helper for optional URL that treats empty string as undefined
const optionalUrl = z
  .string()
  .optional()
  .transform((val) => (val === "" ? undefined : val))
  .pipe(z.url().optional());

// Environment schema
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: optionalUrl,
  S3_BUCKET_NAME: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  SENTRY_DSN: optionalUrl,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
  CORS_ORIGINS: z
    .string()
    .default("*")
    .transform((val) => (val === "*" ? "*" : val.split(","))),
  // Download delay simulation (in milliseconds)
  DOWNLOAD_DELAY_MIN_MS: z.coerce.number().int().min(0).default(10000), // 10 seconds
  DOWNLOAD_DELAY_MAX_MS: z.coerce.number().int().min(0).default(200000), // 200 seconds
  DOWNLOAD_DELAY_ENABLED: z.coerce.boolean().default(true),
});

// Parse and validate environment
const env = EnvSchema.parse(process.env);

// S3 Client for internal operations (uses Docker service name)
const s3Client = new S3Client({
  region: env.S3_REGION,
  ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
  ...(env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

// S3 Client for browser-accessible presigned URLs (uses localhost)
// This ensures presigned URLs work in browsers
// Replace Docker internal hostname with localhost for browser access
const getBrowserEndpoint = (): string => {
  if (!env.S3_ENDPOINT) return "http://localhost:9000";
  // Replace internal Docker hostnames with localhost
  return env.S3_ENDPOINT
    .replace(/http:\/\/delineate-minio:9000/, "http://localhost:9000")
    .replace(/http:\/\/minio:9000/, "http://localhost:9000")
    .replace(/delineate-minio:9000/, "localhost:9000")
    .replace(/minio:9000/, "localhost:9000");
};

const browserS3Client = new S3Client({
  region: env.S3_REGION,
  endpoint: getBrowserEndpoint(),
  ...(env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

// Initialize OpenTelemetry SDK
const otelSDK = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "delineate-hackathon-challenge",
  }),
  traceExporter: new OTLPTraceExporter(),
});
otelSDK.start();

const app = new OpenAPIHono();

// Request ID middleware - adds unique ID to each request
app.use(async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
  (c as any).set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
});

// Security headers middleware (helmet-like)
app.use(secureHeaders());

// CORS middleware
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    exposeHeaders: [
      "X-Request-ID",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
    ],
    maxAge: 86400,
  }),
);

// Request timeout middleware
app.use(timeout(env.REQUEST_TIMEOUT_MS));

// Rate limiting middleware
app.use(
  rateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: "draft-6",
    keyGenerator: (c) =>
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "anonymous",
  }),
);

// OpenTelemetry middleware
app.use(
  httpInstrumentationMiddleware({
    serviceName: "delineate-hackathon-challenge",
  }),
);

// Sentry middleware
app.use(
  sentry({
    dsn: env.SENTRY_DSN,
  }),
);

// Error response schema for OpenAPI
const ErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  })
  .openapi("ErrorResponse");

// Error handler with Sentry
app.onError((err, c) => {
  c.get("sentry").captureException(err);
  const requestId =
    (c.get("requestId" as never) as string | undefined) ??
    c.req.header("x-request-id");
  return c.json(
    {
      error: "Internal Server Error",
      message:
        env.NODE_ENV === "development"
          ? err.message
          : "An unexpected error occurred",
      requestId,
    },
    500,
  );
});

// Schemas
const MessageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi("MessageResponse");

const HealthResponseSchema = z
  .object({
    status: z.enum(["healthy", "unhealthy"]),
    checks: z.object({
      storage: z.enum(["ok", "error"]),
    }),
  })
  .openapi("HealthResponse");

// Job status storage (in-memory cache + SQLite persistence)
interface JobStatus {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  fileKeys: string[];
  progress: number;
  filesCompleted: number;
  totalFiles: number;
  downloadUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory cache for fast access (also persisted to SQLite)
const jobs = new Map<string, JobStatus>();

// Download API Schemas
const DownloadInitiateRequestSchema = z
  .object({
    file_keys: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .openapi({ description: "Array of file keys from source bucket" }),
  })
  .openapi("DownloadInitiateRequest");

const DownloadInitiateResponseSchema = z
  .object({
    jobId: z.string().openapi({ description: "Unique job identifier" }),
    status: z.enum(["queued", "processing"]),
    totalFiles: z.number().int(),
    subscribeUrl: z.string().openapi({ description: "SSE endpoint for progress updates" }),
    statusUrl: z.string().openapi({ description: "Polling endpoint for job status" }),
  })
  .openapi("DownloadInitiateResponse");

const DownloadCheckRequestSchema = z
  .object({
    file_id: z
      .number()
      .int()
      .min(10000)
      .max(100000000)
      .openapi({ description: "Single file ID to check (10K to 100M)" }),
  })
  .openapi("DownloadCheckRequest");

const DownloadCheckResponseSchema = z
  .object({
    file_id: z.number().int(),
    available: z.boolean(),
    s3Key: z
      .string()
      .nullable()
      .openapi({ description: "S3 object key if available" }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
  })
  .openapi("DownloadCheckResponse");

const DownloadStartRequestSchema = z
  .object({
    file_id: z
      .number()
      .int()
      .min(10000)
      .max(100000000)
      .openapi({ description: "File ID to download (10K to 100M)" }),
  })
  .openapi("DownloadStartRequest");

const DownloadStartResponseSchema = z
  .object({
    file_id: z.number().int(),
    status: z.enum(["completed", "failed"]),
    downloadUrl: z
      .string()
      .nullable()
      .openapi({ description: "Presigned download URL if successful" }),
    size: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "File size in bytes" }),
    processingTimeMs: z
      .number()
      .int()
      .openapi({ description: "Time taken to process the download in ms" }),
    message: z.string().openapi({ description: "Status message" }),
  })
  .openapi("DownloadStartResponse");

// Input sanitization for S3 keys - prevent path traversal
const sanitizeS3Key = (fileId: number): string => {
  // Ensure fileId is a valid integer within bounds (already validated by Zod)
  const sanitizedId = Math.floor(Math.abs(fileId));
  // Construct safe S3 key without user-controlled path components
  // Note: Bucket is already 'downloads', so key should be just the filename
  return `${String(sanitizedId)}.zip`;
};

// S3 health check
const checkS3Health = async (): Promise<boolean> => {
  if (!env.S3_BUCKET_NAME) return true; // Mock mode
  try {
    // Use a lightweight HEAD request on a known path
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: "__health_check_marker__",
    });
    await s3Client.send(command);
    return true;
  } catch (err) {
    // NotFound is fine - bucket is accessible
    if (err instanceof Error && err.name === "NotFound") return true;
    // AccessDenied or other errors indicate connection issues
    return false;
  }
};

// S3 availability check
const checkS3Availability = async (
  fileId: number,
): Promise<{
  available: boolean;
  s3Key: string | null;
  size: number | null;
}> => {
  const s3Key = sanitizeS3Key(fileId);

  // If no bucket configured, use mock mode
  if (!env.S3_BUCKET_NAME) {
    const available = fileId % 7 === 0;
    return {
      available,
      s3Key: available ? s3Key : null,
      size: available ? Math.floor(Math.random() * 10000000) + 1000 : null,
    };
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: s3Key,
    });
    const response = await s3Client.send(command);
    return {
      available: true,
      s3Key,
      size: response.ContentLength ?? null,
    };
  } catch {
    return {
      available: false,
      s3Key: null,
      size: null,
    };
  }
};

// Random delay helper for simulating long-running downloads
const getRandomDelay = (): number => {
  if (!env.DOWNLOAD_DELAY_ENABLED) return 0;
  const min = env.DOWNLOAD_DELAY_MIN_MS;
  const max = env.DOWNLOAD_DELAY_MAX_MS;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Routes
const rootRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["General"],
  summary: "Root endpoint",
  description: "Returns a welcome message",
  responses: {
    200: {
      description: "Successful response",
      content: {
        "application/json": {
          schema: MessageResponseSchema,
        },
      },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check endpoint",
  description: "Returns the health status of the service and its dependencies",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
    503: {
      description: "Service is unhealthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

app.openapi(rootRoute, (c) => {
  return c.json({ message: "Hello Hono!" }, 200);
});

app.openapi(healthRoute, async (c) => {
  const storageHealthy = await checkS3Health();
  const status = storageHealthy ? "healthy" : "unhealthy";
  const httpStatus = storageHealthy ? 200 : 503;
  return c.json(
    {
      status,
      checks: {
        storage: storageHealthy ? "ok" : "error",
      },
    },
    httpStatus,
  );
});

// Download API Routes
const downloadInitiateRoute = createRoute({
  method: "post",
  path: "/v1/download/initiate",
  tags: ["Download"],
  summary: "Initiate download job",
  description: "Initiates a download job for multiple IDs",
  request: {
    body: {
      content: {
        "application/json": {
          schema: DownloadInitiateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Download job initiated",
      content: {
        "application/json": {
          schema: DownloadInitiateResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

const downloadCheckRoute = createRoute({
  method: "post",
  path: "/v1/download/check",
  tags: ["Download"],
  summary: "Check download availability",
  description:
    "Checks if a single ID is available for download in S3. Add ?sentry_test=true to trigger an error for Sentry testing.",
  request: {
    query: z.object({
      sentry_test: z.string().optional().openapi({
        description:
          "Set to 'true' to trigger an intentional error for Sentry testing",
      }),
    }),
    body: {
      content: {
        "application/json": {
          schema: DownloadCheckRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Availability check result",
      content: {
        "application/json": {
          schema: DownloadCheckResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(downloadInitiateRoute, async (c) => {
  const { file_keys } = c.req.valid("json");
  
  // Validate file keys exist in source bucket
  const validKeys: string[] = [];
  for (const key of file_keys) {
    try {
      const command = new HeadObjectCommand({
        Bucket: "source",
        Key: key,
      });
      await s3Client.send(command);
      validKeys.push(key);
    } catch {
      // Skip invalid keys
      console.warn(`[Download] File key not found in source bucket: ${key}`);
    }
  }

  if (validKeys.length === 0) {
    return c.json(
      { error: "Validation Error", message: "No valid file keys found in source bucket" },
      400,
    );
  }

  // Generate unique jobId
  const jobId = crypto.randomUUID();
  
  // Create job status
  const jobStatus: JobStatus = {
    jobId,
    status: "queued",
    fileKeys: validKeys,
    progress: 0,
    filesCompleted: 0,
    totalFiles: validKeys.length,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  jobs.set(jobId, jobStatus);

  // Start background processing (non-blocking)
  processDownloadJob(jobId, validKeys).catch((error) => {
    console.error(`[Download] Job ${jobId} failed:`, error);
    const job = jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Unknown error";
      job.updatedAt = new Date();
      
      // Update SQLite
      try {
        dbOperations.updateJob(jobId, {
          status: "failed",
          error: job.error,
          updatedAt: job.updatedAt,
        });
      } catch (dbError) {
        console.error(`[Database] Failed to update job ${jobId}:`, dbError);
      }
    }
  });

  // Return immediately (< 1 second)
  return c.json(
    {
      jobId,
      status: "queued" as const,
      totalFiles: validKeys.length,
      subscribeUrl: `/v1/download/subscribe/${jobId}`,
      statusUrl: `/v1/download/status/${jobId}`,
    },
    200,
  );
});

// Helper: Stream S3 object to buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper: Calculate file checksum
function calculateChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// Background job processing - implements all 4 phases from ARCHITECTURE.md
async function processDownloadJob(jobId: string, fileKeys: string[]): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "processing";
  job.updatedAt = new Date();
  
  // Update SQLite
  try {
    dbOperations.updateJob(jobId, {
      status: "processing",
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    console.error(`[Database] Failed to update job ${jobId}:`, error);
  }

  const tempFiles: Array<{ key: string; data: Buffer; checksum: string }> = [];

  try {
    // ============================================================
    // Phase 1: File Collection
    // ============================================================
    console.log(`[Download] Job ${jobId}: Phase 1 - Collecting files from source bucket...`);
    
    for (let i = 0; i < fileKeys.length; i++) {
      const key = fileKeys[i];
      
      try {
        // Download file from source bucket
        const getCommand = new GetObjectCommand({
          Bucket: "source",
          Key: key,
        });
        
        const response = await s3Client.send(getCommand);
        
        if (!response.Body) {
          throw new Error(`File ${key} has no body`);
        }

        // Convert stream to buffer
        const fileData = await streamToBuffer(response.Body as Readable);
        
        // Verify file exists and is accessible (has data)
        if (fileData.length === 0) {
          throw new Error(`File ${key} is empty`);
        }

        // Calculate checksum for integrity verification
        const checksum = calculateChecksum(fileData);
        
        // Store temporarily in memory (in production, use temp files or Redis)
        tempFiles.push({ key, data: fileData, checksum });
        
        // Update progress (Phase 1: 0-25%)
        job.filesCompleted = i + 1;
        job.progress = Math.round(((i + 1) / fileKeys.length) * 25);
        job.updatedAt = new Date();
        
        console.log(`[Download] Job ${jobId}: Collected ${i + 1}/${fileKeys.length} files (${job.progress}%)`);
        
        // Update SQLite
        try {
          dbOperations.updateJob(jobId, {
            progress: job.progress,
            filesCompleted: job.filesCompleted,
            updatedAt: job.updatedAt,
          });
        } catch (dbError) {
          console.error(`[Database] Failed to update job ${jobId}:`, dbError);
        }
      } catch (error) {
        console.error(`[Download] Job ${jobId}: Failed to collect file ${key}:`, error);
        throw new Error(`Failed to collect file ${key}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    // ============================================================
    // Phase 2: File Processing
    // ============================================================
    console.log(`[Download] Job ${jobId}: Phase 2 - Processing files (integrity check, compression, archiving)...`);
    
    // Verify integrity of all collected files
    for (const file of tempFiles) {
      const currentChecksum = calculateChecksum(file.data);
      if (currentChecksum !== file.checksum) {
        throw new Error(`Integrity check failed for file ${file.key}`);
      }
    }
    
    // Update progress (Phase 2: 25-50%)
    job.progress = 30;
    job.updatedAt = new Date();
    
    // Update SQLite
    dbOperations.updateJob(jobId, {
      progress: 30,
      updatedAt: job.updatedAt,
    });

    // Create ZIP archive in memory
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Compression level (0-9, 6 is balanced)
    });

    const archiveChunks: Buffer[] = [];
    
    // Set up event listeners BEFORE finalizing
    const archivePromise = new Promise<Buffer>((resolve, reject) => {
      archive.on("data", (chunk) => {
        archiveChunks.push(chunk);
      });
      
      archive.on("end", () => {
        const archiveBuffer = Buffer.concat(archiveChunks);
        resolve(archiveBuffer);
      });
      
      archive.on("error", (err) => {
        reject(err);
      });
    });

    // Add all files to archive
    for (const file of tempFiles) {
      archive.append(file.data, { name: file.key });
    }

    // Finalize archive (triggers the events)
    archive.finalize();
    
    // Wait for archive to complete
    const archiveBuffer = await archivePromise;
    
    // Update progress (Phase 2 complete: 50%)
    job.progress = 50;
    job.updatedAt = new Date();
    
    // Update SQLite
    dbOperations.updateJob(jobId, {
      progress: 50,
      updatedAt: job.updatedAt,
    });
    
    console.log(`[Download] Job ${jobId}: Created archive (${archiveBuffer.length} bytes)`);

    // ============================================================
    // Phase 3: Upload to Storage
    // ============================================================
    console.log(`[Download] Job ${jobId}: Phase 3 - Uploading to downloads bucket...`);
    
    const finalKey = `${jobId}.zip`;
    const uploadCommand = new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME || "downloads",
      Key: finalKey,
      Body: archiveBuffer,
      ContentType: "application/zip",
      Metadata: {
        jobId: jobId,
        fileCount: String(fileKeys.length),
        createdAt: new Date().toISOString(),
      },
    });

    await s3Client.send(uploadCommand);
    
    // Update progress (Phase 3 complete: 75%)
    job.progress = 75;
    job.updatedAt = new Date();
    
    // Update SQLite
    try {
      dbOperations.updateJob(jobId, {
        progress: 75,
        updatedAt: job.updatedAt,
      });
    } catch (dbError) {
      console.error(`[Database] Failed to update job ${jobId}:`, dbError);
    }
    
    console.log(`[Download] Job ${jobId}: Uploaded to downloads bucket (${finalKey})`);

    // ============================================================
    // Phase 4: Generate Download URL
    // ============================================================
    console.log(`[Download] Job ${jobId}: Phase 4 - Generating presigned download URL...`);
    
    const presignedCommand = new GetObjectCommand({
      Bucket: env.S3_BUCKET_NAME || "downloads",
      Key: finalKey,
    });

    // Generate presigned URL using browser-accessible client (valid for 1 hour)
    // This ensures the URL works in browsers with correct signature
    const downloadUrl = await getSignedUrl(browserS3Client, presignedCommand, { expiresIn: 3600 });
    
    // Update progress (Phase 4 complete: 100%)
    job.status = "completed";
    job.progress = 100;
    job.downloadUrl = downloadUrl;
    job.updatedAt = new Date();
    
    // Update SQLite
    try {
      dbOperations.updateJob(jobId, {
        status: "completed",
        progress: 100,
        downloadUrl: downloadUrl,
        updatedAt: job.updatedAt,
      });
    } catch (dbError) {
      console.error(`[Database] Failed to update job ${jobId}:`, dbError);
    }

    console.log(`[Download] Job ${jobId} completed successfully. Download URL generated.`);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Unknown error";
    job.updatedAt = new Date();
    
    // Update SQLite
    try {
      dbOperations.updateJob(jobId, {
        status: "failed",
        error: job.error,
        updatedAt: job.updatedAt,
      });
    } catch (dbError) {
      console.error(`[Database] Failed to update job ${jobId}:`, dbError);
    }
    
    console.error(`[Download] Job ${jobId} failed:`, error);
    throw error;
  } finally {
    // Cleanup: Clear temporary files from memory
    tempFiles.length = 0;
  }
}

app.openapi(downloadCheckRoute, async (c) => {
  const { sentry_test } = c.req.valid("query");
  const { file_id } = c.req.valid("json");

  // Intentional error for Sentry testing (hackathon challenge)
  if (sentry_test === "true") {
    throw new Error(
      `Sentry test error triggered for file_id=${String(file_id)} - This should appear in Sentry!`,
    );
  }

  const s3Result = await checkS3Availability(file_id);
  return c.json(
    {
      file_id,
      ...s3Result,
    },
    200,
  );
});

// Download Start Route - simulates long-running download with random delay
const downloadStartRoute = createRoute({
  method: "post",
  path: "/v1/download/start",
  tags: ["Download"],
  summary: "Start file download (long-running)",
  description: `Starts a file download with simulated processing delay.
    Processing time varies randomly between ${String(env.DOWNLOAD_DELAY_MIN_MS / 1000)}s and ${String(env.DOWNLOAD_DELAY_MAX_MS / 1000)}s.
    This endpoint demonstrates long-running operations that may timeout behind proxies.`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: DownloadStartRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Download completed successfully",
      content: {
        "application/json": {
          schema: DownloadStartResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(downloadStartRoute, async (c) => {
  const { file_id } = c.req.valid("json");
  const startTime = Date.now();

  // Get random delay and log it
  const delayMs = getRandomDelay();
  const delaySec = (delayMs / 1000).toFixed(1);
  const minDelaySec = (env.DOWNLOAD_DELAY_MIN_MS / 1000).toFixed(0);
  const maxDelaySec = (env.DOWNLOAD_DELAY_MAX_MS / 1000).toFixed(0);
  console.log(
    `[Download] Starting file_id=${String(file_id)} | delay=${delaySec}s (range: ${minDelaySec}s-${maxDelaySec}s) | enabled=${String(env.DOWNLOAD_DELAY_ENABLED)}`,
  );

  // Simulate long-running download process
  await sleep(delayMs);

  // Check if file is available in S3
  const s3Result = await checkS3Availability(file_id);
  const processingTimeMs = Date.now() - startTime;

  console.log(
    `[Download] Completed file_id=${String(file_id)}, actual_time=${String(processingTimeMs)}ms, available=${String(s3Result.available)}`,
  );

  if (s3Result.available) {
    return c.json(
      {
        file_id,
        status: "completed" as const,
        downloadUrl: `https://storage.example.com/${s3Result.s3Key ?? ""}?token=${crypto.randomUUID()}`,
        size: s3Result.size,
        processingTimeMs,
        message: `Download ready after ${(processingTimeMs / 1000).toFixed(1)} seconds`,
      },
      200,
    );
  } else {
    return c.json(
      {
        file_id,
        status: "failed" as const,
        downloadUrl: null,
        size: null,
        processingTimeMs,
        message: `File not found after ${(processingTimeMs / 1000).toFixed(1)} seconds of processing`,
      },
      200,
    );
  }
});

// List files from source bucket
const listSourceFilesRoute = createRoute({
  method: "get",
  path: "/v1/files",
  tags: ["Files"],
  summary: "List files from source bucket",
  description: "Returns a list of all files available in the source bucket",
  responses: {
    200: {
      description: "List of files",
      content: {
        "application/json": {
          schema: z.object({
            files: z.array(
              z.object({
                key: z.string(),
                size: z.number().int(),
                lastModified: z.string(),
              }),
            ),
          }),
        },
      },
    },
  },
});

app.openapi(listSourceFilesRoute, async (c) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: "source",
    });
    const response = await s3Client.send(command);
    const files =
      response.Contents?.map((obj) => ({
        key: obj.Key ?? "",
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? new Date().toISOString(),
      })).filter((f) => f.key && !f.key.endsWith("/")) ?? [];

    return c.json({ files }, 200);
  } catch (error) {
    console.error("Error listing files:", error);
    return c.json({ error: "Failed to list files", files: [] }, 500);
  }
});

// Generate presigned URL for download
const getDownloadUrlRoute = createRoute({
  method: "get",
  path: "/v1/files/{key}/download",
  tags: ["Files"],
  summary: "Get presigned download URL",
  description: "Generates a presigned URL for downloading a file",
  request: {
    params: z.object({
      key: z.string().openapi({ description: "File key in source bucket" }),
    }),
    query: z.object({
      expiresIn: z.coerce.number().int().min(60).max(3600).default(3600).optional(),
    }),
  },
  responses: {
    200: {
      description: "Presigned URL",
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url(),
            expiresIn: z.number().int(),
          }),
        },
      },
    },
  },
});

app.openapi(getDownloadUrlRoute, async (c) => {
  const { key } = c.req.valid("param");
  const { expiresIn = 3600 } = c.req.valid("query");

  try {
    const sanitizedKey = decodeURIComponent(key).replace(/\.\./g, "").replace(/^\//, "");
    const command = new GetObjectCommand({
      Bucket: "source",
      Key: sanitizedKey,
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn });
    return c.json({ url, expiresIn }, 200);
  } catch (error) {
    console.error("Error generating presigned URL:", error);
    return c.json({ error: "Failed to generate download URL" }, 500);
  }
});

// Batch download URLs
const batchDownloadRoute = createRoute({
  method: "post",
  path: "/v1/files/batch-download",
  tags: ["Files"],
  summary: "Get multiple presigned URLs",
  description: "Generates presigned URLs for multiple files",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            keys: z.array(z.string()).min(1).max(50),
            expiresIn: z.coerce.number().int().min(60).max(3600).default(3600).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Presigned URLs",
      content: {
        "application/json": {
          schema: z.object({
            urls: z.array(
              z.object({
                key: z.string(),
                url: z.string().url(),
              }),
            ),
          }),
        },
      },
    },
  },
});

app.openapi(batchDownloadRoute, async (c) => {
  const { keys, expiresIn = 3600 } = c.req.valid("json");
  try {
    const urls = await Promise.all(
      keys.map(async (key) => {
        const sanitizedKey = decodeURIComponent(key).replace(/\.\./g, "").replace(/^\//, "");
        const command = new GetObjectCommand({
          Bucket: "source",
          Key: sanitizedKey,
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return { key, url };
      }),
    );
    return c.json({ urls }, 200);
  } catch (error) {
    console.error("Error generating batch URLs:", error);
    return c.json({ error: "Failed to generate download URLs" }, 500);
  }
});

// SSE endpoint for progress updates
app.get("/v1/download/subscribe/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  
  return streamSSE(c, async (stream) => {
    // Try memory cache first, then SQLite
    let job = jobs.get(jobId);
    if (!job) {
      job = dbOperations.getJob(jobId);
      if (job) {
        jobs.set(jobId, job);
      }
    }
    if (!job) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "Job not found" }),
      });
      return;
    }

    // Send initial status
    await stream.writeSSE({
      event: "progress",
      data: JSON.stringify({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        filesCompleted: job.filesCompleted,
        totalFiles: job.totalFiles,
      }),
    });

    // Poll for updates
    let lastProgress = job.progress;
    let lastStatus = job.status;
    const interval = setInterval(async () => {
      const currentJob = jobs.get(jobId);
      if (!currentJob) {
        clearInterval(interval);
        return;
      }

      // Send update if progress or status changed
      if (currentJob.progress !== lastProgress || currentJob.status !== lastStatus) {
        const eventType = currentJob.status === "completed" ? "complete" : 
                         currentJob.status === "failed" ? "error" : "progress";
        
        await stream.writeSSE({
          event: eventType,
          data: JSON.stringify({
            jobId: currentJob.jobId,
            status: currentJob.status,
            progress: currentJob.progress,
            filesCompleted: currentJob.filesCompleted,
            totalFiles: currentJob.totalFiles,
            downloadUrl: currentJob.downloadUrl,
            error: currentJob.error,
          }),
        });
        lastProgress = currentJob.progress;
        lastStatus = currentJob.status;

        // Close connection if completed or failed
        if (currentJob.status === "completed" || currentJob.status === "failed") {
          clearInterval(interval);
        }
      }
    }, 1000); // Check every second

    // Cleanup on client disconnect
    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(interval);
    });
  });
});

// Status endpoint for polling
app.get("/v1/download/status/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);
  
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    filesCompleted: job.filesCompleted,
    totalFiles: job.totalFiles,
    downloadUrl: job.downloadUrl, // Presigned S3 URL - browser should redirect to this when status is "completed"
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  });
});

// Proxy download endpoint - streams file from S3 to browser
app.get("/v1/download/file/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = jobs.get(jobId);

  if (!job) {
    return c.json({ error: "Not Found", message: `Job ${jobId} not found` }, 404);
  }

  if (job.status !== "completed") {
    return c.json({ error: "Bad Request", message: `Job ${jobId} is not completed yet` }, 400);
  }

  try {
    const finalKey = `${jobId}.zip`;
    const getCommand = new GetObjectCommand({
      Bucket: env.S3_BUCKET_NAME || "downloads",
      Key: finalKey,
    });

    const response = await s3Client.send(getCommand);

    if (!response.Body) {
      return c.json({ error: "Internal Server Error", message: "File not found in storage" }, 500);
    }

    // Convert Readable stream to a proper Response
    const stream = response.Body as Readable;
    
    // Set headers for file download - use c.body() with headers in third parameter
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${jobId}.zip"`,
      "Cache-Control": "no-cache",
    };
    
    if (response.ContentLength) {
      headers["Content-Length"] = String(response.ContentLength);
    }

    // Return the stream with proper headers - browser will trigger download
    return c.body(stream, 200, headers);
  } catch (error) {
    console.error(`[Download] Failed to stream file for job ${jobId}:`, error);
    return c.json(
      { error: "Internal Server Error", message: "Failed to download file" },
      500,
    );
  }
});

// OpenAPI spec endpoint (disabled in production)
if (env.NODE_ENV !== "production") {
  app.doc("/openapi", {
    openapi: "3.0.0",
    info: {
      title: "Delineate Hackathon Challenge API",
      version: "1.0.0",
      description: "API for Delineate Hackathon Challenge",
    },
    servers: [{ url: "http://localhost:3000", description: "Local server" }],
  });

  // Scalar API docs
  app.get("/docs", Scalar({ url: "/openapi" }));
}

// Graceful shutdown handler
const gracefulShutdown = (server: ServerType) => (signal: string) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log("HTTP server closed");

    // Shutdown OpenTelemetry to flush traces
    otelSDK
      .shutdown()
      .then(() => {
        console.log("OpenTelemetry SDK shut down");
      })
      .catch((err: unknown) => {
        console.error("Error shutting down OpenTelemetry:", err);
      })
      .finally(() => {
        // Destroy S3 client
        s3Client.destroy();
        console.log("S3 client destroyed");
        console.log("Graceful shutdown completed");
      });
  });
};

// Start server
const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${String(info.port)}`);
    console.log(`Environment: ${env.NODE_ENV}`);
    if (env.NODE_ENV !== "production") {
      console.log(`API docs: http://localhost:${String(info.port)}/docs`);
    }
  },
);

// Register shutdown handlers
const shutdown = gracefulShutdown(server);
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
