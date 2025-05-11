import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';

export default function App() {
  const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
  const [connected, setConnected] = useState(false);
  const [results,   setResults]   = useState(null);

  // 1) On mount, check for ?authed=true then fall back to /status
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('authed') === 'true') {
      setConnected(true);
      // remove query param without reloading
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      fetch(`${API}/status`, {
        credentials: 'include'
      })
      .then(r => r.json())
      .then(json => setConnected(json.connected))
      .catch(() => setConnected(false));
    }
  }, [API]);

  // 2) run-now must also include credentials
  const runNow = async () => {
    setResults(null);
    try {
      const res = await fetch(`${API}/run-now`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setResults(json.results);
    } catch (err) {
      console.error('Run Now failed:', err);
      setResults([]);
    }
  };

  return (
    <div className="container py-4">
      <h1>Gmail Automation</h1>

      {!connected && (
        <a href={`${API}/auth`} className="btn btn-primary">
          Connect &amp; Subscribe
        </a>
      )}

      {connected && (
        <button
          onClick={runNow}
          className="btn btn-secondary"
        >
          Run Now
        </button>
      )}

      {results && (
        results.length === 0
          ? <div className="alert alert-info mt-4">No unread emails found.</div>
          : <pre className="mt-4">{JSON.stringify(results, null, 2)}</pre>
      )}
    </div>
  );
}
