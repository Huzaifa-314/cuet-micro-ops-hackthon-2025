import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import DownloadJobs from './pages/DownloadJobs';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/download-jobs" replace />} />
            <Route path="/download-jobs" element={<DownloadJobs />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
