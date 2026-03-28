package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/namankundra/foreman/internal/api"
	"github.com/namankundra/foreman/internal/monitor"
	"github.com/namankundra/foreman/internal/scheduler"
	"github.com/namankundra/foreman/internal/store"
	"github.com/redis/go-redis/v9"
)

func main() {
	_ = godotenv.Load()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Postgres
	dbURL := mustEnv("DATABASE_URL")
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		slog.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		slog.Error("postgres ping failed", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to postgres")

	// Redis
	redisURL := mustEnv("REDIS_URL")
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		slog.Error("invalid redis url", "error", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opts)
	defer rdb.Close()

	if err := rdb.Ping(ctx).Err(); err != nil {
		slog.Error("redis ping failed", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to redis")

	s := store.New(pool)

	// MinIO artifact store (optional — coordinator starts without it if env vars are absent)
	var artifacts store.ArtifactStore
	if endpoint := os.Getenv("MINIO_ENDPOINT"); endpoint != "" {
		as, err := store.NewMinioArtifactStore(
			endpoint,
			getEnv("MINIO_ACCESS_KEY", "minioadmin"),
			getEnv("MINIO_SECRET_KEY", "minioadmin"),
			getEnv("MINIO_BUCKET", "foreman-artifacts"),
			os.Getenv("MINIO_USE_SSL") == "true",
		)
		if err != nil {
			slog.Warn("artifact storage unavailable", "error", err)
		} else {
			artifacts = as
			slog.Info("artifact storage ready", "endpoint", endpoint)
		}
	}

	// Background services
	mon := monitor.New(s)
	go mon.Run(ctx)

	maxParallel := envInt("MAX_PARALLEL_JOBS_PER_WORKER", 4)
	sched := scheduler.New(s, rdb, maxParallel)
	go sched.Run(ctx)

	// HTTP server
	port := getEnv("PORT", "8080")
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", port),
		Handler:      api.NewRouter(s, artifacts),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		slog.Info("coordinator listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down coordinator...")

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(shutCtx)
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("required env var not set", "key", key)
		os.Exit(1)
	}
	return v
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
