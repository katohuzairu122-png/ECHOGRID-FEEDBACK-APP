# Security Policy

## Supported version

Security fixes are applied to the current `main` release line. Older deployment versions exist only as short-lived rollback targets.

## Reporting a vulnerability

Report suspected vulnerabilities privately to INFINICUS LLC through the repository owner's private contact channel. Include affected routes, reproduction steps, impact, and proof-of-concept data containing no real customer information. Do not open a public issue for an unpatched vulnerability.

Critical findings block deployment. High findings block launch unless the security owner records an explicit, time-bounded exception.

## Operational response

Credential exposure triggers immediate rotation using [docs/OPERATIONS.md](docs/OPERATIONS.md#secret-rotation-procedure). A vulnerable release may be rolled back using [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#rollback).
