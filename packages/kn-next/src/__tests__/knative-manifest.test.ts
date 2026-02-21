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
        publicUrl: 'https://storage.googleapis.com/test-bucket',
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
        publicUrl: 'https://storage.googleapis.com/test-bucket',
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
        publicUrl: 'https://storage.googleapis.com/test-bucket',
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
        publicUrl: 'https://storage.googleapis.com/test-bucket',
      },
      registry: 'gcr.io/test-project',
    };

    const outputPath = generateKnativeManifest({
      config,
      outputDir: tempDir,
    });

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('containerPort: 3000');
    expect(content).toContain('memory: "512Mi"');
    expect(content).toContain('cpu: "250m"');
    expect(content).toContain('memory: "1Gi"');
    expect(content).toContain('cpu: "1000m"');
  });

  // Bytecode cache tests
  describe('bytecode caching', () => {
    it('should NOT include bytecode cache resources when disabled', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
      };

      const outputPath = generateKnativeManifest({
        config,
        outputDir: tempDir,
      });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).not.toContain('NODE_COMPILE_CACHE');
      expect(content).not.toContain('bytecode-cache');
      expect(content).not.toContain('PersistentVolumeClaim');
      expect(content).not.toContain('volumeMounts');
    });

    it('should NOT include bytecode cache when bytecodeCache is undefined', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
        bytecodeCache: undefined,
      };

      const outputPath = generateKnativeManifest({
        config,
        outputDir: tempDir,
      });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).not.toContain('NODE_COMPILE_CACHE');
      expect(content).not.toContain('PersistentVolumeClaim');
    });

    it('should include NODE_COMPILE_CACHE env var when enabled', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
        bytecodeCache: { enabled: true },
      };

      const outputPath = generateKnativeManifest({
        config,
        outputDir: tempDir,
        imageTag: 'v2.0.0',
      });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('NODE_COMPILE_CACHE');
      expect(content).toContain('/cache/bytecode/v2.0.0');
    });

    it('should include PVC manifest when bytecode cache is enabled', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
        bytecodeCache: { enabled: true },
      };

      const outputPath = generateKnativeManifest({
        config,
        outputDir: tempDir,
        namespace: 'production',
      });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('PersistentVolumeClaim');
      expect(content).toContain('my-app-bytecode-cache');
      expect(content).toContain('ReadWriteOnce');
      expect(content).toContain('namespace: production');
      expect(content).toContain('storage: 512Mi'); // default size
    });

    it('should use custom storage size for PVC', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
        bytecodeCache: { enabled: true, storageSize: '1Gi' },
      };

      const outputPath = generateKnativeManifest({
        config,
        outputDir: tempDir,
      });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('storage: 1Gi');
    });

    it('should include volume mount on the container', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
        bytecodeCache: { enabled: true },
      };

      const outputPath = generateKnativeManifest({
        config,
        outputDir: tempDir,
      });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('volumeMounts');
      expect(content).toContain('mountPath: /cache/bytecode');
      expect(content).toContain('persistentVolumeClaim');
      expect(content).toContain('claimName: my-app-bytecode-cache');
    });

    it('should key cache path by imageTag', () => {
      const config: KnativeNextConfig = {
        name: 'my-app',
        storage: {
          provider: 'gcs',
          bucket: 'test-bucket',
          publicUrl: 'https://storage.googleapis.com/test-bucket',
        },
        registry: 'gcr.io/test-project',
        bytecodeCache: { enabled: true },
      };

      // Different image tags should produce different cache paths
      const path1 = generateKnativeManifest({
        config,
        outputDir: tempDir,
        imageTag: 'abc123',
      });
      const content1 = readFileSync(path1, 'utf-8');
      expect(content1).toContain('/cache/bytecode/abc123');

      const path2 = generateKnativeManifest({
        config,
        outputDir: tempDir,
        imageTag: 'def456',
      });
      const content2 = readFileSync(path2, 'utf-8');
      expect(content2).toContain('/cache/bytecode/def456');
    });
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
        publicUrl: 'https://storage.googleapis.com/test-bucket',
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

describe('Observability', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kn-next-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include Prometheus annotations when observability is enabled', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
        publicUrl: 'https://storage.googleapis.com/test-bucket',
      },
      registry: 'gcr.io/test-project',
      observability: { enabled: true },
    };

    generateKnativeManifest({ config, outputDir: tempDir });
    const content = readFileSync(join(tempDir, 'knative-service.yaml'), 'utf-8');

    expect(content).toContain('prometheus.io/scrape: "true"');
    expect(content).toContain('prometheus.io/port: "3000"');
    expect(content).toContain('prometheus.io/path: "/api/metrics"');
  });

  it('should NOT include Prometheus annotations when observability is disabled', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
        publicUrl: 'https://storage.googleapis.com/test-bucket',
      },
      registry: 'gcr.io/test-project',
      observability: { enabled: false },
    };

    generateKnativeManifest({ config, outputDir: tempDir });
    const content = readFileSync(join(tempDir, 'knative-service.yaml'), 'utf-8');

    expect(content).not.toContain('prometheus.io/scrape');
  });

  it('should inject KN_APP_NAME env var when observability is enabled', () => {
    const config: KnativeNextConfig = {
      name: 'my-app',
      storage: {
        provider: 'gcs',
        bucket: 'test-bucket',
        publicUrl: 'https://storage.googleapis.com/test-bucket',
      },
      registry: 'gcr.io/test-project',
      observability: { enabled: true },
    };

    generateKnativeManifest({ config, outputDir: tempDir });
    const content = readFileSync(join(tempDir, 'knative-service.yaml'), 'utf-8');

    expect(content).toContain('KN_APP_NAME');
    expect(content).toContain('my-app');
  });

  it('should generate ServiceMonitor and Grafana dashboard ConfigMap', async () => {
    const { generateObservabilityManifest } = await import('../generators/infrastructure');

    const manifest = generateObservabilityManifest('my-app', {
      enabled: true,
      prometheus: { scrapeInterval: '30s' },
    });

    // ServiceMonitor
    expect(manifest).toContain('kind: ServiceMonitor');
    expect(manifest).toContain('name: my-app-metrics');
    expect(manifest).toContain('interval: 30s');
    expect(manifest).toContain('path: /metrics');
    expect(manifest).toContain('serving.knative.dev/service: my-app');

    // Grafana ConfigMap
    expect(manifest).toContain('kind: ConfigMap');
    expect(manifest).toContain('grafana_dashboard: "1"');
    expect(manifest).toContain('my-app-grafana-dashboard');
    expect(manifest).toContain('kn_next_startup_duration_seconds');
  });

  it('should skip Grafana ConfigMap when grafana.enabled is false', async () => {
    const { generateObservabilityManifest } = await import('../generators/infrastructure');

    const manifest = generateObservabilityManifest('my-app', {
      enabled: true,
      grafana: { enabled: false },
    });

    expect(manifest).toContain('kind: ServiceMonitor');
    expect(manifest).not.toContain('kind: ConfigMap');
    expect(manifest).not.toContain('grafana_dashboard');
  });
});
