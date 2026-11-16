export const DLQ_STREAM_KEY = 'locations:dlq';

export type StreamMessage = [id: string, fields: string[]];

export function buildDlqFields(
  sourceStream: string,
  sourceId: string,
  error: unknown,
  originalFields: string[],
): string[] {
  return [
    'sourceStream',
    sourceStream,
    'sourceId',
    sourceId,
    'error',
    error instanceof Error ? error.message : String(error),
    ...originalFields,
  ];
}
