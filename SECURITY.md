# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through GitHub's private
vulnerability reporting:

**Repository → Security → Advisories → Report a vulnerability**

(<https://github.com/soult-io/payroll-app/security/advisories/new>)

Please do **not** open a public issue for a vulnerability. We will acknowledge
your report as quickly as we can and coordinate a fix and disclosure timeline
with you.

## Scope

This is a **self-hosted** application — each operator runs their own instance
and is responsible for their own deployment (TLS termination, network
exposure, secrets hygiene). In scope:

- Vulnerabilities in the application code in this repository (auth, session
  handling, authorization/RBAC, injection, data exposure between roles,
  integrity of the payroll math and issued-run immutability).
- The reference deployment artifacts (`Dockerfile`, `compose.example.yml`)
  where they would lead an operator following the docs into an insecure setup.

Out of scope:

- The maintainers' own QA/production instances — they are not a target, and
  testing against them is not authorized.
- Issues requiring already-authenticated admin access (the admin is trusted
  by design), physical/host access, or vulnerabilities in third-party
  dependencies without a demonstrated exploit path through this app.

## Supported versions

Only the latest release tag is supported with security fixes. Run a pinned
release (`:vX.Y.Z`), not `:latest`, and follow releases for updates.
