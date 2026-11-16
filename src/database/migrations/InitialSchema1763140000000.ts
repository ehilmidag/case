import { MigrationInterface, QueryRunner } from 'typeorm';
import { ensureEntryPartitions } from './entry-partitions';

export class InitialSchema1763140000000 implements MigrationInterface {
  name = 'InitialSchema1763140000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await queryRunner.query('CREATE SEQUENCE area_set_version_seq');

    await queryRunner.query(`
      CREATE TABLE areas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
        geom geometry(Polygon, 4326) NOT NULL CHECK (ST_IsValid(geom)),
        is_active boolean NOT NULL DEFAULT true,
        version bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX areas_geom_gix ON areas USING GIST (geom)');
    await queryRunner.query(
      'CREATE INDEX areas_created_id_idx ON areas (created_at DESC, id DESC)',
    );

    // `id` uses GENERATED ALWAYS AS IDENTITY, which gives each partition of this table its
    // own sequence (a PostgreSQL limitation). `id` is therefore unique per partition, not
    // globally. This is safe: `entered_at` is the partition key, so ties on `id` can only
    // happen between rows that already share a partition, and the (entered_at, id) keyset
    // pagination in GET /logs always sorts by entered_at first.
    await queryRunner.query(`
      CREATE TABLE area_entries (
        id bigint GENERATED ALWAYS AS IDENTITY,
        user_id text NOT NULL,
        area_id uuid NOT NULL,
        entered_at timestamptz NOT NULL,
        exited_at timestamptz,
        exit_reason text CHECK (exit_reason IN ('left', 'timeout', 'area_deleted')),
        area_set_version bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id, entered_at),
        CONSTRAINT area_entries_user_area_entered_at_key UNIQUE (user_id, area_id, entered_at)
      ) PARTITION BY RANGE (entered_at)
    `);
    await queryRunner.query(
      'CREATE INDEX area_entries_user_entered_at_id_idx ON area_entries (user_id, entered_at DESC, id DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX area_entries_area_entered_at_id_idx ON area_entries (area_id, entered_at DESC, id DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX area_entries_entered_at_id_idx ON area_entries (entered_at DESC, id DESC)',
    );
    await queryRunner.query('CREATE TABLE area_entries_default PARTITION OF area_entries DEFAULT');
    await ensureEntryPartitions(queryRunner);

    await queryRunner.query(`
      CREATE TABLE user_area_state (
        user_id text NOT NULL,
        area_id uuid NOT NULL REFERENCES areas(id),
        entered_at timestamptz NOT NULL,
        last_inside_at timestamptz NOT NULL,
        outside_count integer NOT NULL DEFAULT 0,
        first_outside_at timestamptz,
        PRIMARY KEY (user_id, area_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX user_area_state_last_inside_at_idx ON user_area_state (last_inside_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS user_area_state');
    await queryRunner.query('DROP TABLE IF EXISTS area_entries');
    await queryRunner.query('DROP TABLE IF EXISTS areas');
    await queryRunner.query('DROP SEQUENCE IF EXISTS area_set_version_seq');
  }
}
