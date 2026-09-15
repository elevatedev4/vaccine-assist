/**
 * /install tab (Will's brief verbatim: "Add install instructions for
 * powershell with a copy/paste for the code into an install tab on the
 * cloud") — pure helper that builds the same fresh-install PowerShell
 * one-liner documented in README.md:18-20 and bootstrap-fresh.ps1's own
 * header comment, but with -ServerUrl and -Email filled in for THIS
 * deployment/user instead of the generic placeholders those docs show.
 *
 * Split out as a pure function (rather than inlined in app/install/
 * page.tsx) so the exact string — including the required single quotes
 * around -Password — is unit-testable without React/DOM, same posture
 * as lib/nav-config.ts and lib/macro-dose-button.tsx's other pure
 * exports.
 *
 * -Password is ALWAYS the literal placeholder below, never a real
 * password — see bootstrap-fresh.ps1's own doc comment on why the
 * surrounding quotes must stay single (PowerShell double-quote `$`
 * expansion would silently truncate a real password containing `$`).
 * This page only ever shows the placeholder; the pharmacy's actual
 * shared password is never put on a rendered page.
 */

export const INSTALL_PASSWORD_PLACEHOLDER = "the-shared-password";
export const INSTALL_EMAIL_FALLBACK = "you@orchardsdrug.com";

const BOOTSTRAP_URL = "https://raw.githubusercontent.com/elevatedev4/vaccine-assist/main/bootstrap-fresh.ps1";

export interface BuildInstallOneLinerParams {
  /** This deployment's own origin (window.location.origin at render
   * time) — always THIS server, never the generic doc placeholder. */
  serverUrl: string;
  /** The signed-in user's email, when known; falls back to
   * INSTALL_EMAIL_FALLBACK when there is no session yet. */
  email?: string | null;
}

/** Builds the exact fresh-install-and-launch PowerShell one-liner from
 * README.md:18-20, with -ServerUrl/-Email substituted for this
 * deployment/user and -Password left as the literal, single-quoted
 * placeholder. */
export function buildInstallOneLiner({ serverUrl, email }: BuildInstallOneLinerParams): string {
  const resolvedEmail = email && email.trim() ? email.trim() : INSTALL_EMAIL_FALLBACK;
  return (
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " +
    `& ([scriptblock]::Create((irm ${BOOTSTRAP_URL}))) ` +
    `-Email ${resolvedEmail} -Password '${INSTALL_PASSWORD_PLACEHOLDER}' -ServerUrl ${serverUrl}`
  );
}
