import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get('NODE_ENV') === 'development' ? 'debug' : 'info',
          genReqId: (_request, response) => {
            const requestId = randomUUID();
            response.setHeader('X-Request-Id', requestId);
            return requestId;
          },
          redact: {
            paths: ['req.headers.authorization'],
            remove: true,
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggingModule {}
