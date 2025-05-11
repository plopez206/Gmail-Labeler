// src/App.jsx
import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import {
  Spinner,
  Alert,
  Navbar,
  Container,
  Button,
  Card,
  ListGroup,
  Row,
  Col,
  Image
} from 'react-bootstrap';

export default function App() {
  const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  // Check connection status on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('authed') === 'true') {
      setConnected(true);
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      fetch(`${API}/status`, { credentials: 'include' })
        .then(r => r.json())
        .then(json => setConnected(json.count > 0))
        .catch(() => setConnected(false));
    }
  }, [API]);

  // Trigger classification manually
  const runNow = async () => {
    setRunning(true);
    setResults(null);
    setError(null);
    try {
      const res = await fetch(`${API}/run-now`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setResults(json.results || []);
    } catch (err) {
      console.error(err);
      setError('An error occurred while processing your emails.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="d-flex flex-column min-vh-100">
      {/* Navbar with logo */}
      <Navbar bg="dark" variant="dark" expand="lg" sticky="top">
        <Container>
          <Navbar.Brand href="#">
            {/* Simple logo */}
            <Image
              src="/logo192.png"
              alt="MailCortex Logo"
              width={30}
              height={30}
              className="d-inline-block align-top me-2"
            />
            MailCortex
          </Navbar.Brand>
        </Container>
      </Navbar>

      {/* Hero Section */}
      <Container fluid className="bg-light py-5 flex-grow-1">
        <Container>
          <Row className="align-items-center">
            <Col md={6} className="mb-4 mb-md-0">
              <h1 className="display-5 fw-bold">Automate Your Gmail with AI</h1>
              <p className="lead text-muted">
                Let MailCortex sort and label your emails so you can focus on what matters.
              </p>
              {!connected && (
                <Button href={`${API}/auth`} size="lg" variant="primary">
                  Connect & Subscribe
                </Button>
              )}
            </Col>
          </Row>
        </Container>

        {/* Main Dashboard */}
        <Container className="py-5">
          <Card className="shadow-sm">
            <Card.Body>
              <Card.Title className="mb-4">Dashboard</Card.Title>

              {/* Connection Status */}
              <Row className="mb-4">
                <Col>
                  {connected ? (
                    <Alert variant="success" className="mb-0">
                      Connected Successfully
                    </Alert>
                  ) : (
                    <Alert variant="danger" className="mb-0">
                      Not Connected
                    </Alert>
                  )}
                </Col>
              </Row>

              {/* Action Button */}
              <Row className="mb-4">
                <Col>
                  {connected && (
                    <Button
                      onClick={runNow}
                      disabled={running}
                      variant="outline-secondary"
                    >
                      {running ? (
                        <>
                          <Spinner
                            as="span"
                            animation="border"
                            size="sm"
                            role="status"
                            aria-hidden="true"
                            className="me-2"
                          />
                          Processing...
                        </>
                      ) : (
                        'Run Now'
                      )}
                    </Button>
                  )}
                </Col>
              </Row>

              {/* Error Message */}
              {error && (
                <Row className="mb-4">
                  <Col>
                    <Alert variant="warning">{error}</Alert>
                  </Col>
                </Row>
              )}

              {/* Results */}
              {results && (
                <Row>
                  <Col>
                    {results.length === 0 ? (
                      <Alert variant="info">No unread emails found.</Alert>
                    ) : (
                      <ListGroup className="overflow-auto" style={{ maxHeight: '400px' }}>
                        {results.map((r, i) => (
                          <ListGroup.Item
                            key={i}
                            className="d-flex justify-content-between align-items-start"
                          >
                            <div>
                              <strong>{r.subject}</strong>
                              <div className="text-muted small">Label: {r.label}</div>
                            </div>
                          </ListGroup.Item>
                        ))}
                      </ListGroup>
                    )}
                  </Col>
                </Row>
              )}
            </Card.Body>
          </Card>
        </Container>
      </Container>

      {/* Footer at bottom */}
      <footer className="bg-dark text-white text-center py-3 mt-auto">
        <Container>
          <small>&copy; {new Date().getFullYear()} MailCortex. All rights reserved.</small>
        </Container>
      </footer>
    </div>
  );
}