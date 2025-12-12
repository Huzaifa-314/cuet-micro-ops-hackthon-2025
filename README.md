# File Download Service

## Scenario

This is a file download service that processes file downloads in the background using queues and background jobs. The service handles variable processing times (ranging from 10 seconds to 120 seconds) and provides users with signed S3 URLs for downloading files once processing is complete. The service integrates with an external frontend application where users interact with the UI, and the frontend communicates with this file download service to initiate and track downloads.

## External Frontend Application

This file download service integrates with an external frontend application:

**Repository**: [cuet-micro-ops-external-frontend](https://github.com/Huzaifa-314/cuet-micro-ops-external-frontend)

Users interact with the external frontend application, which communicates with this file download service to:
- Initiate file downloads
- Check download status
- Retrieve download URLs

The frontend sends API requests to this service, which processes downloads asynchronously and returns signed S3 URLs when ready.

## How to Run the Project

### Prerequisites

- Node.js >= 24.10.0
- npm >= 10.x
- Docker >= 24.x
- Docker Compose >= 2.x

### Local Development (Without Docker)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

   The server will start at `http://localhost:3000`

### Using Docker

#### Development Mode

Start the service with Docker Compose (includes MinIO for S3 storage and Jaeger for tracing):

```bash
npm run docker:dev
```

Or directly with Docker Compose:

```bash
docker compose -f docker/compose.dev.yml up --build
```

This will start:
- File download service on port `3000`
- MinIO (S3-compatible storage) on ports `9000` (API) and `9001` (Console)
- Jaeger (tracing) on port `16686` (UI)

#### Production Mode

Start the service in production mode:

```bash
npm run docker:prod
```

Or directly with Docker Compose:

```bash
docker compose -f docker/compose.prod.yml up --build -d
```

### Access Points

- **API Service**: http://localhost:3000
- **API Documentation**: http://localhost:3000/docs
- **MinIO Console**: http://localhost:9001 (credentials: minioadmin/minioadmin)
- **Jaeger UI** (dev only): http://localhost:16686

## Environment Variables

Create a `.env` file with the following variables:

```env
# Server
NODE_ENV=development
PORT=3000

# S3 Configuration
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET_NAME=downloads
S3_FORCE_PATH_STYLE=true

# Observability (optional)
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Rate Limiting
REQUEST_TIMEOUT_MS=30000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# CORS
CORS_ORIGINS=*

# Download Delay Simulation
DOWNLOAD_DELAY_ENABLED=true
DOWNLOAD_DELAY_MIN_MS=10000
DOWNLOAD_DELAY_MAX_MS=120000
```

## API Endpoints

| Method | Endpoint                | Description                         |
| ------ | ----------------------- | ----------------------------------- |
| GET    | `/`                     | Welcome message                     |
| GET    | `/health`               | Health check with storage status    |
| POST   | `/v1/download/initiate` | Initiate bulk download job          |
| POST   | `/v1/download/check`    | Check single file availability      |
| POST   | `/v1/download/start`    | Start download with simulated delay |

## Available Scripts

```bash
npm run dev          # Start dev server (5-15s delays, hot reload)
npm run start        # Start production server (10-120s delays)
npm run lint         # Run ESLint
npm run lint:fix     # Fix linting issues
npm run format       # Format code with Prettier
npm run format:check # Check code formatting
npm run test:e2e     # Run E2E tests
npm run docker:dev   # Start with Docker (development)
npm run docker:prod  # Start with Docker (production)
```

## Tech Stack

- **Runtime**: Node.js 24 with native TypeScript support
- **Framework**: Hono - Ultra-fast web framework
- **Validation**: Zod with OpenAPI integration
- **Storage**: AWS S3 SDK (S3-compatible with MinIO)
- **Observability**: OpenTelemetry + Jaeger
- **Error Tracking**: Sentry

## License

MIT
