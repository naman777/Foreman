package store

import (
	"context"
	"fmt"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ArtifactStore generates presigned download URLs for job artifacts in MinIO.
type ArtifactStore interface {
	GetPresignedURL(ctx context.Context, objectKey string, expiry time.Duration) (string, error)
}

type MinioArtifactStore struct {
	client *minio.Client
	bucket string
}

// NewMinioArtifactStore creates a coordinator-side artifact store that can
// generate presigned URLs. It creates the bucket if it does not exist.
func NewMinioArtifactStore(endpoint, accessKey, secretKey, bucket string, useSSL bool) (*MinioArtifactStore, error) {
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio init: %w", err)
	}

	ctx := context.Background()
	exists, err := cli.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("minio bucket check: %w", err)
	}
	if !exists {
		if err := cli.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("minio make bucket: %w", err)
		}
	}

	return &MinioArtifactStore{client: cli, bucket: bucket}, nil
}

// GetPresignedURL returns a time-limited URL for the caller to download the object.
func (m *MinioArtifactStore) GetPresignedURL(ctx context.Context, objectKey string, expiry time.Duration) (string, error) {
	u, err := m.client.PresignedGetObject(ctx, m.bucket, objectKey, expiry, nil)
	if err != nil {
		return "", fmt.Errorf("presign %q: %w", objectKey, err)
	}
	return u.String(), nil
}
