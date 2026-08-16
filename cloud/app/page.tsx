export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>Vaccine Assist</h1>
      <p>
        Cloud service for the Vaccine Assist desktop app. This is a phase-1
        foundation — the reporting UI is not built yet. See <code>/api</code>{" "}
        routes for the desktop app&apos;s REST endpoints.
      </p>
      <p>
        <a href="/settings">Acuity Scheduling settings</a>
      </p>
    </main>
  );
}
