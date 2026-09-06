import SessionIndicator from "@/app/session-indicator";

export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>Vaccine Assist</h1>
      <SessionIndicator />
      <p>
        Cloud service for the Vaccine Assist desktop app. This is a phase-1
        foundation — the reporting UI is not built yet. See <code>/api</code>{" "}
        routes for the desktop app&apos;s REST endpoints.
      </p>
      <p>
        <a href="/appointments">Scheduling — upcoming appointments</a>
      </p>
      <p>
        <a href="/data-entry">Data entry</a>
      </p>
      <p>
        <a href="/lots">Lots</a>
      </p>
      <p>
        <a href="/vaccines">Active vaccines</a>
      </p>
      <p>
        <a href="/ordering">Ordering</a>
      </p>
      <p>
        <a href="/physicians">Physicians</a>
      </p>
      <p>
        <a href="/settings">Acuity Scheduling settings</a>
      </p>
    </main>
  );
}
