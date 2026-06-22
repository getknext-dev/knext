/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/redis/go-redis/v9"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
)

// DefaultCleaner is the production ExternalCleaner.
//
// Storage: an S3-compatible delete restricted to the app's Prefix. For
// non-S3-compatible providers (e.g. Azure, GCS via native APIs) we no-op with a
// logged warning rather than guess at credentials/endpoints — see CleanupStorage.
//
// Cache: go-redis SCAN MATCH "<KeyPrefix>:*" + batched DEL — never FLUSHDB.
//
// Cross-app safety: both methods are driven ONLY by the per-app StorageTarget /
// CacheTarget the reconciler constructs (app-scoped Prefix / KeyPrefix). This
// type contains no bucket-wide or wildcard delete path.
type DefaultCleaner struct{}

// NewDefaultCleaner returns the production cleaner.
func NewDefaultCleaner() *DefaultCleaner { return &DefaultCleaner{} }

// s3DeleteBatchSize is the S3 DeleteObjects API maximum (1000 keys/request).
const s3DeleteBatchSize = 1000

// redisScanBatch is the Redis SCAN COUNT hint / DEL batch size.
const redisScanBatch = 500

// CleanupStorage deletes only the objects under s.Prefix in s.Bucket using an
// S3-compatible client. Providers known to be S3-compatible: "s3", "minio".
// Anything else is a no-op + warning (we never guess another provider's API).
func (c *DefaultCleaner) CleanupStorage(ctx context.Context, s StorageTarget) error {
	logger := logf.FromContext(ctx)

	switch s.Provider {
	case "s3", "minio":
		// S3-compatible path below.
	default:
		logger.Info("Storage provider is not S3-compatible; skipping object-store cleanup (no-op)",
			"provider", s.Provider, "bucket", s.Bucket)
		return nil
	}

	if s.Prefix == "" {
		// Defensive: the reconciler always supplies a non-empty app prefix. An
		// empty prefix would be a bucket-wide list/delete — refuse it.
		return fmt.Errorf("refusing object-store cleanup with empty prefix (cross-app safety)")
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if s.Region != "" {
			o.Region = s.Region
		}
		if s.Endpoint != "" {
			o.BaseEndpoint = &s.Endpoint
			o.UsePathStyle = true // MinIO / S3-compatible endpoints
		}
	})

	var deleted int
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: &s.Bucket,
		Prefix: &s.Prefix, // SCOPE: only this app's prefix is ever listed.
	})

	var batch []s3types.ObjectIdentifier
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		_, derr := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: &s.Bucket,
			Delete: &s3types.Delete{Objects: batch},
		})
		if derr != nil {
			return fmt.Errorf("delete objects under %q: %w", s.Prefix, derr)
		}
		deleted += len(batch)
		batch = batch[:0]
		return nil
	}

	for paginator.HasMorePages() {
		page, perr := paginator.NextPage(ctx)
		if perr != nil {
			return fmt.Errorf("list objects under %q: %w", s.Prefix, perr)
		}
		for i := range page.Contents {
			batch = append(batch, s3types.ObjectIdentifier{Key: page.Contents[i].Key})
			if len(batch) >= s3DeleteBatchSize {
				if err := flush(); err != nil {
					return err
				}
			}
		}
	}
	if err := flush(); err != nil {
		return err
	}

	logger.Info("Deleted object-store keys", "bucket", s.Bucket, "prefix", s.Prefix, "count", deleted)
	return nil
}

// CleanupCache deletes only the Redis keys under c.KeyPrefix using SCAN MATCH
// "<KeyPrefix>:*" + batched DEL. Never FLUSHDB; never another app's prefix.
func (c *DefaultCleaner) CleanupCache(ctx context.Context, t CacheTarget) error {
	logger := logf.FromContext(ctx)

	if t.Provider != "redis" {
		logger.Info("Cache provider is not redis; skipping cache cleanup (no-op)", "provider", t.Provider)
		return nil
	}
	if t.KeyPrefix == "" {
		return fmt.Errorf("refusing cache cleanup with empty keyPrefix (cross-app safety)")
	}

	opt, err := redis.ParseURL(t.URL)
	if err != nil {
		return fmt.Errorf("parse redis url: %w", err)
	}
	rdb := redis.NewClient(opt)
	defer func() { _ = rdb.Close() }()

	match := t.KeyPrefix + ":*" // SCOPE: only this app's keyspace.
	var cursor uint64
	var deleted int
	for {
		keys, next, serr := rdb.Scan(ctx, cursor, match, redisScanBatch).Result()
		if serr != nil {
			return fmt.Errorf("scan %q: %w", match, serr)
		}
		if len(keys) > 0 {
			if derr := rdb.Del(ctx, keys...).Err(); derr != nil {
				return fmt.Errorf("del keys under %q: %w", match, derr)
			}
			deleted += len(keys)
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}

	logger.Info("Deleted Redis keys", "match", match, "count", deleted)
	return nil
}
