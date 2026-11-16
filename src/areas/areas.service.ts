import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, EntityManager } from 'typeorm';
import { Area, GeoJsonPolygon } from '../database/entities/area.entity';
import { RedisConnection } from '../redis/redis.module';
import { CreateAreaDto } from './dto/create-area.dto';
import { ListAreasQueryDto } from './dto/list-areas-query.dto';

export type AreaFeature = {
  type: 'Feature';
  id: string;
  geometry: GeoJsonPolygon;
  properties: {
    name: string;
    createdAt: string;
    version: number;
  };
};

export type AreaFeatureCollection = {
  type: 'FeatureCollection';
  features: AreaFeature[];
  nextCursor: string | null;
};

type AreaRow = {
  id: string;
  name: string;
  geometry: GeoJsonPolygon;
  createdAt: Date;
  cursorCreatedAt?: string;
  version: string;
};

type Cursor = {
  createdAt: string;
  id: string;
};

type Bbox = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

type ListResult = {
  collection: AreaFeatureCollection | null;
  etag: string;
  notModified: boolean;
};

const VERSION_KEY = 'area_set_version';
const CHANGE_CHANNEL = 'areas.changed';
const CACHE_TTL_SECONDS = 60;

// Advances area_set_version only if the new value is greater than what's stored, then
// publishes unconditionally. A plain SET would let a transaction with a lower version
// (nextval() is assigned before commit, so commit order can differ from version order)
// overwrite a higher one that committed first. Any reload a worker skips because of a
// stale/out-of-order publish is still caught by the periodic AREA_INDEX_REFRESH_MS poll.
const ADVANCE_VERSION_SCRIPT = `
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  if tonumber(ARGV[1]) > current then
    redis.call('SET', KEYS[1], ARGV[1])
  end
  redis.call('PUBLISH', KEYS[2], ARGV[1])
  return 1
`;

