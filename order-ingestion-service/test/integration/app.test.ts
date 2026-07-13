import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { buildApp } from './setup/app.setup';

describe('App (integration)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1', () => {
    it('should return the welcome message in the standard envelope', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1').expect(200);

      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('data', null);
    });
  });

  describe('GET / (unversioned, unprefixed)', () => {
    it('should not resolve — the route only exists under /api/v1', async () => {
      await request(app.getHttpServer()).get('/').expect(404);
    });
  });

  describe('GET /health/liveness', () => {
    it('should report ok without the /api prefix or a version', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/liveness')
        .expect(200);

      expect(res.body).toHaveProperty('status', 'ok');
    });
  });

  describe('GET /health/readiness', () => {
    it('should report ok without the /api prefix or a version', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/readiness')
        .expect(200);

      expect(res.body).toHaveProperty('status', 'ok');
    });
  });
});
