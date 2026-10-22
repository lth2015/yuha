-- Durable backpressure; a short per-provider lock coordinates every worker.
ALTER TABLE generation_jobs
  ADD COLUMN next_run_at DATETIME(3) NULL,
  ADD COLUMN dispatch_started_at DATETIME(3) NULL,
  ADD INDEX jobs_dispatch_idx (provider_id, state, created_at, id)
-- ;;
CREATE TABLE generation_dispatch_gates (
  provider_id VARCHAR(191) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
