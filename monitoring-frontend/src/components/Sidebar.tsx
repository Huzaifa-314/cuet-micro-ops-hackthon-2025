import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Sidebar.css';

const Sidebar: React.FC = () => {
  const location = useLocation();

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Admin Panel</h2>
      </div>
      <nav className="sidebar-nav">
        <Link
          to="/download-jobs"
          className={`nav-item ${location.pathname === '/download-jobs' ? 'active' : ''}`}
        >
          <span className="nav-icon">📥</span>
          <span className="nav-text">Download Jobs</span>
        </Link>
      </nav>
    </aside>
  );
};

export default Sidebar;


