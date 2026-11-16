import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { IngestBackpressureException } from './backpressure-monitor.service';

@Catch(IngestBackpressureException)
export class IngestBackpressureFilter implements ExceptionFilter<IngestBackpressureException> {
  catch(exception: IngestBackpressureException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
