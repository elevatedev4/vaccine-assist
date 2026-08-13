// Test-only stand-in for the "server-only" package. Importing the real
// package throws unconditionally outside Next's server/client build
// boundary (i.e. under plain vitest) — see vitest.config.ts's alias for
// this file. Route-handler tests (e.g. tests/acuity-poll-route.test.ts)
// import route modules that transitively import lib/auth.ts, which
// imports "server-only"; this no-op stand-in lets that import succeed
// under vitest without weakening the real server-only guard in the
// actual Next build (the alias only applies to the vitest config).
export {};
