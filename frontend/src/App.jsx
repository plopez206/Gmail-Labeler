import React, { useState } from 'react';

export default function App() {
  const [results, setResults] = useState(null);

  const runNow = async () => {
    const res = await fetch('/run-now');
    const json = await res.json();
    setResults(json);
  };

  return (
    <div className="container py-5">
      <h1>📧 Gmail Automation</h1>
      <div className="mt-4">
        <a href="/auth" className="btn btn-primary me-2">
          🚀 Connect & Subscribe
        </a>
        <button onClick={runNow} className="btn btn-success">
          ⚡ Run Now
        </button>
      </div>
      {results && (
        <pre className="mt-4 bg-light p-3 rounded">
          {JSON.stringify(results, null, 2)}
        </pre>
      )}
    </div>
  );
}
