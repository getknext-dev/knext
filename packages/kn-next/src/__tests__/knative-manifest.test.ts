import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnativeNextConfig } from '../config';
import {
  generateKafkaEventingManifest,
  generateKnativeManifest,
} from '../generators/knative-manifest';

describe('Knative Manifest Generator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kn-next-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should generate knative-service.yaml with correct metadata', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
      },
      registry: 'gcr.io/test-project',
    };

    const outputPath = generateKnativeManifest({
      config,
      outputDir: tempDir,
      imageTag: 'v1.0.0',
    });

    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('name: my-app');
    expect(content).toContain('gcr.io/test-project/my-app:v1.0.0');
    expect(content).toContain('serving.knative.dev/v1');
  });

  it('should include environment variables for adapters', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
      },
      cache: {
        provider: 'redis',
        url: 'redis://redis:6379',
      },
      registry: 'gcr.io/test-project',
    };

    const outputPath = generateKnativeManifest({
      config,
      outputDir: tempDir,
    });

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('GCS_BUCKET_NAME');
    expect(content).toContain('REDIS_URL');
  });

  it('should include Kafka env vars when enabled', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
      },
      registry: 'gcr.io/test-project',
    };

    const outputPath = generateKnativeManifest({
      config,
      outputDir: tempDir,
      enableKafkaQueue: true,
    });

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('KAFKA_BROKER_URL');
    expect(content).toContain('KAFKA_REVALIDATION_TOPIC');
  });

  it('should set correct container resources', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
      },
      registry: 'gcr.io/test-project',
    };

    const outputPath = generateKnativeManifest({
      config,
      outputDir: tempDir,
    });

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('containerPort: 3000');
    expect(content).toContain('memory: "256Mi"');
    expect(content).toContain('cpu: "100m"');
  });
});

describe('Kafka Eventing Manifest Generator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kn-next-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should generate KafkaSource with correct topic', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
      },
      registry: 'gcr.io/test-project',
    };

    const outputPath = generateKafkaEventingManifest({
      config,
      outputDir: tempDir,
      kafkaBroker: 'kafka:9092',
    });

    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('KafkaSource');
    expect(content).toContain('my-app-revalidation');
    expect(content).toContain('kafka:9092');
  });
});
