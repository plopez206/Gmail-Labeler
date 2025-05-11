import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';

export default function App() {
  const API = import.meta.env.VITE_API_BASE_URL;
  const [connected, setConnected] = useState(false);
  const [results,   setResults]   = useState(null);

  // 1) Al montar, comprobamos estado + query param
  useEffect(() => {
    // Si venimos de Google con ?authed=true
    if (new URLSearchParams(window.location.search).get('authed') === 'true') {
      setConnected(true);
      // limpiamos el query param de la URL
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      // Sino preguntamos al backend
      fetch(`${API}/status`)
        .then(r => r.json())
        .then(json => setConnected(json.connected))
        .catch(() => setConnected(false));
    }
  }, []);

  // 2) Función para run-now
  const runNow = async () => {
    const res = await fetch(`${API}/run-now`, {
        credentials: 'include'
      });      
    const json = await res.json();
    setResults(json.results);
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
