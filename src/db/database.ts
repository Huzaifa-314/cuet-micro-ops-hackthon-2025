import Database from "better-sqlite3";
import { join } from "path";

// Initialize SQLite database
const dbPath = process.env.DB_PATH || join(process.cwd(), "data", "download_jobs.db");
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");

// Create jobs table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS download_jobs (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'completed', 'failed')),
    file_keys TEXT NOT NULL, -- JSON array
    progress INTEGER NOT NULL DEFAULT 0,
    files_completed INTEGER NOT NULL DEFAULT 0,
    total_files INTEGER NOT NULL DEFAULT 0,
    download_url TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Create index for faster queries
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON download_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON download_jobs(created_at DESC);
`);

// Prepared statements for better performance
const insertJob = db.prepare(`
  INSERT INTO download_jobs (
    job_id, status, file_keys, progress, files_completed, total_files,
    download_url, error, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateJob = db.prepare(`
  UPDATE download_jobs SET
    status = ?,
    progress = ?,
    files_completed = ?,
    download_url = ?,
    error = ?,
    updated_at = ?
  WHERE job_id = ?
`);

const getJob = db.prepare(`
  SELECT * FROM download_jobs WHERE job_id = ?
`);

const getAllJobs = db.prepare(`
  SELECT * FROM download_jobs 
  ORDER BY created_at DESC 
  LIMIT ? OFFSET ?
`);

const getJobsByStatus = db.prepare(`
  SELECT * FROM download_jobs 
  WHERE status = ?
  ORDER BY created_at DESC
`);

const getRecentJobs = db.prepare(`
  SELECT * FROM download_jobs 
  ORDER BY created_at DESC 
  LIMIT ?
`);

// Job interface matching the database schema
export interface JobRecord {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  file_keys: string; // JSON string
  progress: number;
  files_completed: number;
  total_files: number;
  download_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// Convert JobRecord to JobStatus format
export function recordToJobStatus(record: JobRecord) {
  return {
    jobId: record.job_id,
    status: record.status,
    fileKeys: JSON.parse(record.file_keys) as string[],
    progress: record.progress,
    filesCompleted: record.files_completed,
    totalFiles: record.total_files,
    downloadUrl: record.download_url || undefined,
    error: record.error || undefined,
    createdAt: new Date(record.created_at),
    updatedAt: new Date(record.updated_at),
  };
}

// Database operations
export const dbOperations = {
  insertJob: (job: {
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
  }) => {
    insertJob.run(
      job.jobId,
      job.status,
      JSON.stringify(job.fileKeys),
      job.progress,
      job.filesCompleted,
      job.totalFiles,
      job.downloadUrl || null,
      job.error || null,
      job.createdAt.toISOString(),
      job.updatedAt.toISOString(),
    );
  },

  updateJob: (jobId: string, updates: {
    status?: "queued" | "processing" | "completed" | "failed";
    progress?: number;
    filesCompleted?: number;
    downloadUrl?: string;
    error?: string;
    updatedAt: Date;
  }) => {
    // Get current job to merge updates
    const current = getJob.get(jobId) as JobRecord | undefined;
    if (!current) return;

    updateJob.run(
      updates.status ?? current.status,
      updates.progress ?? current.progress,
      updates.filesCompleted ?? current.files_completed,
      updates.downloadUrl ?? current.download_url,
      updates.error ?? current.error,
      updates.updatedAt.toISOString(),
      jobId,
    );
  },

  getJob: (jobId: string) => {
    const record = getJob.get(jobId) as JobRecord | undefined;
    return record ? recordToJobStatus(record) : undefined;
  },

  getAllJobs: (limit: number = 100, offset: number = 0) => {
    const records = getAllJobs.all(limit, offset) as JobRecord[];
    return records.map(recordToJobStatus);
  },

  getJobsByStatus: (status: "queued" | "processing" | "completed" | "failed") => {
    const records = getJobsByStatus.all(status) as JobRecord[];
    return records.map(recordToJobStatus);
  },

  getRecentJobs: (limit: number = 50) => {
    const records = getRecentJobs.all(limit) as JobRecord[];
    return records.map(recordToJobStatus);
  },
};

// Close database on process exit
process.on("exit", () => {
  db.close();
});

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});

export default db;


