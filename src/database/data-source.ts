import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/configuration';
import { createDatabaseOptions } from './database-options';

export const AppDataSource = new DataSource(
  createDatabaseOptions(validateEnvironment(process.env)),
);
