import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

/**
 * e2e: necesita Postgres y Redis reales (variables POSTGRES_* y REDIS_*).
 * Se corre con `npm run test:e2e` en un servidor, no en el PC.
 */
describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/health responde sin token', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect(res => expect(res.body.status).toBe('ok'));
  });

  it('GET /api/session exige token (401)', () => {
    return request(app.getHttpServer())
      .get('/api/session')
      .expect(401);
  });

  it('POST /api/whatsapp/send exige token (401)', () => {
    return request(app.getHttpServer())
      .post('/api/whatsapp/send')
      .send({ sessionId: 'x', number: '593999999999', message: 'hola' })
      .expect(401);
  });

  it('POST /api/user (alta) exige token (401)', () => {
    return request(app.getHttpServer())
      .post('/api/user')
      .send({ email: 'x@y.z', password: 'Clave.Fuerte1', usuario: 'nuevo', rol: 'SUPER_ADMIN' })
      .expect(401);
  });
});
