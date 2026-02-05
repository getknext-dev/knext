import { GRPC as Cerbos } from '@cerbos/grpc';
import * as Minio from 'minio';
import { Pool } from 'pg';

// Singleton instances
let cerbosClient: Cerbos | null = null;
let minioClient: Minio.Client | null = null;
let pgPool: Pool | null = null;

export const getCerbosClient = () => {
  if (!cerbosClient) {
    const target = process.env.CERBOS_URL || 'cerbos.default.svc.cluster.local:3593';
    cerbosClient = new Cerbos(target, { tls: false });
  }
  return cerbosClient;
};

export const getMinioClient = () => {
  if (!minioClient) {
    minioClient = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'minio.default.svc.cluster.local',
      port: Number.parseInt(process.env.MINIO_PORT || '9000'),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minio',
      secretKey: process.env.MINIO_SECRET_KEY || 'minio123',
    });
  }
  return minioClient;
};

export const getDbPool = () => {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return pgPool;
};
