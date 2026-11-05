# Verification record

Date: 5 November 2026. Environment: Windows, Node 24.13.1, Docker Desktop Linux engine 29.2.0. These are local development results, not a production/SLA certification.

- TypeScript check and API/widget build passed.
- 53 automated tests passed with no skipped tests, including the dedicated PostgreSQL integration suite on PostgreSQL 17. The initial checked-in migration was applied successfully to an isolated `kari_test` database.
- Financial tests cover concurrent admission, idempotent settlement, unknown cost held after restart, actual overage accounting, and durable blocking shared by public/owner paths.
- Widget tests cover local movement without fetch, session tokens in memory, safe text rendering, disconnect/abort, duplicate registration, reduced motion and accessible reopen.
- Telegram transport tests use synthetic responses only. Known rejected replies reuse the cached reply without repeating a note write; unknown outcomes are not blindly replayed.
- Runtime and migration Docker images built successfully; the runtime started and served `/kari/api/health` with inference disabled.
- Portfolio image built with embed enabled. `nginx -t` passed. On an isolated Docker network, static portfolio returned 200 without KARI while its API proxy returned 502; after connecting KARI using its service alias, module JS, artwork and a local Genbatik FAQ response were available through the same proxy.
- Compose fallback site JSON parsed correctly. No real provider inference, Telegram messages or WhatsApp messages were sent.
- A fresh-volume Compose deployment initialized separate `kari_admin` and restricted `kari_app` roles. Container-based Prisma migrations and explicit runtime grants succeeded. The running application authenticated as `kari_app`, could create/read/delete its own test note, and was denied both `CREATE TABLE` and access to `_prisma_migrations`; readiness returned `ready`. The migration service received only its admin database URL.

An idle snapshot of the initial runtime image measured approximately 98 MiB for KARI, 14 MiB for Nginx and 42 MiB for the test PostgreSQL container. This was not a load benchmark, and does not establish peak memory on the target 4 GiB VPS. Later code/security changes require the normal regression checks rather than treating this snapshot as a limit guarantee.

Browser visual/mobile QA is incomplete: the browser access host was unavailable, and automatic permission review rejected the attempted Firefox access because that app was not approved. Component/HTTP/container verification was used; no browser-automation bypass was attempted. Inspect both demo pages on desktop/mobile before enabling the widget in production.

AI model availability, retention terms, streaming/tool compatibility, real invoices and live channel onboarding remain operator launch gates. Advanced models, WhatsApp delivery, recurring reminders, browser owner login and independent facial/limb sprite animation are not implemented in release 0.1.
