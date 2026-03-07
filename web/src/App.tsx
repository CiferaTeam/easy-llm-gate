import { useEffect, useState } from "react";

export function App() {
  const [health, setHealth] = useState<string>("checking...");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d.status))
      .catch(() => setHealth("unreachable"));
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>LLM Rate Gate</h1>
      <p>Admin backend: <strong>{health}</strong></p>
      <p style={{ color: "#888" }}>
        Proxy API: <code>http://localhost:16890</code> | Admin API: <code>http://localhost:16891</code>
      </p>
    </div>
  );
}
