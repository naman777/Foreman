package store

import "context"

// ArtifactStore handles job output uploads and presigned URL generation.
// Implementation added in Phase 7 using the MinIO Go SDK.
type ArtifactStore interface {
	Upload(ctx context.Context, jobID, filePath string) (string, error)
	GetURL(ctx context.Context, jobID string) (string, error)
}
