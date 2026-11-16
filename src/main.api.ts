import { createServer } from 'node:http';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppApiModule } from './app-api.module';
import { MetricsService } from './metrics/metrics.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppApiModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  // Trust exactly one upstream hop (the load balancer/reverse proxy in front of the API)
  // so req.ip reflects the real client address instead of the proxy's — IP-based rate
  // limiting would otherwise throttle all traffic as a single client.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Location Tracking Service API')
    .setVersion('1.0')
    .addTag('areas')
    .addTag('locations')
    .addTag('logs')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const configService = app.get(ConfigService);
  const port = configService.getOrThrow<number>('API_PORT');
  await app.listen(port, '0.0.0.0');

  // /metrics is served on its own port, deliberately separate from client-facing API
  // traffic on API_PORT, so a scraper never shares a listener (or its rate limits) with
  // real requests. A plain http server is enough: this is the only route it serves.
  const metricsService = app.get(MetricsService);
  const metricsPort = configService.getOrThrow<number>('METRICS_PORT');
  const metricsServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      void metricsService.exposition().then((body) => {
        response.setHeader('Content-Type', metricsService.contentType);
        response.setHeader('Cache-Control', 'no-store');
        response.end(body);
      });
      return;
    }

    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => metricsServer.listen(metricsPort, '0.0.0.0', resolve));
}

void bootstrap();