@Injectable()
export class AreasService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisConnection,
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AreasService.name);
  }

  async create(dto: CreateAreaDto): Promise<AreaFeature> {
    const vertexCount = dto.geometry.coordinates.reduce((total, ring) => total + ring.length, 0);
    const maxVertices = this.configService.getOrThrow<number>('MAX_POLYGON_VERTICES');
    if (vertexCount > maxVertices) {
      throw new BadRequestException(`geometry exceeds MAX_POLYGON_VERTICES (${maxVertices})`);
    }

    const feature = await this.dataSource.transaction(async (manager) => {
      const validity = await this.getGeometryValidity(manager, dto.geometry);
      if (!validity.valid) {
        throw new UnprocessableEntityException({
          message: 'Invalid polygon',
          reason: validity.reason,
        });
      }

      const [{ version }] = (await manager.query(
        "SELECT nextval('area_set_version_seq')::text AS version",
      )) as Array<{ version: string }>;

      const [row] = (await manager.query(
        `INSERT INTO areas (name, geom, version)
         VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3)
         RETURNING id, name, ST_AsGeoJSON(geom)::json AS geometry,
                   created_at AS "createdAt", version::text AS version`,
        [dto.name, JSON.stringify(dto.geometry), version],
      )) as AreaRow[];

      return this.toFeature(row);
    });

    try {
      await this.redis.client.eval(
        ADVANCE_VERSION_SCRIPT,
        2,
        VERSION_KEY,
        CHANGE_CHANNEL,
        String(feature.properties.version),
      );
    } catch (error) {
      this.logger.warn(`Redis area version update failed: ${String(error)}`);
    }

    return feature;
  }

  async list(query: ListAreasQueryDto, ifNoneMatch?: string): Promise<ListResult> {
    const bbox = query.bbox === undefined ? undefined : this.parseBbox(query.bbox);
    const cursor = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);
    const queryHash = createHash('sha256')
      .update(JSON.stringify({ limit: query.limit, bbox: bbox ?? null, cursor: cursor ?? null }))
      .digest('hex');
    const version = await this.currentVersion();
    const etag = `"${createHash('sha256').update(`${version}:${queryHash}`).digest('base64url')}"`;

    if (this.matchesEtag(ifNoneMatch, etag)) {
      return { collection: null, etag, notModified: true };
    }

    const cacheKey = `areas:list:${version}:${queryHash}`;
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached !== null) {
        return {
          collection: JSON.parse(cached) as AreaFeatureCollection,
          etag,
          notModified: false,
        };
      }
    } catch (error) {
      this.logger.warn(`Redis area list cache read failed: ${String(error)}`);
    }

    const collection = await this.queryAreas(query.limit, cursor, bbox);
    try {
      await this.redis.client.set(cacheKey, JSON.stringify(collection), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Redis area list cache write failed: ${String(error)}`);
    }

    return { collection, etag, notModified: false };
  }

  private async getGeometryValidity(
    manager: EntityManager,
    geometry: GeoJsonPolygon,
  ): Promise<{ valid: boolean; reason: string }> {
    const [result] = (await manager.query(
      `SELECT ST_IsValid(geom) AS valid, ST_IsValidReason(geom) AS reason
       FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom) input`,
      [JSON.stringify(geometry)],
    )) as Array<{ valid: boolean; reason: string }>;

    return result;
  }

  private async currentVersion(): Promise<string> {
    const [result] = (await this.dataSource.query(
      'SELECT COALESCE(MAX(version), 0)::text AS version FROM areas',
    )) as Array<{ version: string }>;
    try {
      const cachedVersion = await this.redis.client.get(VERSION_KEY);
      if (cachedVersion !== result.version) {
        await this.redis.client.set(VERSION_KEY, result.version);
      }
    } catch (error) {
      this.logger.warn(`Redis area version synchronization failed: ${String(error)}`);
    }

    return result.version;
  }

  private async queryAreas(
    limit: number,
    cursor: Cursor | undefined,
    bbox: Bbox | undefined,
  ): Promise<AreaFeatureCollection> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      const builder = queryRunner.manager
        .getRepository(Area)
        .createQueryBuilder('area')
        .select('area.id', 'id')
        .addSelect('area.name', 'name')
        .addSelect('ST_AsGeoJSON(area.geom)::json', 'geometry')
        .addSelect('area.createdAt', 'createdAt')
        .addSelect(
          `to_char(area.createdAt AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          'cursorCreatedAt',
        )
        .addSelect('area.version', 'version')
        .orderBy('area.createdAt', 'DESC')
        .addOrderBy('area.id', 'DESC')
        .take(limit + 1);

      if (cursor) {
        builder.andWhere('(area.createdAt, area.id) < (:cursorCreatedAt, :cursorId)', {
          cursorCreatedAt: cursor.createdAt,
          cursorId: cursor.id,
        });
      }

      if (bbox) {
        builder.andWhere(
          'area.geom && ST_MakeEnvelope(:minLng, :minLat, :maxLng, :maxLat, 4326)',
          bbox,
        );
      }

      const rows = (await builder.getRawMany()) as AreaRow[];
      const hasMore = rows.length > limit;
      const visibleRows = rows.slice(0, limit);
      const features = visibleRows.map((row) => this.toFeature(row));
      const lastRow = visibleRows.at(-1);

      return {
        type: 'FeatureCollection',
        features,
        nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow) : null,
      };
    } finally {
      await queryRunner.release();
    }
  }

  private toFeature(row: AreaRow): AreaFeature {
    return {
      type: 'Feature',
      id: row.id,
      geometry: row.geometry,
      properties: {
        name: row.name,
        createdAt: new Date(row.createdAt).toISOString(),
        version: Number(row.version),
      },
    };
  }

  private parseBbox(value: string): Bbox {
    const parts = value.split(',');
    const values = parts.map(Number);
    if (
      values.length !== 4 ||
      parts.some((part) => part.trim() === '') ||
      values.some((coordinate) => !Number.isFinite(coordinate)) ||
      values[0] < -180 ||
      values[0] > 180 ||
      values[2] < -180 ||
      values[2] > 180 ||
      values[1] < -90 ||
      values[1] > 90 ||
      values[3] < -90 ||
      values[3] > 90 ||
      values[0] >= values[2] ||
      values[1] >= values[3]
    ) {
      throw new BadRequestException(
        'bbox must be minLng,minLat,maxLng,maxLat within coordinate ranges',
      );
    }

    return {
      minLng: values[0],
      minLat: values[1],
      maxLng: values[2],
      maxLat: values[3],
    };
  }

  private decodeCursor(value: string): Cursor {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (typeof decoded !== 'object' || decoded === null) {
        throw new Error('Invalid cursor payload');
      }

      const cursor = decoded as Record<string, unknown>;
      if (
        typeof cursor.createdAt !== 'string' ||
        Number.isNaN(Date.parse(cursor.createdAt)) ||
        typeof cursor.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
      ) {
        throw new Error('Invalid cursor payload');
      }

      return { createdAt: cursor.createdAt, id: cursor.id };
    } catch {
      throw new BadRequestException('cursor must be a valid opaque area cursor');
    }
  }

  private encodeCursor(row: AreaRow): string {
    const cursor: Cursor = {
      createdAt: row.cursorCreatedAt ?? new Date(row.createdAt).toISOString(),
      id: row.id,
    };
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private matchesEtag(header: string | undefined, etag: string): boolean {
    return (
      header?.split(',').some((value) => value.trim() === '*' || value.trim() === etag) ?? false
    );
  }
}
