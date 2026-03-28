package worker

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Uploader handles worker-side artifact packaging and upload to MinIO.
type Uploader struct {
	client *minio.Client
	bucket string
}

func NewUploader(endpoint, accessKey, secretKey, bucket string, useSSL bool) (*Uploader, error) {
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}
	return &Uploader{client: cli, bucket: bucket}, nil
}

// UploadArtifacts tars every file found under dirPath and uploads the archive
// to MinIO as "artifacts/<jobID>.tar". Returns the object key, or "" if the
// directory contains no files.
func (u *Uploader) UploadArtifacts(ctx context.Context, jobID, dirPath string) (string, error) {
	var files []string
	_ = filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	if len(files) == 0 {
		return "", nil // nothing to upload
	}

	// Pack into a temp tar file
	tmp, err := os.CreateTemp("", "foreman-artifacts-*.tar")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	tw := tar.NewWriter(tmp)
	for _, f := range files {
		if err := tarFile(tw, f, dirPath); err != nil {
			return "", fmt.Errorf("tar %s: %w", f, err)
		}
	}
	if err := tw.Close(); err != nil {
		return "", err
	}

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	stat, err := tmp.Stat()
	if err != nil {
		return "", err
	}

	objectKey := fmt.Sprintf("artifacts/%s.tar", jobID)
	_, err = u.client.PutObject(ctx, u.bucket, objectKey, tmp, stat.Size(),
		minio.PutObjectOptions{ContentType: "application/x-tar"})
	if err != nil {
		return "", fmt.Errorf("minio put: %w", err)
	}

	slog.Info("artifacts uploaded", "job_id", jobID, "object", objectKey, "files", len(files))
	return objectKey, nil
}

func tarFile(tw *tar.Writer, path, baseDir string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return err
	}

	rel, _ := filepath.Rel(baseDir, path)
	hdr := &tar.Header{
		Name:    strings.ReplaceAll(rel, string(filepath.Separator), "/"),
		Size:    info.Size(),
		Mode:    int64(info.Mode()),
		ModTime: info.ModTime(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}
