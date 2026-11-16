# Gate 2 R9 loyalty workload preflight

The existing R9 GitHub Actions job replays the repository migrations into a disposable PostgreSQL 18 database and connects as an unprivileged LOGIN. It now checks representative loyalty statements receive SQLSTATE `42501`. The fixture installs no application grants. The suite in #460 verifies application authorization with a separate database connection model.

| Workflow | Data boundary and required operation classes |
| --- | --- |
| Customer enrollment and wallet | Verified customer subject, target business and membership. Read customer, business, membership and balance. Create membership, consent and account in the owning transaction. |
| Owner loyalty administration | Active business-wide grant. Read/write catalog and settings within the authorized business. |
| Manager cashier activity | Effective grants for the relevant branches. Read scoped audit records. |
| Cashier purchase | Live cashier session, authorized branch, eligible business member. Insert purchase evidence, update balance, append ledger in one transaction. |
| Issue, redeem and confirm | Customer-owned account for claim, authorized business and branch for confirmation. Lock account/reward as applicable, append issuance/redemption and atomically confirm. |

These operation classes describe the application, and do not prescribe unrestricted table privileges. R9 proves the default-denied state. R11 separately proves a disposable per-business login can read only its bound rows. The architecture candidate calls for an owner decision before choosing a database-verifiable identity boundary for a shared Hyperdrive login. The proof here does not certify positive application access under that login, database-level wrong-branch denials or a live cutover.

Next decision: approve the existing broker candidate for a narrowly scoped disposable positive proof, or specify another supported principal binding. Preserve the financial denial contract and keep live grants unchanged.
