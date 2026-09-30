# Vaccine Assist — Setup.exe installer channel

An ADDITIONAL way to install/update Vaccine Assist, alongside the existing
`update-and-run.ps1` + desktop shortcut flow described in `README.md` —
that flow keeps working exactly as it does today, unchanged, on any PC
that keeps using it. This is unsigned for now (private-S3, no code-signing
cert yet — see `docs/plans/velopack-installer-plan.md` in manager-app).

## First install (per PC)

1. Download `VaccineAssist-Setup.exe` (link provided separately — the S3
   bucket is private, so there is no public URL to paste here).
2. Run it. Windows SmartScreen will show an "unrecognized app" warning
   (unsigned) — click **More info**, then **Run anyway**. This only
   happens once per PC, on the very first install.
3. The app installs to `%LocalAppData%\VaccineAssist` and launches itself.

After that first run, updates are checked for automatically at startup and
applied silently the next time the app launches — no SmartScreen prompt
again, no action needed.

## The old shortcut still works — but never run both at once

If a PC already has the old `update-and-run.ps1` + Desktop-shortcut
install, it keeps working exactly as before. Do **not** run both the
Setup.exe-installed copy and the old shortcut at the same time on the same
PC — a single-instance lock (mutex) means the second one to start will
just show "Vaccine Assist is already running" and exit; it won't corrupt
anything, but it also won't do anything useful. Pick one per PC.

Both share the exact same `%AppData%\VaccineAssist` (settings, logs,
ledgers) and `%LocalAppData%\VaccineAssist` (autologin, fax PDFs) data —
switching from one install method to the other on the same PC carries
everything over with no migration step.

## Cutting a release

From a normal checkout, on any machine with `git`:

```
git tag v1.0.0
git push --tags
```

Pushing a `v*` tag triggers `.github/workflows/desktop-release.yml`, which
builds, packs (`vpk`), and uploads the installer + update feed to the
private S3 bucket. You can also trigger it manually from the GitHub
Actions tab ("Desktop release" → Run workflow) with a version number, for
a release with no tag.

## One-time repo setup (Will only)

Before the first release, add these under **GitHub → repo Settings →
Secrets and variables → Actions → New repository secret**:

- `DESKTOP_RELEASE_UPLOAD_KEY_ID` — AWS access key id (upload-only IAM
  user, `s3:PutObject`/`s3:ListBucket` on the release bucket)
- `DESKTOP_RELEASE_UPLOAD_SECRET` — that key's secret
- `DESKTOP_RELEASE_BUCKET` — the bucket name (e.g.
  `elevatedev4-desktop-releases`, no `s3://` prefix)

These are separate from the read-only key embedded in the app itself
(`desktop/VaccineAssist.Desktop/Velopack/release-source.json`, never
committed — see that folder's `release-source.example.json` for the
shape) — the CI secrets can write, the embedded key can only read.
