package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	coordinatorURL := mustEnv("COORDINATOR_URL")
	secret := mustEnv("COORDINATOR_SECRET")

	slog.Info("worker starting", "coordinator", coordinatorURL)
	_ = secret

	// TODO: Phase 4
	// 1. loadOrGenerateWorkerID()
	// 2. registerWithCoordinator(id)
	// 3. go heartbeatLoop(id)
	// 4. go pollForJobs(id)

	<-ctx.Done()
	slog.Info("worker shutting down")
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("required env var not set", "key", key)
		os.Exit(1)
	}
	return v
}
