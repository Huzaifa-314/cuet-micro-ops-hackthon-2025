import React, { useState, useEffect } from 'react';
import './DownloadJobs.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000';

interface DownloadJob {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  filesCompleted: number;
  totalFiles: number;
  downloadUrl?: string;
  error?: string;
  fileKeys: string[];
  createdAt: string;
  updatedAt: string;
}

const DownloadJobs: React.FC = () => {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchJobs = async () => {
    try {
      const response = await fetch(`${API_URL}/v1/download/jobs`);
      if (!response.ok) {
        throw new Error('Failed to fetch jobs');
      }
      const data = await response.json();
      setJobs(data.jobs || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
      console.error('Error fetching jobs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    // Poll every 2 seconds for real-time updates
    const interval = setInterval(fetchJobs, 2000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return '#10b981';
      case 'processing':
        return '#3b82f6';
      case 'queued':
        return '#f59e0b';
      case 'failed':
        return '#ef4444';
      default:
        return '#6b7280';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <div className="page-container">
        <h1>Download Jobs</h1>
        <div className="loading">Loading jobs...</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Download Jobs</h1>
        <button onClick={fetchJobs} className="refresh-btn">
          🔄 Refresh
        </button>
      </div>

      {error && (
        <div className="error-message">
          Error: {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="empty-state">
          <p>No download jobs found.</p>
        </div>
      ) : (
        <div className="jobs-table-container">
          <table className="jobs-table">
            <thead>
              <tr>
                <th>Job ID</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Files</th>
                <th>Created At</th>
                <th>Updated At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId}>
                  <td className="job-id">{job.jobId.substring(0, 8)}...</td>
                  <td>
                    <span
                      className="status-badge"
                      style={{ backgroundColor: getStatusColor(job.status) }}
                    >
                      {job.status}
                    </span>
                  </td>
                  <td>
                    <div className="progress-container">
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <span className="progress-text">{job.progress}%</span>
                    </div>
                  </td>
                  <td>{job.filesCompleted}/{job.totalFiles}</td>
                  <td className="date-cell">{formatDate(job.createdAt)}</td>
                  <td className="date-cell">{formatDate(job.updatedAt)}</td>
                  <td>
                    {job.status === 'completed' && job.downloadUrl && (
                      <a
                        href={job.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="download-link"
                      >
                        Download
                      </a>
                    )}
                    {job.status === 'failed' && job.error && (
                      <span className="error-text" title={job.error}>
                        Error
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DownloadJobs;

