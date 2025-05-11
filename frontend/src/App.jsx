// src/App.jsx
import { useState } from 'react'
import 'bootstrap/dist/css/bootstrap.min.css'

export default function App() {
  const API = import.meta.env.VITE_API_BASE_URL
  const [results, setResults] = useState(null)

  const runNow = async () => {
    const res = await fetch(`${API}/run-now`)
    const json = await res.json()
    setResults(json)
  }

  return (
    <div className="container py-4">
      <h1>Gmail Automation</h1>
      {/* Absolute link to your backend */}
      <a
        href={`${API}/auth`}
        className="btn btn-primary me-2"
      >
        Connect &amp; Subscribe
      </a>

      <button
        onClick={runNow}
        className="btn btn-secondary"
      >
        Run Now
      </button>

      {results && (
        <pre className="mt-4">
          {JSON.stringify(results, null, 2)}
        </pre>
      )}
    </div>
  )
}
