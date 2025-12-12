# CUET Micro-Ops Hackathon 2025 - System Architecture

(An high resolution Sequence diagram is given in the same directory)

---

## Sequence Diagram Explanation

The complete system workflow is illustrated in the following sequence diagram:

![Full Sequence Diagram](./full-sequence%20diagram.png)

The sequence diagram shows a four-step asynchronous workflow designed to handle long-running file processing operations without timeout issues. The flow involves multiple components working together to process file downloads efficiently.

### Step 1: User Initiates Download

The process begins when a user triggers a download request through an external application. The user clicks a "Download Order Documents" button, which causes the external application to send a `POST` request to `/v1/download/initiate` through the reverse proxy (Cloudflare/nginx/ALB). The request includes `file_ids` (e.g., `[70000, 70001, 70002]`) and `source_urls`.

The reverse proxy forwards this request to the API Server (Hono), which validates the input using Zod schemas, generates a unique `jobId` (UUID), and creates a job status entry in Redis with `status: "queued"`. The job is then queued in Redis for background processing.

Within 1 second, the API Server returns a response containing the `jobId`, `status: "queued"`, `subscribeUrl` for subscribing to progress updates via Server-Sent Events, and `statusUrl` for polling job status. Upon receiving the response, the external application displays a "Processing..." message to the user.

**Key Point**: The API responds immediately (< 1 second), avoiding any timeout issues with reverse proxies. The actual processing happens asynchronously in the background.

### Step 2: Subscribe to Progress Updates

To provide real-time feedback, the external application establishes a Server-Sent Events (SSE) connection by sending a `GET` request to `/v1/download/subscribe/{jobId}` through the reverse proxy. The reverse proxy forwards the SSE request to the API Server, which opens an SSE connection, establishing a persistent stream that remains open until the job completes or fails. The SSE stream is now connected to the external application via the reverse proxy, ready to receive progress updates.

**Key Point**: SSE provides a one-way communication channel from server to client, allowing real-time progress updates without polling.

### Step 3: Background Processing

While the user waits, a background worker processes the job asynchronously. The Background Worker pulls the job from the Redis queue, retrieves the job data, and updates the job's status to `"processing"` in Redis. The worker then publishes an initial progress event `{progress: 0, status: "processing"}` to the SSE Stream, which is received by the external application.

For each file in the job, the Background Worker sends a `GET` request to retrieve the file from the External File Sources, receives the file data, and stores it in a temporary cache. The file undergoes processing operations including integrity checks (checksum validation), compression (if needed), format validation, and metadata extraction. The processed file is then uploaded to MinIO S3 Storage, and an upload confirmation is received. The worker updates the job progress in Redis (e.g., `{filesCompleted: N, progress: X%}`) and publishes a progress event to the SSE Stream, updating the external application with the current status.

After all files are processed, the Background Worker creates a ZIP archive by merging all processed files and uploads the final archive to MinIO S3 Storage. The worker then generates a presigned URL for the archive from MinIO S3 Storage, set to expire in 1 hour for security purposes. The job status in Redis is updated to `"completed"`, including the `downloadUrl` and `expiresAt` information. A completion event `{status: "completed", downloadUrl}` is published to the SSE Stream, which sends a `complete` event containing the `downloadUrl` to the external application. The external application then displays a "Download Ready" button to the user.

**Key Point**: All processing happens asynchronously in the background, allowing the system to handle long-running operations (10-120 seconds) without blocking HTTP connections or causing timeouts.

### Step 4: User Downloads File

Once processing is complete, the user clicks the "Download Ready" button in the external application, which redirects the user to the presigned S3 URL. A direct file download occurs from MinIO S3 Storage to the user's browser, bypassing the API Server entirely and reducing load while improving performance.

**Key Point**: Using presigned URLs allows direct downloads from S3, offloading the API Server and providing better performance and scalability.

### Component Interactions

The sequence diagram illustrates interactions between the following components:

- **User**: The end user interacting with the external application
- **External Application**: The frontend application that integrates with the download service
- **Reverse Proxy**: Network layer (Cloudflare/nginx/ALB) that routes requests
- **API Server (Hono)**: The main API server handling HTTP requests and SSE connections
- **Redis**: Used for job queueing and status caching
- **Background Worker**: Processes jobs asynchronously
- **External File Sources**: External systems hosting the source files
- **MinIO S3 Storage**: Object storage for processed files and archives
- **SSE Stream**: Server-Sent Events connection for real-time updates

### Benefits of This Architecture

1. **No Timeout Issues**: Immediate API responses prevent reverse proxy timeouts
2. **Real-Time Feedback**: SSE provides live progress updates to users
3. **Scalability**: Asynchronous processing allows horizontal scaling of workers
4. **Reliability**: Job status is persisted in Redis, allowing recovery from failures
5. **Performance**: Direct S3 downloads reduce API Server load
6. **Security**: Presigned URLs with expiration times provide secure, time-limited access

