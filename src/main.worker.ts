import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppWorkerModule } from './app-worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppWorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const port = app.get(ConfigService).getOrThrow<number>('METRICS_PORT');
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
